"""Identity resolution and atomic posting.

The commit transaction (BEGIN IMMEDIATE) does, in order:
  1. resolve-or-create the logical invoice on its business key
  2. recheck duplicate eligibility against fresh state
  3. re-read fresh PO consumption and re-run the budget rule
  4. insert the posting (uniqueness constraints enforce single effect)
  5. write decision + terminal run_status + audit events
All-or-nothing: a crash after posting cannot leave the run mislabeled.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass

from .policy import Policy
from .rules import BudgetResult, Code, Decision, ResolverInput, Route, budget_check, explain, resolve


def canonical_invoice_no(raw: str) -> str:
    """Cautious normalization: case + whitespace only. Leading zeros and
    punctuation are PRESERVED — 00123 != 123 without a vendor-specific rule."""
    return " ".join(raw.split()).upper()


def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def consumed_minor(conn: sqlite3.Connection, po_id: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(CASE kind WHEN 'reversal' THEN -amount_minor ELSE amount_minor END), 0) AS c "
        "FROM ledger_events WHERE po_id = ? AND kind IN ('opening', 'posting', 'reversal')",
        (po_id,),
    ).fetchone()
    return int(row["c"])


@dataclass(frozen=True)
class CommitResult:
    run_id: str
    invoice_id: str
    decision: Decision
    explanation: str
    posted: bool
    linked_existing_invoice: bool


class LedgerError(Exception):
    pass


def _emit(conn: sqlite3.Connection, run_id: str, stage: str, event_type: str, payload: dict) -> None:
    seq = conn.execute(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM run_events WHERE run_id = ?", (run_id,)
    ).fetchone()["s"]
    conn.execute(
        "INSERT INTO run_events (run_id, seq, stage, event_type, payload) VALUES (?, ?, ?, ?, ?)",
        (run_id, seq, stage, event_type, json.dumps(payload)),
    )


def commit_decision(
    conn: sqlite3.Connection,
    *,
    run_id: str,
    workspace: str,
    buyer: str,
    supplier_id: str,
    invoice_no_raw: str,
    invoice_minor: int,
    currency: str,
    po_id: str,
    gates: ResolverInput,
    policy: Policy,
    invoice_date_iso: str | None = None,
    decision_mode: str = "automatic",
    fingerprint_cleared_by: str | None = None,
) -> CommitResult:
    """Single entry point for terminal decisions on extract-complete runs.
    `gates` carries every non-budget, non-duplicate fact already established;
    duplicates and budget are established HERE, against fresh state."""
    canonical = canonical_invoice_no(invoice_no_raw)

    conn.execute("BEGIN IMMEDIATE")
    try:
        # -- 1. resolve-or-create logical invoice on business key
        row = conn.execute(
            "SELECT invoice_id FROM invoices WHERE workspace=? AND buyer=? AND supplier_id=? AND invoice_no_canonical=?",
            (workspace, buyer, supplier_id, canonical),
        ).fetchone()
        linked_existing = row is not None
        if row:
            invoice_id = row["invoice_id"]
        else:
            invoice_id = _uid("inv")
            conn.execute(
                "INSERT INTO invoices (invoice_id, workspace, buyer, supplier_id, invoice_no_canonical, "
                "invoice_no_raw, gross_minor, invoice_date, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (invoice_id, workspace, buyer, supplier_id, canonical, invoice_no_raw,
                 invoice_minor, invoice_date_iso, currency),
            )

        # -- 2. duplicate recheck against fresh state
        posted_row = conn.execute(
            "SELECT ledger_event_id, amount_minor FROM ledger_events WHERE invoice_id=? AND kind='posting'",
            (invoice_id,),
        ).fetchone()
        if posted_row is not None:
            if int(posted_row["amount_minor"]) != invoice_minor:
                gates.content_conflict = True  # same key, different total: versions preserved upstream
            else:
                gates.duplicate_of_posted = True

        # -- 2b. L3 fingerprint: same supplier + currency + amount + SAME DATE,
        # different invoice number — the same-day double-billing signal.
        # Candidate only -> HOLD, never certain rejection. A wider date window
        # needs line-item multiset hashes (roadmap); without them it would flag
        # legitimate equal-amount split invoices.
        if invoice_date_iso and posted_row is None:
            fp = conn.execute(
                "SELECT 1 FROM invoices WHERE workspace=? AND buyer=? AND supplier_id=? "
                "AND invoice_no_canonical != ? AND gross_minor = ? AND currency = ? "
                "AND invoice_date = ? LIMIT 1",
                (workspace, buyer, supplier_id, canonical, invoice_minor, currency,
                 invoice_date_iso),
            ).fetchone()
            if fp is not None:
                if fingerprint_cleared_by:
                    _emit(conn, run_id, "MATCH", "fingerprint_overridden",
                          {"by": fingerprint_cleared_by,
                           "note": "reviewer attested this is a separate invoice; same-day/amount match not treated as duplicate"})
                else:
                    gates.fingerprint_candidate = True

        # -- 3. fresh budget
        po = conn.execute(
            "SELECT amount_minor, currency, status, supplier_id FROM pos WHERE po_id=?", (po_id,)
        ).fetchone()
        if po is None:
            gates.po_confirmed = False
        else:
            if po["supplier_id"] != supplier_id:
                gates.po_vendor_mismatch = True
            if po["status"] != "open":
                gates.po_closed = True
            if po["currency"] != currency:
                gates.currency_mismatch = True
            gates.budget = budget_check(int(po["amount_minor"]), consumed_minor(conn, po_id), invoice_minor, policy, currency)

        decision = resolve(gates, policy)
        explanation = explain(decision)

        # -- 4. posting (approvals only)
        posted = False
        if decision.route in (Route.AUTO_APPROVE, Route.APPROVE_WITH_EXCEPTION):
            conn.execute(
                "INSERT INTO ledger_events (ledger_event_id, invoice_id, po_id, run_id, kind, amount_minor, currency) "
                "VALUES (?, ?, ?, ?, 'posting', ?, ?)",
                (_uid("led"), invoice_id, po_id, run_id, invoice_minor, currency),
            )
            posted = True

        # -- 5. decision + terminal status + audit, same transaction
        disposition = {
            Route.AUTO_APPROVE: "approved",
            Route.APPROVE_WITH_EXCEPTION: "approved",
            Route.HOLD_REVIEW: "held",
            Route.REJECT: "rejected",
        }[decision.route]
        mode = decision_mode
        if decision_mode == "automatic" and decision.route is Route.APPROVE_WITH_EXCEPTION:
            mode = "automatic_exception"
        from .currencies import REGISTRY_VERSION
        from .policy import ROUNDING_POLICY
        snapshot = {
            "policy_version": policy.version,
            "registry_version": REGISTRY_VERSION,
            "rounding_policy": ROUNDING_POLICY,
            "currency": currency,
            "consumed_A_minor": decision.budget.consumed_minor if decision.budget else None,
            "budget": decision.budget.__dict__ if decision.budget else None,
            "codes": [c.value for c in decision.codes],
        }
        conn.execute(
            "UPDATE runs SET invoice_id=?, run_status='completed', disposition=?, decision_mode=?, "
            "policy_version=?, snapshot_json=?, finished_at=datetime('now') WHERE run_id=?",
            (invoice_id, disposition, mode, policy.version, json.dumps(snapshot), run_id),
        )
        if decision.budget is not None:
            b = decision.budget
            _emit(conn, run_id, "MATCH", "rule_evaluated", {
                "rule": "budget_check[v1]",
                "A": b.consumed_minor, "I": b.invoice_minor, "C": b.cumulative_minor,
                "B": b.base_minor, "D": b.overage_minor,
                "T_primary": b.t_primary_minor, "T_exception": b.t_exception_minor,
            })
        _emit(conn, run_id, "DECIDE", "decision", {
            "route": decision.route.value, "codes": [c.value for c in decision.codes],
            "explanation": explanation, "posted": posted,
        })
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise

    return CommitResult(
        run_id=run_id, invoice_id=invoice_id, decision=decision,
        explanation=explanation, posted=posted, linked_existing_invoice=linked_existing,
    )
