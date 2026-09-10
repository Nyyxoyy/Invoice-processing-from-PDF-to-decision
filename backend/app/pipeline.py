"""Orchestration: document in, terminal decision out. Every stage appends
run_events; financial effects happen only inside ledger.commit_decision."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from pathlib import Path

from . import ledger
from .db import alias_list
from .evidence import prepare_evidence, render_page_png
from .extractor import (BudgetExceeded, CallBudget, extract_native, extract_scan, transcribe_page,
                        verify_selection, verify_transcription)
from .ledger import CommitResult, commit_decision
from .policy import Policy
from .rules import Code, Decision, ResolverInput, Route, explain, resolve
from .normalize import (extract_amount, extract_date_iso, extract_invoice_number,
                        extract_name, extract_po_refs, quantize_minor)
from .validate import FieldRecord, assess, reconcile, resolve_currency

WORKSPACE, BUYER = "demo", "acme-corp"
MAX_PAGES = 10


class OperationalFailure(Exception):
    """Run cannot produce a reviewable result. Carries the run_id whose
    run_status was set to failed."""

    def __init__(self, run_id: str, reason: str):
        super().__init__(reason)
        self.run_id = run_id
        self.reason = reason


def _fail_run(conn, run_id: str, reason: str) -> None:
    conn.execute(
        "UPDATE runs SET run_status='failed', failure_reason=?, finished_at=datetime('now') WHERE run_id=?",
        (reason, run_id))
    _emit(conn, run_id, "INGEST", "operational_failure", {"reason": reason})


def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _emit(conn, run_id, stage, event_type, payload):
    ledger._emit(conn, run_id, stage, event_type, payload)


def _finalize_no_identity(conn, run_id: str, gates: ResolverInput, policy: Policy) -> CommitResult:
    """Terminal decision for runs where no business-key identity can be
    established (unresolved vendor, missing invoice number...). Always ends
    held/rejected with zero financial effect."""
    decision = resolve(gates, policy)
    text = explain(decision)
    disposition = {"HOLD_REVIEW": "held", "REJECT": "rejected"}.get(decision.route.value, "held")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            "UPDATE runs SET run_status='completed', disposition=?, decision_mode='automatic', "
            "policy_version=?, snapshot_json=?, finished_at=datetime('now') WHERE run_id=?",
            (disposition, policy.version, json.dumps({"codes": [c.value for c in decision.codes]}), run_id),
        )
        _emit(conn, run_id, "DECIDE", "decision",
              {"route": decision.route.value, "codes": [c.value for c in decision.codes],
               "explanation": text, "posted": False})
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return CommitResult(run_id=run_id, invoice_id="", decision=decision,
                        explanation=text, posted=False, linked_existing_invoice=False)


def scan_cross_checks(conn, run_id: str, fields: dict[str, FieldRecord], recon: dict) -> None:
    """Hard, code-side confirmations for scan readings that need no second
    reading: amounts that reconcile exactly confirm each other; a supplier name
    that resolves in the vendor master is right; a PO reference that exists for
    that supplier is right. Recorded on each field (checks.cross_check) and on
    the audit trail, so the reviewer sees what was confirmed and why."""
    from .normalize import extract_po_refs
    confirmed: dict[str, str] = {}
    def ok(name):
        r = fields.get(name)
        return r is not None and r.read_method == "llm_vision" and r.status == "selected" \
            and r.raw_value and r.checks.get("normalization") == "pass"
    if recon.get("ok") is True:
        for name in ("subtotal_net", "tax_total", "shipping_total", "invoice_gross_total", "amount_due"):
            if ok(name):
                fields[name].checks["cross_check"] = "arithmetic"; confirmed[name] = "arithmetic"
    vendor = None
    if ok("supplier_name"):
        vendor = resolve_vendor(conn, extract_name(fields["supplier_name"].raw_value))
        if vendor is not None:
            fields["supplier_name"].checks["cross_check"] = "vendor_master"; confirmed["supplier_name"] = "vendor_master"
    if ok("po_reference") and vendor is not None:
        refs = extract_po_refs(fields["po_reference"].raw_value)
        if len(refs) == 1 and conn.execute("SELECT 1 FROM pos WHERE po_id=? AND supplier_id=?",
                                           (refs[0], vendor["supplier_id"])).fetchone():
            fields["po_reference"].checks["cross_check"] = "po_master"; confirmed["po_reference"] = "po_master"
    independent = [n for n, r in fields.items() if r.read_method == "llm_vision" and r.checks.get("source_match") == "pass"]
    pending = [n for n, r in fields.items() if r.read_method == "llm_vision" and r.status == "selected"
               and not r.self_verified()]
    _emit(conn, run_id, "VALIDATE", "scan_self_check",
          {"cross_checks": confirmed, "independent_read_agrees": independent, "still_to_confirm": pending})


def resolve_vendor(conn, supplier_name: str | None) -> sqlite3.Row | None:
    if not supplier_name:
        return None
    name = supplier_name.strip().lower()
    for row in conn.execute("SELECT * FROM vendors").fetchall():
        aliases = alias_list(row["aliases"])
        if row["name"].strip().lower() == name or name in aliases:
            return row
    return None


def process_document(conn: sqlite3.Connection, pdf_path: str, filename: str,
                     policy: Policy, data_dir: str, retry_of: str | None = None) -> CommitResult:
    raw = Path(pdf_path).read_bytes()
    sha = hashlib.sha256(raw).hexdigest()

    # ---- INGEST: document identity + L1 ----
    existing_doc = conn.execute("SELECT document_id FROM documents WHERE sha256=?", (sha,)).fetchone()
    run_id = _uid("run")
    if retry_of:
        prior = conn.execute('SELECT * FROM runs WHERE run_id=?', (retry_of,)).fetchone()
        exhausted = conn.execute("SELECT 1 FROM run_events WHERE run_id=? AND event_type='budget_exhausted'", (retry_of,)).fetchone()
        if not prior or not existing_doc or prior['document_id'] != existing_doc['document_id'] or not (prior['run_status'] == 'failed' or exhausted):
            raise ValueError('Only a failed reading can be retried. Open the invoice to review its result.')
        newer = conn.execute('SELECT 1 FROM runs WHERE parent_run_id=?', (retry_of,)).fetchone()
        posted = conn.execute("SELECT 1 FROM runs r JOIN ledger_events l ON l.run_id=r.run_id WHERE r.document_id=? AND l.kind='posting'", (prior['document_id'],)).fetchone()
        if newer or posted:
            raise ValueError('This invoice already has a newer result. Return to Invoices and open its latest result.')
    if existing_doc and not retry_of:
        document_id = existing_doc["document_id"]
        conn.execute("INSERT INTO runs (run_id, document_id, run_status) VALUES (?, ?, 'running')",
                     (run_id, document_id))
        prior = conn.execute(
            "SELECT invoice_id FROM runs WHERE document_id=? AND invoice_id IS NOT NULL "
            "ORDER BY created_at LIMIT 1", (document_id,)).fetchone()
        _emit(conn, run_id, "INGEST", "duplicate_submission",
              {"sha256": sha, "original_invoice_id": prior["invoice_id"] if prior else None})
        gates = ResolverInput(identical_document=True)
        return _finalize_no_identity(conn, run_id, gates, policy)

    if retry_of:
        document_id = existing_doc['document_id']
        stored = Path(pdf_path)
    else:
        document_id = _uid("doc")
        stored = Path(data_dir) / "pdfs" / f"{document_id}.pdf"
        stored.parent.mkdir(parents=True, exist_ok=True)
        stored.write_bytes(raw)
        conn.execute("INSERT INTO documents (document_id, sha256, filename, bytes_path) VALUES (?, ?, ?, ?)",
                     (document_id, sha, filename, str(stored)))
    conn.execute("INSERT INTO runs (run_id, document_id, run_status, parent_run_id) VALUES (?, ?, 'running', ?)",
                 (run_id, document_id, retry_of))

    try:
        rev = prepare_evidence(str(stored))
    except Exception as e:  # corrupt/encrypted/unparseable PDF: explicit failed run
        _fail_run(conn, run_id, f"parse_error: {type(e).__name__}")
        raise OperationalFailure(run_id, f"unreadable PDF ({type(e).__name__})") from e
    if rev.pages > MAX_PAGES:
        _fail_run(conn, run_id, f"page_limit: {rev.pages} > {MAX_PAGES}")
        raise OperationalFailure(run_id, f"page limit exceeded ({rev.pages} pages)")
    any_scanned = "scanned" in rev.page_kinds
    (Path(data_dir) / "evidence").mkdir(exist_ok=True)
    (Path(data_dir) / "evidence" / f"{rev.extraction_revision_id}.json").write_text(rev.to_json())
    _emit(conn, run_id, "INGEST", "classified",
          {"pages": rev.pages, "page_kinds": list(rev.page_kinds),
           "extraction_revision_id": rev.extraction_revision_id, "blocks": len(rev.blocks)})

    # ---- EXTRACT ----
    budget = CallBudget()
    fields: dict[str, FieldRecord] = {}
    try:
        if any_scanned:
            page = rev.page_kinds.index("scanned") + 1
            png = render_page_png(str(stored), page)
            transcriptions = extract_scan(png, page, budget)
            try:
                page_text = transcribe_page(png, page, budget)   # independent second reading
            except BudgetExceeded as e:
                page_text = None
                _emit(conn, run_id, "EXTRACT", "scan_verify_skipped", {"reason": str(e)})
            for t in transcriptions:
                fields[t.field] = FieldRecord(
                    field=t.field, status=t.status, raw_value=t.raw_value,
                    read_method="llm_vision", evidence={"page": t.page},
                    checks=verify_transcription(t, page_text))
        else:
            for s in extract_native(rev, budget):
                fields[s.field] = FieldRecord(
                    field=s.field, status=s.status, raw_value=s.raw_value,
                    read_method="llm_text",
                    evidence={"extraction_revision_id": rev.extraction_revision_id,
                              "block_id": s.source_block_id},
                    checks=verify_selection(s, rev))
    except BudgetExceeded as e:
        _emit(conn, run_id, "EXTRACT", "budget_exhausted", {"error": str(e), "attempts": budget.attempts})
        gates = ResolverInput()  # nothing verified -> MISSING_FIELD hold with partial evidence
        return _finalize_no_identity(conn, run_id, gates, policy)
    finally:
        _emit(conn, run_id, "EXTRACT", "attempts", {"attempts": budget.attempts})

    _emit(conn, run_id, "EXTRACT", "fields",
          {f: {"status": r.status, "raw": r.raw_value, "checks": r.checks,
               "read_method": r.read_method, "evidence": r.evidence} for f, r in fields.items()})

    # ---- VALIDATE ----
    from .review import save_revision
    currency = resolve_currency(fields, rev.blocks)
    recon = reconcile(fields, currency.code)
    if any_scanned:
        scan_cross_checks(conn, run_id, fields, recon)
    gates = assess(fields, any_scanned, currency)

    # deterministic PO reference collection across ALL pages/blocks; repeated
    # identical references deduplicate, multiple DISTINCT references hold
    all_refs: list[str] = []
    for b in rev.blocks:
        for r in extract_po_refs(b.text):
            if r not in all_refs:
                all_refs.append(r)
    if not all_refs and any_scanned:
        # a scanned page has no text blocks; the PO reference can only come from
        # the vision reading — used only once code has confirmed it (the order
        # exists for the resolved supplier, or an independent reading agrees)
        po_rec = fields.get("po_reference")
        if po_rec is not None and po_rec.self_verified():
            all_refs = extract_po_refs(po_rec.raw_value)
    if len(all_refs) > 1:
        gates.multiple_po_refs = True

    save_revision(conn, run_id, "extraction", None, fields, {
        "any_scanned": any_scanned,
        "currency": {"code": currency.code, "source": currency.source},
        "po_references": all_refs})
    _emit(conn, run_id, "VALIDATE", "gates", {
        "required_fields_ok": gates.required_fields_ok, "arithmetic_ok": gates.arithmetic_ok,
        "reconciliation": recon["detail"],
        "structure_supported": gates.structure_supported, "scan_gate": gates.scan_gate,
        "ambiguous_date": gates.ambiguous_date,
        "currency": {"code": currency.code, "source": currency.source,
                     "evidence": currency.evidence},
        "po_references": all_refs})

    # ---- vendor + identity preconditions ----
    supplier = fields.get("supplier_name")
    vendor = resolve_vendor(conn, extract_name(supplier.raw_value) if supplier else None)
    if vendor is None:
        gates.vendor_resolved = False
        return _finalize_no_identity(conn, run_id, gates, policy)
    gates.vendor_resolved = True
    gates.vendor_blocked = vendor["status"] == "blocked"

    inv_no = fields.get("invoice_number")
    if not (inv_no and inv_no.affirmatively_verified()):
        return _finalize_no_identity(conn, run_id, gates, policy)

    if gates.multiple_po_refs or len(all_refs) != 1:
        gates.po_confirmed = False if not all_refs else None
        return _finalize_no_identity(conn, run_id, gates, policy)
    po_id = all_refs[0]
    gates.po_confirmed = True  # existence/vendor/currency/status verified in commit against fresh state

    if currency.code is None:
        # identity may be establishable, but no posting or budget math is safe
        # without a resolved currency
        return _finalize_no_identity(conn, run_id, gates, policy)

    gross_dec = extract_amount(fields["invoice_gross_total"].raw_value) if "invoice_gross_total" in fields else None
    gross_minor = quantize_minor(gross_dec, currency.code) if gross_dec is not None else None
    if gross_minor is None:
        return _finalize_no_identity(conn, run_id, gates, policy)

    # ---- MATCH + DECIDE + COMMIT (atomic, fresh state) ----
    invoice_no_value = extract_invoice_number(inv_no.raw_value)
    if invoice_no_value is None:
        return _finalize_no_identity(conn, run_id, gates, policy)

    date_rec = fields.get("invoice_date")
    invoice_date_iso = extract_date_iso(date_rec.raw_value) if date_rec else None

    return commit_decision(
        conn, run_id=run_id, workspace=WORKSPACE, buyer=BUYER,
        supplier_id=vendor["supplier_id"], invoice_no_raw=invoice_no_value,
        invoice_minor=gross_minor, currency=currency.code, po_id=po_id,
        gates=gates, policy=policy, invoice_date_iso=invoice_date_iso)


def startup_recovery(conn: sqlite3.Connection) -> int:
    """Mark stale in-progress work interrupted; retry is a new run."""
    cur = conn.execute(
        "UPDATE runs SET run_status='failed', failure_reason='interrupted', finished_at=datetime('now') "
        "WHERE run_status IN ('queued', 'running')")
    return cur.rowcount
