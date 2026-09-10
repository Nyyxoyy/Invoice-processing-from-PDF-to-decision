"""Structured rule fixtures from plan v2.2 — no PDFs required."""
from decimal import Decimal

import pytest

from app.policy import Policy, DEFAULT_POLICY
from app.rules import Code, ResolverInput, Route, budget_check, resolve

P = DEFAULT_POLICY  # 2% / $50 greater_of, exception band 5% enabled

def clean_gates(budget):
    return ResolverInput(
        vendor_resolved=True, vendor_blocked=False, po_confirmed=True,
        required_fields_ok=True, arithmetic_ok=True, budget=budget,
    )

def route_for(base, consumed, invoice, policy=P):
    b = budget_check(base, consumed, invoice, policy)
    return resolve(clean_gates(b), policy).route


# --- headline arithmetic (verified table in plan) ---

def test_10450_on_10k_is_exception():
    assert route_for(1_000_000, 0, 1_045_000) == Route.APPROVE_WITH_EXCEPTION

def test_10600_on_10k_holds_at_5pct_band():
    assert route_for(1_000_000, 0, 1_060_000) == Route.HOLD_REVIEW

def test_10600_on_10k_exception_at_7pct_band():
    p7 = Policy(version=2, variance_mode="greater_of", variance_pct=Decimal("2.0"),
                exception_enabled=True, exception_pct=Decimal("7.0"))
    assert route_for(1_000_000, 0, 1_060_000, p7) == Route.APPROVE_WITH_EXCEPTION

def test_split_po_12_12_8_on_30k():
    B = 3_000_000
    assert route_for(B, 0, 1_200_000) == Route.AUTO_APPROVE
    assert route_for(B, 1_200_000, 1_200_000) == Route.AUTO_APPROVE
    d = resolve(clean_gates(budget_check(B, 2_400_000, 800_000, P)), P)
    assert d.route == Route.HOLD_REVIEW
    assert Code.PO_BUDGET_EXCEEDED in d.codes
    assert d.budget.overage_minor == 200_000  # $2,000 > $1,500 exception limit
    assert d.budget.t_exception_minor == 150_000


# --- partial billing is never a variance failure ---

def test_partial_invoice_is_not_failed_match():
    assert route_for(3_000_000, 0, 1_200_000) == Route.AUTO_APPROVE  # $12k on $30k


# --- boundary at/±1 minor unit of T_primary and T_exception ---

def test_boundaries_10k_po():
    B = 1_000_000  # T_primary=$200(=20000), T_exception=$500(=50000)
    assert route_for(B, 0, B + 20_000) == Route.AUTO_APPROVE           # D == T_primary
    assert route_for(B, 0, B + 20_001) == Route.APPROVE_WITH_EXCEPTION # D == T_primary+1c
    assert route_for(B, 0, B + 50_000) == Route.APPROVE_WITH_EXCEPTION # D == T_exception
    assert route_for(B, 0, B + 50_001) == Route.HOLD_REVIEW            # D == T_exception+1c


# --- exception flag off: everything above primary holds ---

def test_exception_disabled_switch():
    p_off = Policy(version=3, variance_mode="greater_of", variance_pct=Decimal("2.0"),
                   exception_enabled=False, exception_pct=Decimal("5.0"))
    assert route_for(1_000_000, 0, 1_045_000, p_off) == Route.HOLD_REVIEW


# --- de minimis collapse: B <= $1,000 => T_primary == T_exception == $50 ---

def test_de_minimis_collapse_documented():
    B = 10_000  # $100 PO
    b = budget_check(B, 0, 15_000, P)  # $150 invoice, D=$50
    assert b.t_primary_minor == b.t_exception_minor == 5_000
    assert resolve(clean_gates(b), P).route == Route.AUTO_APPROVE  # accepted consequence


# --- allowance applies once to cumulative consumption ---

def test_splits_do_not_each_get_allowance():
    B = 10_000  # $100 PO, allowance $50 total
    assert route_for(B, 0, 14_000) == Route.AUTO_APPROVE       # cum $140, D=$40
    assert route_for(B, 14_000, 4_000) == Route.HOLD_REVIEW    # cum $180, D=$80 > $50


# --- gates: exception can never waive a non-variance failure ---

def test_exception_cannot_waive_other_gates():
    b = budget_check(1_000_000, 0, 1_045_000, P)  # exception-band overage
    g = clean_gates(b)
    g.currency_mismatch = True
    d = resolve(g, P)
    assert d.route == Route.HOLD_REVIEW
    assert Code.CURRENCY_MISMATCH in d.codes

def test_missing_prerequisite_never_silently_passes():
    g = ResolverInput(vendor_resolved=True, vendor_blocked=False, po_confirmed=True,
                      required_fields_ok=True, arithmetic_ok=None, budget=None)
    assert resolve(g, P).route == Route.HOLD_REVIEW

def test_blocked_vendor_requires_resolution():
    g = clean_gates(budget_check(1_000_000, 0, 500_000, P))
    g.vendor_resolved = None
    g.vendor_blocked = True  # unreliable read must NOT reject
    d = resolve(g, P)
    assert d.route == Route.HOLD_REVIEW
    assert Code.VENDOR_UNKNOWN in d.codes

def test_scan_gate_holds():
    g = clean_gates(budget_check(1_000_000, 0, 500_000, P))
    g.scan_gate = True
    d = resolve(g, P)
    assert d.route == Route.HOLD_REVIEW
    assert Code.REVIEW_REQUIRED_SCAN in d.codes

def test_po_closed_and_vendor_mismatch_hold_not_reject():
    g = clean_gates(budget_check(1_000_000, 0, 500_000, P))
    g.po_closed = True
    assert resolve(g, P).route == Route.HOLD_REVIEW
    g2 = clean_gates(budget_check(1_000_000, 0, 500_000, P))
    g2.po_vendor_mismatch = True
    assert resolve(g2, P).route == Route.HOLD_REVIEW
