"""Bulk intake: several PDFs at once, ZIP expansion, remote sources reported honestly."""
import io
import time
import zipfile

import fitz
import pytest
from fastapi.testclient import TestClient

import app.main as main_mod
import app.pipeline as pipeline_mod
from app.intake import MAX_BATCH_DOCUMENTS, IntakeError, expand_uploads
from tests.test_pipeline import stub_extract

REVIEWER = {"Authorization": "Bearer reviewer-demo"}
ADMIN = {"Authorization": "Bearer admin-demo"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main_mod, "DATA_DIR", str(tmp_path))
    monkeypatch.delenv("ADMIN_ACCESS_CODE", raising=False)
    monkeypatch.delenv("REVIEWER_ACCESS_CODE", raising=False)
    monkeypatch.setattr(pipeline_mod, "extract_native", stub_extract)
    with TestClient(main_mod.app) as c:
        yield c


def make_pdf(number: str, supplier="Northwind Supplies LLC", po="PO-1001", total="1,080.00") -> bytes:
    doc = fitz.open(); page = doc.new_page(); y = 60
    for line in [supplier, f"Invoice No: {number}", "Invoice Date: 2026-08-28", f"PO Reference: {po}",
                 "Bill To: Acme Corporation", "Currency: USD", "Subtotal: $1,000.00", "Sales Tax: $80.00",
                 f"Total: ${total}"]:
        page.insert_text((50, y), line, fontsize=11); y += 22
    return doc.tobytes()


def make_zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


def wait_batch(client, batch_id, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        b = client.get(f"/api/batches/{batch_id}", headers=REVIEWER).json()
        if b["status"] == "done":
            return b
        time.sleep(0.05)
    raise AssertionError("batch did not finish")


# ---- pure expansion ---------------------------------------------------------

def test_expand_mixed_upload_reports_every_part():
    pdf = make_pdf("A-1")
    items = expand_uploads([
        ("a.pdf", pdf),
        ("notes.txt", b"hello"),
        ("empty.pdf", b""),
        ("fake.pdf", b"not really a pdf"),
        ("big.pdf", b"%PDF" + b"0" * (10 * 1024 * 1024)),
    ])
    by_name = {i.filename: i for i in items}
    assert by_name["a.pdf"].status == "queued" and by_name["a.pdf"].tmp_path
    assert by_name["notes.txt"].status == "skipped" and by_name["notes.txt"].reason == "Not a PDF."
    assert by_name["empty.pdf"].reason == "Empty file."
    assert "signature" in by_name["fake.pdf"].reason or by_name["fake.pdf"].reason == "Not a PDF."
    assert by_name["big.pdf"].reason == "Larger than 10 MB."


def test_expand_zip_filters_junk_and_nested_archives():
    inner = make_zip({"nested.pdf": make_pdf("N-1")})
    archive = make_zip({
        "invoices/one.pdf": make_pdf("Z-1"),
        "invoices/two.PDF": make_pdf("Z-2"),
        "__MACOSX/._one.pdf": b"junk",
        "invoices/.DS_Store": b"junk",
        "invoices/readme.md": b"# hi",
        "invoices/more.zip": inner,
        "invoices/folder/": b"",
        "invoices/lying.pdf": b"GIF89a not a pdf",
    })
    items = expand_uploads([("batch.zip", archive)])
    by_name = {i.filename: i for i in items}
    assert by_name["one.pdf"].status == "queued" and by_name["one.pdf"].source == "zip:batch.zip"
    assert by_name["two.PDF"].status == "queued"
    assert "._one.pdf" not in by_name and ".DS_Store" not in by_name  # silently ignored
    assert by_name["readme.md"].status == "skipped"
    assert "Nested" in by_name["more.zip"].reason
    assert "signature" in by_name["lying.pdf"].reason


def test_zip_bomb_is_refused_by_declared_size_without_inflating():
    # 11 MB of zeros compresses to ~11 KB; declared size alone must skip it
    bomb = make_zip({"bomb.pdf": b"%PDF" + b"\0" * (11 * 1024 * 1024)})
    assert len(bomb) < 100_000
    # alongside a real PDF the bomb entry is reported as skipped, the PDF still queues
    items = expand_uploads([("bomb.zip", bomb), ("ok.pdf", make_pdf("OK-1"))])
    by_name = {i.filename: i for i in items}
    assert by_name["bomb.pdf"].status == "skipped" and by_name["bomb.pdf"].reason == "Larger than 10 MB."
    assert by_name["ok.pdf"].status == "queued"
    # alone it is a whole-request rejection carrying the reason
    with pytest.raises(IntakeError) as e:
        expand_uploads([("bomb.zip", bomb)])
    assert e.value.status == 422 and "10 MB" in e.value.message


def test_batch_limit_applies_across_parts():
    pdfs = [(f"f{i}.pdf", make_pdf(f"L-{i}")) for i in range(MAX_BATCH_DOCUMENTS + 3)]
    items = expand_uploads(pdfs)
    assert sum(1 for i in items if i.status == "queued") == MAX_BATCH_DOCUMENTS
    assert sum(1 for i in items if "batch limit" in (i.reason or "")) == 3


def test_nothing_usable_is_a_request_error():
    with pytest.raises(IntakeError) as e:
        expand_uploads([("x.txt", b"nope"), ("corrupt.zip", b"PK\x03\x04garbage")])
    assert e.value.status == 422


# ---- HTTP + background processing ------------------------------------------

def test_batch_endpoint_processes_every_pdf_and_zip_entry(client):
    archive = make_zip({"z1.pdf": make_pdf("ZIP-1"), "skip.txt": b"x"})
    files = [
        ("files", ("p1.pdf", make_pdf("BATCH-1"), "application/pdf")),
        ("files", ("p2.pdf", make_pdf("BATCH-2"), "application/pdf")),
        ("files", ("pack.zip", archive, "application/zip")),
    ]
    r = client.post("/api/invoices/batch", files=files, headers=REVIEWER)
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["total"] == 4 and b["counts"]["skipped"] == 1
    done = wait_batch(client, b["batch_id"])
    statuses = {i["filename"]: i for i in done["items"]}
    assert statuses["p1.pdf"]["status"] == "done" and statuses["p1.pdf"]["run_id"]
    assert statuses["p2.pdf"]["status"] == "done"
    assert statuses["z1.pdf"]["status"] == "done" and statuses["z1.pdf"]["source"] == "zip:pack.zip"
    assert statuses["skip.txt"]["status"] == "skipped"
    # every processed document is a normal run in the inbox
    runs = client.get("/api/runs", headers=REVIEWER).json()
    names = {r["filename"] for r in runs}
    assert {"p1.pdf", "p2.pdf", "z1.pdf"} <= names
    assert client.get("/api/batches", headers=REVIEWER).json()[0]["batch_id"] == b["batch_id"]


def test_batch_same_file_twice_is_a_duplicate_not_a_crash(client):
    pdf = make_pdf("DUP-1")
    files = [("files", ("a.pdf", pdf, "application/pdf")), ("files", ("copy.pdf", pdf, "application/pdf"))]
    b = client.post("/api/invoices/batch", files=files, headers=REVIEWER).json()
    done = wait_batch(client, b["batch_id"])
    routes = sorted(i["route"] for i in done["items"])
    assert "REJECT" in routes and all(i["status"] == "done" for i in done["items"])


def test_batch_is_reviewer_only_and_rejects_empty(client):
    files = [("files", ("p.pdf", make_pdf("R-1"), "application/pdf"))]
    assert client.post("/api/invoices/batch", files=files, headers=ADMIN).status_code == 403
    assert client.post("/api/invoices/batch", files=files).status_code == 401
    bad = client.post("/api/invoices/batch", files=[("files", ("n.txt", b"x", "text/plain"))], headers=REVIEWER)
    assert bad.status_code == 422
    assert client.get("/api/batches/batch_nope", headers=REVIEWER).status_code == 404


def test_sources_report_not_connected(client, monkeypatch):
    for k in ("GCS_BUCKET", "GDRIVE_FOLDER_ID", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_SERVICE_ACCOUNT_JSON"):
        monkeypatch.delenv(k, raising=False)
    srcs = {s["kind"]: s for s in client.get("/api/sources", headers=REVIEWER).json()}
    assert set(srcs) == {"folder", "link", "mail", "gcs", "gdrive"}  # onboarding exposes connection setup
    for k in ("gcs", "mail"):
        assert srcs[k]["configured"] is False and srcs[k]["reason"] and srcs[k]["setup"]
    assert srcs["folder"]["configured"] and srcs["link"]["configured"]
    assert client.get("/api/sources/gcs/files", headers=REVIEWER).status_code == 501
    assert client.post("/api/sources/gdrive/import", json={"ids": ["x"]}, headers=REVIEWER).status_code == 501
    assert client.get("/api/sources/dropbox/files", headers=REVIEWER).status_code == 404
