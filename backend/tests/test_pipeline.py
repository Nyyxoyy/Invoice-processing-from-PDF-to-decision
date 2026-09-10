"""Pipeline-level fixtures with the model stubbed — no API calls.
Financial-effect tests run against the real commit path."""
import fitz
import pytest

import app.pipeline as pipeline
from app.db import connect
from app.extractor import Selection
from app.ledger import consumed_minor
from app.main import seed_if_empty
from app.policy import DEFAULT_POLICY
from app.rules import Code, Route


def make_pdf(path, total="$6,495.00", subtotal="$6,000.00", tax="$495.00",
             invoice_no="NW-2026-0142", po="PO-1001", supplier="Northwind Supplies LLC",
             amount_due=None, date="2026-08-28", shipping=None):
    doc = fitz.open()
    page = doc.new_page()
    y = 60
    rows = [supplier, f"Invoice No: {invoice_no}", f"Invoice Date: {date}",
            f"PO Reference: {po}", "Bill To: Acme Corporation", "Currency: USD",
            f"Subtotal: {subtotal}", f"Sales Tax: {tax}"]
    if shipping:
        rows.append(f"Shipping: {shipping}")
    rows.append(f"Total: {total}")
    if amount_due:
        rows.append(f"Amount Due: {amount_due}")
    for r in rows:
        page.insert_text((50, y), r, fontsize=11)
        y += 22
    doc.save(str(path))


FIELD_TO_ROW = {
    "supplier_name": (0, None), "invoice_number": (1, "Invoice No: "),
    "invoice_date": (2, "Invoice Date: "), "po_reference": (3, "PO Reference: "),
    "buyer_name": (4, "Bill To: "), "currency": (5, "Currency: "),
    "subtotal_net": (6, "Subtotal: "), "tax_total": (7, "Sales Tax: "),
    "invoice_gross_total": (8, "Total: "),
}


def stub_extract(rev, budget, repair=False):
    """Deterministic stand-in for the model: selects by label from real blocks."""
    sels = []
    for field in ["supplier_name", "buyer_name", "invoice_number", "invoice_date",
                  "due_date", "currency", "po_reference", "subtotal_net",
                  "tax_total", "shipping_total", "invoice_gross_total", "amount_due"]:
        found = None
        for b in rev.blocks:
            if field == "supplier_name" and b.block_id.endswith(".b0"):
                found = (b, b.text)
            prefixes = {"invoice_number": "Invoice No: ", "invoice_date": "Invoice Date: ",
                        "po_reference": "PO Reference: ", "buyer_name": "Bill To: ",
                        "currency": "Currency: ", "subtotal_net": "Subtotal: ",
                        "tax_total": "Sales Tax: ", "invoice_gross_total": "Total: ",
                        "amount_due": "Amount Due: ", "due_date": "Due Date: ",
                        "shipping_total": "Shipping: "}
            p = prefixes.get(field)
            if p and b.text.startswith(p):
                found = (b, b.text[len(p):])
        if found:
            sels.append(Selection(field=field, status="selected",
                                  source_block_id=found[0].block_id, raw_value=found[1]))
        else:
            sels.append(Selection(field=field, status="missing"))
    return sels


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, "extract_native", stub_extract)
    conn = connect(str(tmp_path / "app.db"))
    seed_if_empty(conn)
    yield conn, str(tmp_path)
    conn.close()


def run_pdf(env, name, **kw):
    conn, data_dir = env
    path = f"{data_dir}/{name}.pdf"
    make_pdf(path, **kw)
    return pipeline.process_document(conn, path, f"{name}.pdf", DEFAULT_POLICY, data_dir)


def test_clean_invoice_approves_and_posts_once(env):
    conn, _ = env
    r = run_pdf(env, "clean")
    assert r.decision.route == Route.AUTO_APPROVE and r.posted
    assert consumed_minor(conn, "PO-1001") == 649_500


def test_l1_duplicate_bytes_rejects_original_untouched(env):
    conn, data_dir = env
    r1 = run_pdf(env, "orig")
    path = f"{data_dir}/orig.pdf"
    r2 = pipeline.process_document(conn, path, "renamed.pdf", DEFAULT_POLICY, data_dir)
    assert r2.decision.route == Route.REJECT
    assert Code.DUP_FILE_HASH in r2.decision.codes
    assert consumed_minor(conn, "PO-1001") == 649_500
    row = conn.execute("SELECT disposition FROM runs WHERE run_id=?", (r1.run_id,)).fetchone()
    assert row["disposition"] == "approved"


def test_prepayment_trap_extracts_both_then_holds(env):
    conn, _ = env
    r = run_pdf(env, "prepay", total="$11,800.00", subtotal="$10,000.00",
                tax="$1,800.00", invoice_no="NW-PP-1", amount_due="$5,900.00")
    assert r.decision.route == Route.HOLD_REVIEW
    assert Code.UNSUPPORTED_AMOUNT_STRUCTURE in r.decision.codes
    assert not r.posted and consumed_minor(conn, "PO-1001") == 0


def test_math_mismatch_holds(env):
    r = run_pdf(env, "badmath", total="$7,000.00", invoice_no="NW-BM-1")
    assert r.decision.route == Route.HOLD_REVIEW
    assert Code.MATH_MISMATCH in r.decision.codes


def test_unknown_vendor_holds_without_identity(env):
    conn, _ = env
    r = run_pdf(env, "unknown", supplier="Mystery Corp Ltd", invoice_no="MY-1")
    assert r.decision.route == Route.HOLD_REVIEW
    assert Code.VENDOR_UNKNOWN in r.decision.codes
    assert r.invoice_id == ""


def test_blocked_vendor_rejects(env):
    r = run_pdf(env, "blocked", supplier="Shady Imports Co", invoice_no="SH-1", po="PO-1001")
    assert r.decision.route == Route.REJECT
    assert Code.VENDOR_BLOCKED in r.decision.codes


def test_closed_po_holds(env):
    r = run_pdf(env, "closedpo", po="PO-1004", invoice_no="NW-CL-1",
                total="$100.00", subtotal="$92.38", tax="$7.62")
    assert r.decision.route == Route.HOLD_REVIEW
    assert Code.PO_CLOSED in r.decision.codes


def test_split_trio_approve_approve_hold(env):
    conn, _ = env
    kw = dict(supplier="Globex Industrial", po="PO-1002")
    r1 = run_pdf(env, "s1", invoice_no="GX-1", total="$12,000.00", subtotal="$11,082.95", tax="$917.05", date="2026-06-15", **kw)
    r2 = run_pdf(env, "s2", invoice_no="GX-2", total="$12,000.00", subtotal="$11,082.94", tax="$917.06", date="2026-07-15", **kw)
    r3 = run_pdf(env, "s3", invoice_no="GX-3", total="$8,000.00", subtotal="$7,388.62", tax="$611.38", date="2026-08-15", **kw)
    assert r1.decision.route == Route.AUTO_APPROVE
    assert r2.decision.route == Route.AUTO_APPROVE
    assert r3.decision.route == Route.HOLD_REVIEW
    assert Code.PO_BUDGET_EXCEEDED in r3.decision.codes
    assert consumed_minor(conn, "PO-1002") == 2_400_000


def test_startup_recovery_marks_interrupted(env):
    conn, _ = env
    conn.execute("INSERT INTO documents (document_id, sha256) VALUES ('doc_x', 'hx')")
    conn.execute("INSERT INTO runs (run_id, document_id, run_status) VALUES ('run_x', 'doc_x', 'running')")
    assert pipeline.startup_recovery(conn) == 1
    row = conn.execute("SELECT run_status, failure_reason FROM runs WHERE run_id='run_x'").fetchone()
    assert (row["run_status"], row["failure_reason"]) == ("failed", "interrupted")


def test_l3_same_day_same_amount_different_number_holds(env):
    conn, _ = env
    r1 = run_pdf(env, "fp1", invoice_no="NW-FP-1", total="$500.00", subtotal="$461.89", tax="$38.11")
    r2 = run_pdf(env, "fp2", invoice_no="NW-FP-2", total="$500.00", subtotal="$461.89", tax="$38.11")
    assert r1.decision.route == Route.AUTO_APPROVE
    assert r2.decision.route == Route.HOLD_REVIEW
    assert Code.DUP_FINGERPRINT in r2.decision.codes
    assert consumed_minor(conn, "PO-1001") == 50000  # only the first posted


def test_explicit_shipping_reconciles_and_approves(env):
    conn, _ = env
    r = run_pdf(env, "ship", invoice_no="NW-SH-1", subtotal="$6,000.00", tax="$495.00",
                shipping="$50.00", total="$6,545.00")
    assert r.decision.route == Route.AUTO_APPROVE and r.posted
    assert consumed_minor(conn, "PO-1001") == 654500


def test_shipping_not_additional_holds(env):
    # gross reconciles WITHOUT the stated charge: inclusion ambiguous
    r = run_pdf(env, "shipamb", invoice_no="NW-SH-2", subtotal="$6,000.00", tax="$495.00",
                shipping="$50.00", total="$6,495.00")
    assert r.decision.route == Route.HOLD_REVIEW
    assert Code.MATH_MISMATCH in r.decision.codes


def test_multiple_distinct_po_refs_hold(env):
    conn, data_dir = env
    import fitz
    path = f"{data_dir}/multipo.pdf"
    doc = fitz.open(); page = doc.new_page(); y = 60
    for row in ["Northwind Supplies LLC", "Invoice No: NW-MP-1", "Invoice Date: 2026-08-28",
                "PO Reference: PO-1001", "Line 1 (PO-1003)", "Bill To: Acme Corporation",
                "Currency: USD", "Subtotal: $100.00", "Sales Tax: $8.25", "Total: $108.25"]:
        page.insert_text((50, y), row, fontsize=11); y += 22
    doc.save(path)
    r = pipeline.process_document(conn, path, "multipo.pdf", DEFAULT_POLICY, data_dir)
    assert r.decision.route == Route.HOLD_REVIEW
    assert Code.PO_MULTIPLE_REFS in r.decision.codes
    assert consumed_minor(conn, "PO-1001") == 0


def _scanned_pdf(path, rows):
    """An image-only page (no text layer) — classified as scanned."""
    text_doc = fitz.open(); page = text_doc.new_page(); y = 60
    for r in rows:
        page.insert_text((50, y), r, fontsize=11); y += 22
    png = page.get_pixmap(dpi=120).tobytes("png")
    doc = fitz.open(); p = doc.new_page()
    p.insert_image(p.rect, stream=png)
    doc.save(str(path))


def test_scan_fields_confirmed_by_code_need_no_attestation(env, monkeypatch):
    """The scan route with a second independent reading and hard cross-checks:
    when every reading is confirmed by code the invoice approves without a
    reviewer; a reading the second pass does not contain stays for the
    reviewer, and only that one."""
    from app.extractor import Transcription
    conn, data_dir = env
    rows = ["Northwind Supplies LLC", "Invoice No: NW-SC-9", "Invoice Date: 2026-08-28", "PO Reference: PO-1001",
            "Bill To: Acme Corporation", "Currency: USD", "Subtotal: $6,000.00", "Sales Tax: $495.00", "Total: $6,495.00"]
    values = {"supplier_name": "Northwind Supplies LLC", "invoice_number": "NW-SC-9", "invoice_date": "2026-08-28",
              "po_reference": "PO-1001", "buyer_name": "Acme Corporation", "currency": "USD",
              "subtotal_net": "6,000.00", "tax_total": "495.00", "invoice_gross_total": "6,495.00"}
    monkeypatch.setattr(pipeline, "extract_scan", lambda png, page, budget: [
        Transcription(field=f, status="selected", raw_value=v, page=page) for f, v in values.items()])

    # full agreement: the second reading contains every value
    monkeypatch.setattr(pipeline, "transcribe_page", lambda png, page, budget: "\n".join(rows))
    path = f"{data_dir}/scan-ok.pdf"; _scanned_pdf(path, rows)
    r = pipeline.process_document(conn, path, "scan-ok.pdf", DEFAULT_POLICY, data_dir)
    assert r.decision.route == Route.AUTO_APPROVE and r.posted, r.decision.codes
    ev = conn.execute("SELECT payload FROM run_events WHERE run_id=? AND event_type='scan_self_check'", (r.run_id,)).fetchone()
    assert ev and '"still_to_confirm": []' in ev["payload"] and '"arithmetic"' in ev["payload"]

    # the second reading misses the invoice number: only that field waits for the reviewer
    monkeypatch.setattr(pipeline, "transcribe_page", lambda png, page, budget: "\n".join(x for x in rows if "Invoice No" not in x))
    values["invoice_number"] = "NW-SC-10"
    path2 = f"{data_dir}/scan-partial.pdf"; _scanned_pdf(path2, rows[:1] + ["Invoice No: NW-SC-10"] + rows[2:])
    r2 = pipeline.process_document(conn, path2, "scan-partial.pdf", DEFAULT_POLICY, data_dir)
    assert r2.decision.route == Route.HOLD_REVIEW and Code.REVIEW_REQUIRED_SCAN in r2.decision.codes and not r2.posted
    from app.review import diagnose_run, load_latest
    _, fields, context = load_latest(conn, r2.run_id)
    item = next(i for i in diagnose_run(conn, r2.run_id, fields, context)["items"] if i["code"] == "REVIEW_REQUIRED_SCAN")
    assert item["fields"] == ["invoice_number"]
    assert fields["tax_total"].self_verified() and not fields["invoice_number"].self_verified()

    # no second reading at all (budget): nothing is confirmed by agreement, cross-checks still hold
    def exhausted(png, page, budget):
        from app.extractor import BudgetExceeded
        raise BudgetExceeded("verify budget used")
    monkeypatch.setattr(pipeline, "transcribe_page", exhausted)
    values["invoice_number"] = "NW-SC-11"
    path3 = f"{data_dir}/scan-nover.pdf"; _scanned_pdf(path3, rows[:1] + ["Invoice No: NW-SC-11"] + rows[2:])
    r3 = pipeline.process_document(conn, path3, "scan-nover.pdf", DEFAULT_POLICY, data_dir)
    assert r3.decision.route == Route.HOLD_REVIEW and Code.REVIEW_REQUIRED_SCAN in r3.decision.codes
    _, f3, c3 = load_latest(conn, r3.run_id)
    assert f3["subtotal_net"].self_verified() and f3["supplier_name"].self_verified() and f3["po_reference"].self_verified()
    assert not f3["invoice_number"].self_verified() and not f3["invoice_date"].self_verified()
