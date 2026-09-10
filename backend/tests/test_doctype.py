"""Faulty and non-invoice documents: refused at intake, failed with a reason,
or rejected as UNSUPPORTED_DOCUMENT_TYPE — never a review form full of empty
fields, never a model call for junk. Every case on the Edge cases page that
claims a test is exercised here or in a sibling module (checked by
test_edge_case_catalogue_points_at_real_tests)."""
import fitz
import pytest
from fastapi.testclient import TestClient

import app.main as main_mod
import app.pipeline as pipeline
from app.db import connect
from app.doctype import classify_document, classify_text
from app.evidence import looks_garbled, prepare_evidence
from app.extractor import Transcription
from app.ledger import consumed_minor
from app.main import seed_if_empty
from app.policy import DEFAULT_POLICY
from app.rules import Code, Route
from tests.test_pipeline import _scanned_pdf, make_pdf, stub_extract

REVIEWER = {"Authorization": "Bearer reviewer-demo"}


def _no_model(*a, **k):
    raise AssertionError("the model must not be called for a document that is not an invoice")


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, "extract_native", stub_extract)
    monkeypatch.setattr(pipeline, "extract_scan", _no_model)
    monkeypatch.setattr(pipeline, "transcribe_page", _no_model)
    conn = connect(str(tmp_path / "app.db"))
    seed_if_empty(conn)
    yield conn, str(tmp_path)
    conn.close()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main_mod, "DATA_DIR", str(tmp_path))
    monkeypatch.delenv("ADMIN_ACCESS_CODE", raising=False)
    monkeypatch.delenv("REVIEWER_ACCESS_CODE", raising=False)
    with TestClient(main_mod.app) as c:
        yield c


def text_pdf(path, lines, pages=1):
    doc = fitz.open()
    per_page = max(1, -(-len(lines) // pages))
    for i in range(pages):
        page = doc.new_page()
        y = 60
        for line in lines[i * per_page:(i + 1) * per_page]:
            page.insert_text((50, y), line, fontsize=11)
            y += 20
    doc.save(str(path))
    return str(path)


def run(env, path, name, **kw):
    conn, data_dir = env
    return pipeline.process_document(conn, path, name, DEFAULT_POLICY, data_dir, **kw)


def doc_type_event(conn, run_id):
    import json
    row = conn.execute("SELECT payload FROM run_events WHERE run_id=? AND event_type='document_type' "
                       "ORDER BY seq DESC LIMIT 1", (run_id,)).fetchone()
    return json.loads(row["payload"]) if row else None


def assert_not_invoice(conn, r, kind):
    assert r.decision.route == Route.REJECT and r.decision.codes == (Code.UNSUPPORTED_DOCUMENT_TYPE,)
    assert not r.posted and r.invoice_id == ""
    ev = doc_type_event(conn, r.run_id)
    assert ev and ev["kind"] == kind and ev["invoice_like"] is False and ev["reasons"]
    # no field revision -> the review desk has nothing to ask for
    assert conn.execute("SELECT COUNT(*) c FROM field_revisions WHERE run_id=?", (r.run_id,)).fetchone()["c"] == 0


# ---- 1 · intake ---------------------------------------------------------------

def test_upload_rejects_non_pdf_bytes(client):
    r = client.post("/api/invoices", files={"file": ("invoice.pdf", b"PK\x03\x04 not really", "application/pdf")}, headers=REVIEWER)
    assert r.status_code == 422 and "not a PDF" in r.text
    r = client.post("/api/invoices", files={"file": ("empty.pdf", b"", "application/pdf")}, headers=REVIEWER)
    assert r.status_code == 422
    assert client.get("/api/runs", headers=REVIEWER).json() == []


def test_upload_rejects_oversize(client, monkeypatch):
    monkeypatch.setattr(main_mod, "MAX_UPLOAD_BYTES", 100)
    r = client.post("/api/invoices", files={"file": ("big.pdf", b"%PDF-1.4" + b"x" * 200, "application/pdf")}, headers=REVIEWER)
    assert r.status_code == 413
    assert client.get("/api/runs", headers=REVIEWER).json() == []


# ---- 2 · parse ----------------------------------------------------------------

def test_corrupt_pdf_fails_explicitly(env):
    conn, data_dir = env
    path = f"{data_dir}/corrupt.pdf"
    open(path, "wb").write(b"%PDF-1.7\n%%garbage garbage garbage\n")
    with pytest.raises(pipeline.OperationalFailure) as ex:
        run(env, path, "corrupt.pdf")
    row = conn.execute("SELECT run_status, failure_reason FROM runs WHERE run_id=?", (ex.value.run_id,)).fetchone()
    assert row["run_status"] == "failed" and row["failure_reason"].startswith("parse_error")


def test_encrypted_pdf_fails_with_reason(env):
    conn, data_dir = env
    path = f"{data_dir}/locked.pdf"
    make_pdf(f"{data_dir}/plain.pdf")
    doc = fitz.open(f"{data_dir}/plain.pdf")
    doc.save(path, encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="owner")
    doc.close()
    with pytest.raises(pipeline.OperationalFailure, match="password"):
        run(env, path, "locked.pdf")
    row = conn.execute("SELECT failure_reason FROM runs ORDER BY rowid DESC LIMIT 1").fetchone()
    assert row["failure_reason"].startswith("encrypted")


def test_zero_page_pdf_fails(env):
    conn, data_dir = env
    path = f"{data_dir}/nopages.pdf"
    open(path, "wb").write(
        b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n"
        b"trailer<</Root 1 0 R>>\n%%EOF\n")
    with pytest.raises(pipeline.OperationalFailure, match="no pages"):
        run(env, path, "nopages.pdf")
    row = conn.execute("SELECT failure_reason FROM runs ORDER BY rowid DESC LIMIT 1").fetchone()
    assert row["failure_reason"].startswith("no_pages")


def test_page_limit_fails(env):
    conn, data_dir = env
    path = text_pdf(f"{data_dir}/long.pdf", [f"Invoice page {i} Total: $1.00" for i in range(11)], pages=11)
    with pytest.raises(pipeline.OperationalFailure, match="page limit"):
        run(env, path, "long.pdf")
    assert conn.execute("SELECT failure_reason FROM runs ORDER BY rowid DESC LIMIT 1").fetchone()["failure_reason"].startswith("page_limit")


# ---- 3 · not an invoice -------------------------------------------------------

def test_blank_pdf_rejected_without_model_call(env, monkeypatch):
    conn, data_dir = env
    monkeypatch.setattr(pipeline, "extract_native", _no_model)
    doc = fitz.open(); doc.new_page(); doc.new_page(); path = f"{data_dir}/blank.pdf"; doc.save(path)
    r = run(env, path, "blank.pdf")
    assert_not_invoice(conn, r, "blank")
    assert doc_type_event(conn, r.run_id)["signals"]["blank_pages"] == [1, 2]


def test_junk_text_pdf_rejected_without_model_call(env, monkeypatch):
    conn, data_dir = env
    monkeypatch.setattr(pipeline, "extract_native", _no_model)
    path = text_pdf(f"{data_dir}/cv.pdf", [
        "Jane Doe - Curriculum Vitae", "Senior Software Engineer, 12 years of experience",
        "2019-2026  Lead developer at Example Corp, Berlin", "Skills: Python, distributed systems, leadership",
        "References available on request.", "Hobbies: climbing, chess, pottery"])
    r = run(env, path, "cv.pdf")
    assert_not_invoice(conn, r, "not_invoice")
    ev = doc_type_event(conn, r.run_id)
    assert "invoice" in ev["reasons"][0] and ev["signals"]["amounts"] == 0
    # the same junk again is a duplicate submission, not another classification
    r2 = run(env, path, "cv-again.pdf")
    assert r2.decision.codes == (Code.DUP_FILE_HASH,)


@pytest.mark.parametrize("kind,lines", [
    ("purchase_order", ["PURCHASE ORDER PO-1001", "Northwind Supplies LLC", "Ship to: Acme Corporation",
                        "Qty 10  Widget  $600.00", "Total: $6,000.00", "Currency: USD"]),
    ("quote", ["QUOTATION Q-77", "Northwind Supplies LLC", "Valid for 30 days", "Subtotal $6,000.00", "Total $6,495.00 USD"]),
    ("proforma", ["PRO FORMA INVOICE PF-1", "Northwind Supplies LLC", "Total: $6,495.00", "Not a request for payment"]),
    ("credit_note", ["CREDIT NOTE CN-9 against invoice NW-2026-0142", "Northwind Supplies LLC",
                     "Credit amount: -$495.00", "Total: -$495.00 USD"]),
    ("statement", ["STATEMENT OF ACCOUNT", "Northwind Supplies LLC", "Opening balance $1,000.00",
                   "Payment received $500.00", "Closing balance $500.00"]),
    ("delivery_note", ["DELIVERY NOTE DN-5", "Northwind Supplies LLC", "Ship to: Acme Corporation",
                       "Qty 10 Widgets", "Signed for by: J. Smith 2026-08-28"]),
    ("remittance", ["REMITTANCE ADVICE", "Acme Corporation paid Northwind Supplies LLC", "Ref NW-2026-0142 $6,495.00", "Paid 2026-09-01"]),
    ("receipt", ["RECEIPT #4411", "Coffee Corner", "Latte $4.50", "Total $4.50 USD", "Thank you"]),
])
def test_other_financial_documents_rejected_by_type(env, monkeypatch, kind, lines):
    conn, data_dir = env
    monkeypatch.setattr(pipeline, "extract_native", _no_model)
    path = text_pdf(f"{data_dir}/{kind}.pdf", lines)
    r = run(env, path, f"{kind}.pdf")
    assert_not_invoice(conn, r, kind)
    assert consumed_minor(conn, "PO-1001") == 0


def test_bundle_of_invoices_rejected(env, monkeypatch):
    conn, data_dir = env
    monkeypatch.setattr(pipeline, "extract_native", _no_model)
    path = text_pdf(f"{data_dir}/bundle.pdf", [
        "Northwind Supplies LLC", "Invoice No: NW-1", "Total: $100.00 USD",
        "Northwind Supplies LLC", "Invoice No: NW-2", "Total: $200.00 USD"], pages=2)
    r = run(env, path, "bundle.pdf")
    assert_not_invoice(conn, r, "bundle")
    assert doc_type_event(conn, r.run_id)["signals"]["invoice_numbers"] == ["NW-1", "NW-2"]


def test_scan_with_no_invoice_fields_rejected(env, monkeypatch):
    """An image-only page has no text to judge: one vision reading runs; when it
    finds none of the invoice fields the document is rejected, not reviewed."""
    conn, data_dir = env
    from app.extractor import FIELDS
    monkeypatch.setattr(pipeline, "extract_scan", lambda png, page, budget: [
        Transcription(field=f, status="missing", page=page) for f in FIELDS])
    monkeypatch.setattr(pipeline, "transcribe_page", lambda png, page, budget: "Dear Sam\nThanks for lunch\nSee you Friday")
    path = f"{data_dir}/letter-scan.pdf"
    _scanned_pdf(path, ["Dear Sam,", "Thanks for lunch on Tuesday.", "See you Friday!"])
    r = run(env, path, "letter-scan.pdf")
    assert_not_invoice(conn, r, "not_invoice")
    assert doc_type_event(conn, r.run_id)["signals"]["scan"] is True


def test_scan_with_one_stray_field_is_still_not_an_invoice(env, monkeypatch):
    """The vision model naming a "supplier" on a personal letter must not open a
    review form: an invoice states an amount AND identifies itself."""
    conn, data_dir = env
    from app.extractor import FIELDS
    monkeypatch.setattr(pipeline, "extract_scan", lambda png, page, budget: [
        Transcription(field=f, status="selected" if f == "supplier_name" else "missing",
                      raw_value="Alex" if f == "supplier_name" else None, page=page) for f in FIELDS])
    monkeypatch.setattr(pipeline, "transcribe_page",
                        lambda png, page, budget: "Dear Sam\nThanks for lunch\nYours, Alex")
    path = f"{data_dir}/letter-stray.pdf"
    _scanned_pdf(path, ["Dear Sam,", "Thanks for lunch.", "Yours, Alex"])
    r = run(env, path, "letter-stray.pdf")
    assert_not_invoice(conn, r, "not_invoice")


def test_scan_page_reading_that_reads_as_another_document_is_refused(env, monkeypatch):
    """The second reading of the page is classified like any text: a scanned
    delivery note is named as one, even when fields were read from it."""
    conn, data_dir = env
    from app.extractor import FIELDS
    values = {"supplier_name": "Northwind Supplies LLC", "invoice_gross_total": "6,495.00",
              "subtotal_net": "6,000.00"}
    monkeypatch.setattr(pipeline, "extract_scan", lambda png, page, budget: [
        Transcription(field=f, status="selected" if f in values else "missing",
                      raw_value=values.get(f), page=page) for f in FIELDS])
    monkeypatch.setattr(pipeline, "transcribe_page", lambda png, page, budget:
                        "DELIVERY NOTE DN-5\nNorthwind Supplies LLC\nShip to: Acme Corporation\nQty 10 Widgets")
    path = f"{data_dir}/delivery-scan.pdf"
    _scanned_pdf(path, ["DELIVERY NOTE DN-5", "Northwind Supplies LLC", "Qty 10 Widgets"])
    r = run(env, path, "delivery-scan.pdf")
    assert_not_invoice(conn, r, "delivery_note")


def test_scanned_invoice_still_passes_the_scan_type_gate(env, monkeypatch):
    """The gate must not refuse a real scanned invoice."""
    conn, data_dir = env
    from app.extractor import FIELDS
    rows = ["Northwind Supplies LLC", "Invoice No: NW-SC-1", "Invoice Date: 2026-08-28",
            "PO Reference: PO-1001", "Bill To: Acme Corporation", "Currency: USD",
            "Subtotal: $6,000.00", "Sales Tax: $495.00", "Total: $6,495.00"]
    values = {"supplier_name": "Northwind Supplies LLC", "invoice_number": "NW-SC-1",
              "invoice_date": "2026-08-28", "po_reference": "PO-1001", "currency": "USD",
              "subtotal_net": "6,000.00", "tax_total": "495.00", "invoice_gross_total": "6,495.00"}
    monkeypatch.setattr(pipeline, "extract_scan", lambda png, page, budget: [
        Transcription(field=f, status="selected" if f in values else "missing",
                      raw_value=values.get(f), page=page) for f in FIELDS])
    monkeypatch.setattr(pipeline, "transcribe_page", lambda png, page, budget: "\n".join(rows))
    path = f"{data_dir}/scan-real.pdf"
    _scanned_pdf(path, rows)
    r = run(env, path, "scan-real.pdf")
    assert Code.UNSUPPORTED_DOCUMENT_TYPE not in r.decision.codes
    assert r.decision.route == Route.AUTO_APPROVE and r.posted


def test_read_as_invoice_override(env, monkeypatch):
    """A genuine invoice the gate got wrong: the reviewer's override re-reads
    it with the gate skipped, as a child run; the override is recorded."""
    conn, data_dir = env
    # an invoice whose wording the gate does not know: only "Total" is missing
    # too, so the structural rule cannot rescue it
    path = text_pdf(f"{data_dir}/odd.pdf", [
        "Northwind Supplies LLC", "Invoice No: NW-ODD-1", "Invoice Date: 2026-08-28", "PO Reference: PO-1001",
        "Bill To: Acme Corporation", "Currency: USD", "Subtotal: $6,000.00", "Sales Tax: $495.00", "Total: $6,495.00"])
    # force a false negative by making the classifier blind for this run
    import app.doctype as doctype
    real = doctype.classify_text
    monkeypatch.setattr(pipeline, "classify_document", lambda *a, **k: doctype.DocTypeVerdict("not_invoice", False, "not an invoice", ["test"]))
    r = run(env, path, "odd.pdf")
    assert_not_invoice(conn, r, "not_invoice")

    doc_id = conn.execute("SELECT document_id FROM runs WHERE run_id=?", (r.run_id,)).fetchone()["document_id"]
    stored = conn.execute("SELECT bytes_path FROM documents WHERE document_id=?", (doc_id,)).fetchone()["bytes_path"]
    # a plain retry is refused; only the explicit override may re-read it
    with pytest.raises(ValueError):
        run(env, stored, "odd.pdf", retry_of=r.run_id)
    r2 = run(env, stored, "odd.pdf", retry_of=r.run_id, as_invoice=True)
    assert r2.decision.route == Route.AUTO_APPROVE and r2.posted
    ev = doc_type_event(conn, r2.run_id)
    assert ev["forced"] is True and ev["invoice_like"] is True
    assert conn.execute("SELECT parent_run_id FROM runs WHERE run_id=?", (r2.run_id,)).fetchone()["parent_run_id"] == r.run_id
    assert consumed_minor(conn, "PO-1001") == 649_500

    # the override cannot be used on a run that was not rejected as "not an invoice"
    with pytest.raises(ValueError, match="not an invoice"):
        run(env, stored, "odd.pdf", retry_of=r2.run_id, as_invoice=True)
    assert real is doctype.classify_text


def test_one_invoice_across_two_pages_is_not_a_bundle(env, monkeypatch):
    """A real two-page invoice repeats its own number and its body says the word
    "invoice" many times. Neither may read as two invoices in one file."""
    conn, data_dir = env
    path = text_pdf(f"{data_dir}/two-page-invoice.pdf", [
        "Bioplex", "INVOICE", "we love chemistry", "INVOICE # BPXINV-00550",
        "Currency: USD", "Subtotal: $920.00", "Sales Tax: $80.00", "Total: $1,000.00",
        "INVOICE # BPXINV-00550 (continued)", "Terms: net 30",
        "If you have any questions concerning this invoice, contact us."], pages=2)
    rev = prepare_evidence(path)
    page_texts = ["\n".join(b.text for b in rev.blocks if b.page == n) for n in range(1, rev.pages + 1)]
    v = classify_document(path, "\n".join(b.text for b in rev.blocks), rev.pages, rev.page_kinds, page_texts)
    assert v.invoice_like and v.kind == "invoice", v.reasons
    # the label scan must not turn a following word into an invoice number
    assert v.signals["invoice_numbers"] == ["BPXINV-00550"]


def test_invoice_number_scan_ignores_words_and_needs_a_digit():
    from app.doctype import invoice_numbers
    assert invoice_numbers("Bioplex INVOICE we love chemistry") == set()
    assert invoice_numbers("questions concerning this invoice, contact us") == set()
    assert invoice_numbers("INVOICE # BPXINV-00550") == {"BPXINV-00550"}
    assert invoice_numbers("Invoice No: NW-1 ... Invoice No: NW-2") == {"NW-1", "NW-2"}


def test_bundle_needs_different_numbers_on_different_pages():
    from app.doctype import classify_text
    one = ["Acme Supplies", "Invoice No: A-1", "Total: $100.00 USD", "Sales Tax: $7.62"]
    two = ["Acme Supplies", "Invoice No: A-1 (page 2)", "Total: $100.00 USD"]
    other = ["Acme Supplies", "Invoice No: B-2", "Total: $200.00 USD", "Sales Tax: $15.24"]
    same = classify_text("\n".join(one + two), 2, ["\n".join(one), "\n".join(two)])
    assert same.invoice_like and same.kind == "invoice"
    bundled = classify_text("\n".join(one + other), 2, ["\n".join(one), "\n".join(other)])
    assert not bundled.invoice_like and bundled.kind == "bundle"
    assert bundled.signals["bundle_numbers"] == ["A-1", "B-2"]
    crowded = classify_text("\n".join(one + other), 1, ["\n".join(one + other)])
    assert crowded.invoice_like, "two numbers on ONE page are not two invoices"


def test_invoice_in_a_script_without_spaces_passes_gate():
    """Chinese, Japanese and Korean write without spaces, so the vocabulary has
    to match without word boundaries — otherwise a keyword inside a longer run
    ("消費税額") is never found and a real invoice is refused."""
    from app.doctype import classify_text
    ja = classify_text("請求書\n株式会社ノースウィンド\n請求番号: NW-1\n"
                       "小計 12,000.00\n消費税額 1,200.00\n合計 13,200.00 JPY")
    assert ja.invoice_like and ja.kind == "invoice", ja.reasons
    assert ja.signals["total_words"] and ja.signals["tax_words"]
    zh = classify_text("发票\n北风供应有限公司\n总计 1,000.00 CNY\n增值税 100.00")
    assert zh.invoice_like and zh.kind == "invoice", zh.reasons


def test_currencies_without_a_minor_unit_still_read_as_money(env, monkeypatch):
    """Yen and won invoices print 13,200 — never 13,200.00. A decimals-only
    amount rule would refuse them as "no monetary amounts"."""
    from app.doctype import classify_text, money_hits
    jpy = classify_text("請求書\n株式会社ノースウィンド\n請求番号: NW-1\n"
                        "小計 12,000円\n消費税額 1,200円\n合計 13,200円")
    assert jpy.invoice_like and jpy.kind == "invoice", jpy.reasons
    krw = classify_text("세금계산서\n합계 1,320,000 KRW\n부가세 120,000")
    assert krw.invoice_like and krw.kind == "invoice", krw.reasons
    assert money_hits("13,200円")["currency_adjacent"] == 1
    assert money_hits("6,495.00")["decimal"] == 1
    # a plain year or a quantity is not money
    assert money_hits("2026")["grouped_integer"] == 0
    # and the junk document must still be refused
    assert classify_text("Jane Doe — Curriculum Vitae\n12 years of experience\n"
                         "2019-2026 Lead developer\nSkills: Python").kind == "not_invoice"


def test_foreign_language_invoice_passes_gate():
    de = classify_text("RECHNUNG Nr. 2026-17\nNorthwind GmbH\nRechnungsdatum 28.08.2026\nNettobetrag 6.000,00 EUR\nMwSt 19% 1.140,00\nGesamtbetrag 7.140,00 EUR")
    fr = classify_text("FACTURE N° F-88\nMontant HT 1 000,00 €\nTVA 200,00 €\nTotal TTC 1 200,00 €")
    unknown_wording = classify_text("BILLING DOCUMENT 77\nSome Supplier Ltd\nNet 100.00\nTax 20.00\nTotal 120.00 GBP")
    assert de.invoice_like and fr.invoice_like and unknown_wording.invoice_like
    assert classify_text("Chapter 1. It was a bright cold day in April, and the clocks were striking thirteen.").kind == "not_invoice"
    assert classify_text("").kind == "unknown" and classify_text("").invoice_like


# ---- 4 · unusable text layer --------------------------------------------------

def test_garbled_text_layer_treated_as_scan(env, monkeypatch):
    assert looks_garbled("(cid:12)(cid:13)(cid:14) (cid:15) some (cid:16) text here")
    assert looks_garbled("¤¤¤ ‡‡‡ §§§ ¶¶¶ ∆∆∆ ◊◊◊ ∑∑∑ ∂∂∂ ƒƒƒ ©©© ˙˙˙ ˚˚˚ ¸¸¸ ˝˝˝ ˛˛˛ ˇˇˇ")
    assert not looks_garbled("Northwind Supplies LLC Invoice No: NW-1 Total: $6,495.00 Sales Tax: $495.00")
    conn, data_dir = env
    path = text_pdf(f"{data_dir}/garbled.pdf", ["(cid:3)(cid:8)(cid:12) (cid:44)(cid:51) (cid:9)(cid:7)(cid:1) (cid:2)(cid:5)(cid:6) (cid:70)(cid:71)"])
    rev = prepare_evidence(path)
    assert rev.page_kinds == ("scanned",) and rev.garbled_pages == (1,) and rev.blocks == ()


# ---- 5 · reading fails --------------------------------------------------------

def test_budget_exhausted_holds_without_posting(env, monkeypatch):
    from app.extractor import BudgetExceeded
    conn, data_dir = env
    def exhausted(rev, budget, repair=False):
        raise BudgetExceeded("attempts exhausted: model unavailable")
    monkeypatch.setattr(pipeline, "extract_native", exhausted)
    path = f"{data_dir}/ok.pdf"; make_pdf(path)
    r = run(env, path, "ok.pdf")
    assert r.decision.route == Route.HOLD_REVIEW and not r.posted
    assert conn.execute("SELECT 1 FROM run_events WHERE run_id=? AND event_type='budget_exhausted'", (r.run_id,)).fetchone()
    assert consumed_minor(conn, "PO-1001") == 0


# ---- the catalogue itself -----------------------------------------------------

def test_edge_case_catalogue_points_at_real_tests(client):
    import pathlib, re
    data = client.get("/api/edge-cases", headers=REVIEWER).json()
    names = set()
    for f in pathlib.Path(__file__).parent.glob("test_*.py"):
        names |= set(re.findall(r"^def (test_\w+)", f.read_text(), re.M))
    cited = [c["test"] for g in data["groups"] for c in g["cases"] if c["test"]]
    missing = [t for t in cited if t not in names]
    assert not missing, missing
    assert data["limits"]["max_pages"] == pipeline.MAX_PAGES
    assert all(c["status"] in ("handled", "limitation") for g in data["groups"] for c in g["cases"])
