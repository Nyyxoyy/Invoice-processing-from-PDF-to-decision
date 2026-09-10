"""Currency-aware money: precision by registry, separator conventions,
per-currency floors, EUR end-to-end."""
from decimal import Decimal

import pytest

import app.pipeline as pipeline
from app.currencies import minor_units
from app.db import connect
from app.ledger import consumed_minor
from app.main import seed_if_empty
from app.normalize import extract_amount, quantize_minor, _parse_number
from app.policy import DEFAULT_POLICY, Policy
from app.rules import Code, Route, budget_check
from tests.test_pipeline import make_pdf, stub_extract


def test_minor_units_registry():
    assert minor_units("USD") == 2
    assert minor_units("JPY") == 0
    assert minor_units("BHD") == 3


def test_quantize_by_currency():
    assert quantize_minor(Decimal("6495.00"), "USD") == 649500
    assert quantize_minor(Decimal("6495"), "JPY") == 6495
    assert quantize_minor(Decimal("6.495"), "BHD") == 6495

def test_quantize_surfaces_precision_error():
    # finer than the currency allows: surfaced (None), never silently rounded
    assert quantize_minor(Decimal("10.005"), "USD") is None
    assert quantize_minor(Decimal("10.5"), "JPY") is None

def test_separator_conventions():
    assert _parse_number("1,234.56") == Decimal("1234.56")
    assert _parse_number("1.234,56") == Decimal("1234.56")
    assert _parse_number("2553,91") == Decimal("2553.91")
    assert _parse_number("1,23,456.78") == Decimal("123456.78")  # Indian grouping
    assert _parse_number("1.234") is None   # grouping or decimal: ambiguous
    assert _parse_number("1,234") is None

def test_extract_amount_prefers_marked_candidate():
    assert extract_amount("Total: EUR 2.809,30") == Decimal("2809.30")
    assert extract_amount("Sales Tax (8.25%): $495.00") == Decimal("495.00")


def test_floor_only_configured_currency():
    p = DEFAULT_POLICY
    # USD: $50 floor active on small PO
    assert budget_check(10_000, 0, 15_000, p, "USD").t_primary_minor == 5_000
    # EUR unconfigured: percentage-only (2% of 100.00 EUR = 2.00)
    assert budget_check(10_000, 0, 15_000, p, "EUR").t_primary_minor == 200

def test_explicit_non_usd_floor():
    p = Policy(version=9, variance_mode="greater_of", variance_pct=Decimal("2.0"),
               exception_enabled=True, exception_pct=Decimal("5.0"),
               abs_floor_minor={"USD": 5000, "EUR": 4000})
    assert budget_check(10_000, 0, 15_000, p, "EUR").t_primary_minor == 4000

def test_pct_allowance_floors_not_rounds_up():
    # 2% of 100.49 = 2.0098 -> floor to 200 minor units, never 201
    p = Policy(version=10, variance_mode="greater_of", variance_pct=Decimal("2.0"),
               exception_enabled=True, exception_pct=Decimal("5.0"), abs_floor_minor={})
    assert budget_check(10_049, 0, 10_049, p, "EUR").t_primary_minor == 200


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, "extract_native", stub_extract)
    conn = connect(str(tmp_path / "app.db"))
    seed_if_empty(conn)
    yield conn, str(tmp_path)
    conn.close()


def eur_pdf(path):
    import fitz
    doc = fitz.open(); page = doc.new_page(); y = 60
    for row in ["Zencorporations", "Invoice No: ZC-100", "Invoice Date: 2026-08-20",
                "PO Reference: PO-2001", "Bill To: La Galerie", "Currency: EUR",
                "Subtotal: 1000.00", "Sales Tax: 190.00", "Total: 1190.00"]:
        page.insert_text((50, y), row, fontsize=11); y += 22
    doc.save(str(path))


def test_eur_invoice_approves_against_eur_po(env):
    conn, data_dir = env
    path = f"{data_dir}/eur.pdf"; eur_pdf(path)
    r = pipeline.process_document(conn, path, "eur.pdf", DEFAULT_POLICY, data_dir)
    assert r.decision.route == Route.AUTO_APPROVE and r.posted
    assert consumed_minor(conn, "PO-2001") == 119_000
    assert r.decision.budget.currency == "EUR"


def test_currency_mismatch_holds(env):
    conn, data_dir = env
    path = f"{data_dir}/mismatch.pdf"
    # USD invoice explicitly referencing the EUR PO
    make_pdf(path, po="PO-2001", invoice_no="NW-XC-1", supplier="Northwind Supplies LLC")
    r = pipeline.process_document(conn, path, "mismatch.pdf", DEFAULT_POLICY, data_dir)
    assert r.decision.route == Route.HOLD_REVIEW
    assert Code.CURRENCY_MISMATCH in r.decision.codes or Code.PO_VENDOR_MISMATCH in r.decision.codes
    assert consumed_minor(conn, "PO-2001") == 0


def test_missing_currency_never_posts(env):
    conn, data_dir = env
    import fitz
    path = f"{data_dir}/nocur.pdf"
    doc = fitz.open(); page = doc.new_page(); y = 60
    for row in ["Northwind Supplies LLC", "Invoice No: NW-NC-1", "Invoice Date: 2026-08-28",
                "PO Reference: PO-1001", "Bill To: Acme Corporation",
                "Subtotal: 6000.00", "Sales Tax: 495.00", "Total: 6495.00"]:
        page.insert_text((50, y), row, fontsize=11); y += 22
    doc.save(path)
    r = pipeline.process_document(conn, path, "nocur.pdf", DEFAULT_POLICY, data_dir)
    assert r.decision.route == Route.HOLD_REVIEW
    assert Code.AMBIGUOUS_CURRENCY in r.decision.codes
    assert consumed_minor(conn, "PO-1001") == 0
