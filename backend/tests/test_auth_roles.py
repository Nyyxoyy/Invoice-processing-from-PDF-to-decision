"""Server-side role enforcement — the frontend hiding a button is not a control."""
import os
import pytest
from fastapi.testclient import TestClient

import app.main as main_mod


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main_mod, "DATA_DIR", str(tmp_path))
    monkeypatch.delenv("ADMIN_ACCESS_CODE", raising=False)
    monkeypatch.delenv("REVIEWER_ACCESS_CODE", raising=False)
    with TestClient(main_mod.app) as c:
        yield c


ADMIN = {"Authorization": "Bearer admin-demo"}
REVIEWER = {"Authorization": "Bearer reviewer-demo"}


def test_public_and_protected_paths(client):
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/auth/config").json()["open_access"] is True
    assert client.get("/api/runs").status_code == 401                    # no token
    assert client.get("/api/runs", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/api/runs", headers=REVIEWER).status_code == 200
    assert client.get("/api/runs", headers=ADMIN).status_code == 200


def test_role_is_the_token_no_passwords(client):
    """Open demo: the bearer token is the role name; legacy demo codes alias it."""
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer reviewer"}).json()["role"] == "reviewer"
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer admin"}).json()["role"] == "admin"
    assert client.get("/api/auth/me", headers=ADMIN).json()["role"] == "admin"          # alias
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.post("/api/auth/login", json={"code": "x"}).status_code in (404, 405)  # gone


def test_reviewer_cannot_touch_master_data_or_reset(client):
    assert client.post("/api/vendors", json={"name": "New Co"}, headers=REVIEWER).status_code == 403
    assert client.patch("/api/vendors/sup-northwind", json={"status": "blocked"}, headers=REVIEWER).status_code == 403
    assert client.delete("/api/vendors/sup-shady", headers=REVIEWER).status_code == 403
    assert client.post("/api/pos", json={"po_id": "PO-9", "supplier_id": "sup-northwind", "currency": "USD", "amount": "1.00"},
                       headers=REVIEWER).status_code == 403
    assert client.patch("/api/pos/PO-1001", json={"status": "closed"}, headers=REVIEWER).status_code == 403
    assert client.post("/api/admin/reset", headers=REVIEWER).status_code == 403
    assert client.get("/api/queue/procurement", headers=REVIEWER).status_code == 403
    # reads stay open to reviewers
    assert client.get("/api/vendors", headers=REVIEWER).status_code == 200
    assert client.get("/api/pos", headers=REVIEWER).status_code == 200


def test_admin_cannot_approve_or_upload(client):
    """Segregation of duties: the role that creates budget cannot release money."""
    assert client.post("/api/samples/clean-01.pdf/run", headers=ADMIN).status_code == 403
    assert client.post("/api/runs/run_x/review/approve", json={"idempotency_key": "k"}, headers=ADMIN).status_code == 403
    assert client.post("/api/runs/run_x/review/correct", json={"field": "x", "value": "y", "expected_seq": 1}, headers=ADMIN).status_code == 403
    assert client.post("/api/runs/run_x/review/reject", json={"idempotency_key": "k", "reason": "r"}, headers=ADMIN).status_code == 403
    # but admin may read invoices
    assert client.get("/api/runs", headers=ADMIN).status_code == 200


def test_admin_master_data_and_po_guards(client):
    assert client.post("/api/vendors", json={"name": "New Co"}, headers=ADMIN).status_code == 200
    # amend PO amount, cannot go below approved billing (none yet -> any positive ok), close/reopen
    r = client.patch("/api/pos/PO-1001", json={"amount": "12000.00", "status": "closed"}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["amount_minor"] == 1_200_000 and r.json()["status"] == "closed"
    assert client.patch("/api/pos/PO-1001", json={"status": "paused"}, headers=ADMIN).status_code == 422
    assert client.patch("/api/pos/PO-1001", json={"amount": "10.005"}, headers=ADMIN).status_code == 422
    # delete: fresh PO ok, reset works for admin
    assert client.post("/api/pos", json={"po_id": "PO-TMP", "supplier_id": "sup-northwind", "currency": "USD", "amount": "5.00"},
                       headers=ADMIN).status_code == 200
    assert client.delete("/api/pos/PO-TMP", headers=ADMIN).json()["ok"] is True
    assert client.post("/api/admin/reset", headers=ADMIN).status_code == 200
    assert client.get("/api/queue/procurement", headers=ADMIN).status_code == 200


def test_role_query_param_only_on_page_images(tmp_path, monkeypatch):
    monkeypatch.setattr(main_mod, "DATA_DIR", str(tmp_path))
    with TestClient(main_mod.app) as c:
        # <img> cannot send headers: the role may ride the page route's query string, nowhere else
        assert c.get("/api/runs?role=admin").status_code == 401
        assert c.get("/api/runs/nope/page/1?role=reviewer").status_code == 404


def test_master_data_endpoints_settle_requests_and_stamp_the_frontend_version(client, tmp_path):
    """Pins the wiring the UI relies on: master-data writes report the requests
    they completed, every response carries the frontend version, and a request
    the record already satisfies is refused at the API."""
    import fitz
    from app.main import app_version
    r = client.get("/api/health")
    assert r.headers.get("X-App-Version") == app_version() and r.json()["app_version"] == app_version()
    assert client.get("/api/runs", headers=REVIEWER).headers.get("X-App-Version") == app_version()

    # a blocked-supplier invoice with an unblock request
    assert client.post("/api/pos", json={"po_id": "PO-SH-A", "supplier_id": "sup-shady", "currency": "USD", "amount": "5000.00"},
                       headers=ADMIN).status_code == 200
    doc = fitz.open(); page = doc.new_page(); y = 60
    for line in ["Shady Imports Co", "Invoice No: SH-A1", "Invoice Date: 2026-08-28", "PO Reference: PO-SH-A",
                 "Bill To: Acme Corporation", "Currency: USD", "Subtotal: $1,000.00", "Sales Tax: $80.00", "Total: $1,080.00"]:
        page.insert_text((50, y), line, fontsize=11); y += 22
    pdf = tmp_path / "shady.pdf"; doc.save(str(pdf))
    import app.pipeline as pipeline_mod
    from tests.test_pipeline import stub_extract
    real = pipeline_mod.extract_native
    pipeline_mod.extract_native = stub_extract
    try:
        up = client.post("/api/invoices", files={"file": ("shady.pdf", pdf.read_bytes(), "application/pdf")}, headers=REVIEWER)
    finally:
        pipeline_mod.extract_native = real
    assert up.status_code == 200 and up.json()["route"] == "REJECT", up.text
    run_id = up.json()["run_id"]
    tk = client.post("/api/tickets", json={"run_id": run_id, "kind": "unblock_supplier", "note": "genuine"}, headers=REVIEWER)
    assert tk.status_code == 200
    # the master-data write settles it and says so
    patched = client.patch("/api/vendors/sup-shady", json={"status": "approved"}, headers=ADMIN)
    assert patched.status_code == 200
    settled = patched.json()["settled"]
    assert [s["ticket_id"] for s in settled] == [tk.json()["ticket_id"]] and settled[0]["status"] == "resolved"
    assert client.get("/api/tickets?status=open", headers=ADMIN).json() == []
    # nothing-to-request guard at the API: the supplier is approved already
    again = client.post("/api/tickets", json={"run_id": run_id, "kind": "unblock_supplier", "note": "x"}, headers=REVIEWER)
    assert again.status_code == 409 and "Nothing to request" in again.json()["detail"]


def _held_run_in(data_dir, name, **kw):
    """A held run written straight into the DATA_DIR database (no server yet)."""
    import fitz
    from app.db import connect
    from app.main import seed_if_empty
    from app.policy import DEFAULT_POLICY
    import app.pipeline as pipeline_mod
    from tests.test_pipeline import stub_extract
    conn = connect(f"{data_dir}/app.db"); seed_if_empty(conn)
    doc = fitz.open(); page = doc.new_page(); y = 60
    rows = [kw.get("supplier", "Northwind Supplies LLC"), f"Invoice No: {kw.get('invoice_no', 'X-1')}", "Invoice Date: 2026-08-28",
            f"PO Reference: {kw.get('po', 'PO-1001')}", "Bill To: Acme Corporation", "Currency: USD",
            "Subtotal: $1,000.00", "Sales Tax: $80.00", "Total: $1,080.00"]
    for line in rows:
        page.insert_text((50, y), line, fontsize=11); y += 22
    pdf = f"{data_dir}/{name}.pdf"; doc.save(pdf)
    real = pipeline_mod.extract_native; pipeline_mod.extract_native = stub_extract
    try:
        r = pipeline_mod.process_document(conn, pdf, f"{name}.pdf", DEFAULT_POLICY, str(data_dir))
    finally:
        pipeline_mod.extract_native = real
    return conn, r


def test_startup_settles_requests_fulfilled_while_the_server_was_down(tmp_path, monkeypatch):
    """A request fulfilled by master data but never closed (e.g. before auto-
    settlement existed) is closed by 'system' when the server starts."""
    from app.review import create_po, onboard_vendor, open_ticket
    monkeypatch.setattr(main_mod, "DATA_DIR", str(tmp_path))
    monkeypatch.delenv("ADMIN_ACCESS_CODE", raising=False); monkeypatch.delenv("REVIEWER_ACCESS_CODE", raising=False)
    conn, r = _held_run_in(tmp_path, "boot", supplier="Boot Vendor AG", invoice_no="BV-1", po="PO-7700")
    t = open_ticket(conn, r.run_id, "onboard_supplier", "new", "reviewer@demo")
    v = onboard_vendor(conn, "Boot Vendor AG", None, "procurement@demo", run_id=r.run_id)
    create_po(conn, "PO-7700", v["supplier_id"], "USD", "5000.00", "procurement@demo")
    assert conn.execute("SELECT status FROM tickets WHERE ticket_id=?", (t["ticket_id"],)).fetchone()["status"] == "open"
    conn.close()
    with TestClient(main_mod.app) as c:
        tk = c.get(f"/api/tickets?status=all&run_id={r.run_id}", headers=ADMIN).json()[0]
    assert tk["status"] == "resolved" and tk["resolved_by"] == "system" and "approved supplier" in tk["resolution_note"]


def test_reviewer_correction_settles_a_request_through_the_api(client):
    """POST review/correct reports the requests it completed: selecting an
    order the reviewer had asked about is exactly such a case."""
    import fitz, app.pipeline as pipeline_mod
    from tests.test_pipeline import stub_extract
    doc = fitz.open(); page = doc.new_page(); y = 60
    for line in ["Zencorporations", "Invoice No: ZC-API-1", "Invoice Date: 2026-08-28", "PO Reference: PO-9999",
                 "Bill To: Acme Corporation", "Currency: USD", "Subtotal: $1,000.00", "Sales Tax: $80.00", "Total: $1,080.00"]:
        page.insert_text((50, y), line, fontsize=11); y += 22
    import tempfile, os
    fd, pdf = tempfile.mkstemp(suffix=".pdf"); os.close(fd); doc.save(pdf)
    real = pipeline_mod.extract_native; pipeline_mod.extract_native = stub_extract
    try:
        up = client.post("/api/invoices", files={"file": ("zc.pdf", open(pdf, "rb").read(), "application/pdf")}, headers=REVIEWER)
    finally:
        pipeline_mod.extract_native = real
    assert up.status_code == 200 and "NO_PO_MATCH" in up.json()["codes"]
    run_id = up.json()["run_id"]
    tk = client.post("/api/tickets", json={"run_id": run_id, "kind": "raise_po", "note": "need a USD order"}, headers=REVIEWER).json()
    added = client.post("/api/pos", json={"po_id": "PO-2010", "supplier_id": "sup-zencorp", "currency": "USD", "amount": "5000.00"}, headers=ADMIN)
    assert added.status_code == 200 and [s["ticket_id"] for s in added.json()["settled"]] == [tk["ticket_id"]]
    # and a correction that clears a blocker reports 'settled' too (nothing left to settle here → empty list, but present)
    rv = client.get(f"/api/runs/{run_id}/review", headers=REVIEWER).json()
    corrected = client.post(f"/api/runs/{run_id}/review/correct", json={"field": "po_reference", "value": "PO-2010", "expected_seq": rv["revision_seq"]}, headers=REVIEWER)
    assert corrected.status_code == 200 and corrected.json()["settled"] == []


def test_aliases_are_admin_master_data(client):
    assert client.patch("/api/vendors/sup-northwind", json={"add_aliases": ["White Group"]}, headers=REVIEWER).status_code == 403
    r = client.patch("/api/vendors/sup-northwind", json={"add_aliases": ["White Group"]}, headers=ADMIN)
    assert r.status_code == 200 and "white group" in r.json()["aliases"]
    listed = next(v for v in client.get("/api/vendors", headers=REVIEWER).json() if v["supplier_id"] == "sup-northwind")
    assert "white group" in listed["aliases"]
    assert client.patch("/api/vendors/sup-globex", json={"add_aliases": ["white group"]}, headers=ADMIN).status_code == 409


@pytest.mark.parametrize('path', ['/onboarding', '/onboarding/dataset', '/app'])
def test_entry_routes_reload_without_auth_headers(client, path):
    response = client.get(path)
    assert response.status_code == 200
    assert 'text/html' in response.headers['content-type']
    assert '/static/app.js' in response.text
    # Public page shells do not make invoice data public.
    assert client.get('/api/runs').status_code == 401
