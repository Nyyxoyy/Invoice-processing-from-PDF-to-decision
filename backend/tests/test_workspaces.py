"""One workspace per visitor.

A hosted demo has several people in it at once. These tests pin the promise the
product makes them: what you upload is yours, the purchase-order budget you
spend is yours, and the reset button clears your demo and nobody else's.
"""
import fitz
import pytest
from fastapi.testclient import TestClient

import app.main as main_mod
import app.pipeline as pipeline
from app.workspaces import DEFAULT_WORKSPACE, shared_dir, valid_id
from tests.test_pipeline import make_pdf, stub_extract

ALICE = {"Authorization": "Bearer reviewer-demo", "X-Workspace": "alice-workspace-1"}
BOB = {"Authorization": "Bearer reviewer-demo", "X-Workspace": "bob-workspace-002"}
ADMIN_A = {"Authorization": "Bearer admin-demo", "X-Workspace": "alice-workspace-1"}
NO_ID = {"Authorization": "Bearer reviewer-demo"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main_mod, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(pipeline, "extract_native", stub_extract)
    monkeypatch.setenv("INTAKE_FOLDER_DISABLED", "1")
    with TestClient(main_mod.app) as c:
        yield c


def invoice(tmp_path, name, **kw) -> bytes:
    path = tmp_path / f"{name}.pdf"
    make_pdf(str(path), **kw)
    return path.read_bytes()


def junk() -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    y = 60
    for line in ["Jane Doe — Curriculum Vitae", "Senior Software Engineer",
                 "Skills: Python", "References available on request."]:
        page.insert_text((50, y), line, fontsize=11)
        y += 20
    return doc.tobytes()


def upload(client, headers, data, filename="invoice.pdf"):
    return client.post("/api/invoices", headers=headers,
                       files={"file": (filename, data, "application/pdf")})


# ---- identity ---------------------------------------------------------------

def test_an_id_is_a_generated_id_or_nothing():
    assert valid_id("alice-workspace-1") == "alice-workspace-1"
    assert valid_id(DEFAULT_WORKSPACE) == DEFAULT_WORKSPACE
    # a path is never sanitised into an id, it is refused
    assert valid_id("../../etc/passwd") is None
    assert valid_id("a/b") is None
    assert valid_id("short") is None          # too short to be generated
    assert valid_id("x" * 65) is None         # too long
    assert valid_id(None) is None and valid_id("") is None


def test_a_request_without_an_id_gets_the_shared_workspace(client):
    body = client.get("/api/workspace", headers=NO_ID).json()
    assert body["id"] == DEFAULT_WORKSPACE and body["shared"] is True
    # a refused id is not an error; it falls back to the shared workspace
    bad = client.get("/api/workspace", headers={**NO_ID, "X-Workspace": "../escape"}).json()
    assert bad["id"] == DEFAULT_WORKSPACE


def test_each_id_gets_its_own_seeded_demo(client):
    a = client.get("/api/workspace", headers=ALICE).json()
    b = client.get("/api/workspace", headers=BOB).json()
    assert a["id"] != b["id"] and not a["shared"]
    # both start from the same demo data, separately
    assert a["counts"]["suppliers"] == b["counts"]["suppliers"] > 0
    assert a["counts"]["orders"] == b["counts"]["orders"] > 0
    assert a["counts"]["invoices"] == b["counts"]["invoices"] == 0


# ---- isolation --------------------------------------------------------------

def test_one_visitors_invoices_are_invisible_to_another(client, tmp_path):
    assert upload(client, ALICE, junk(), "alice-cv.pdf").status_code == 200
    assert [r["filename"] for r in client.get("/api/runs", headers=ALICE).json()] == ["alice-cv.pdf"]
    assert client.get("/api/runs", headers=BOB).json() == []
    assert client.get("/api/runs", headers=NO_ID).json() == []

    # nor can one be opened from the other, even knowing its run id
    run_id = client.get("/api/runs", headers=ALICE).json()[0]["run_id"]
    assert client.get(f"/api/runs/{run_id}", headers=ALICE).status_code == 200
    assert client.get(f"/api/runs/{run_id}", headers=BOB).status_code == 404


def test_the_purchase_order_budget_is_not_shared(client, tmp_path):
    """The reason isolation matters: on one database two testers would spend the
    same order and neither result would mean anything."""
    pdf = invoice(tmp_path, "big", invoice_no="WS-1")
    for headers in (ALICE, BOB):
        assert upload(client, headers, pdf, "big.pdf").json()["route"] == "AUTO_APPROVE"
    for headers in (ALICE, BOB):
        po = next(p for p in client.get("/api/pos", headers=headers).json() if p["po_id"] == "PO-1001")
        assert po["consumed_minor"] == 649_500, "each workspace spends only its own budget"


def test_the_same_file_in_two_workspaces_is_not_a_duplicate(client, tmp_path):
    """Duplicate detection is per workspace: Bob uploading the file Alice
    already uploaded is Bob's first submission, not a rejected copy."""
    pdf = invoice(tmp_path, "same", invoice_no="WS-2")
    assert upload(client, ALICE, pdf).json()["route"] == "AUTO_APPROVE"
    assert upload(client, BOB, pdf).json()["route"] == "AUTO_APPROVE"
    # and within one workspace it still is a duplicate
    again = upload(client, ALICE, pdf, "copy.pdf").json()
    assert again["route"] == "REJECT" and "DUP_FILE_HASH" in again["codes"]


def test_a_settings_switch_belongs_to_the_workspace_that_set_it(client):
    assert client.patch("/api/settings", json={"unknown_supplier_action": "ticket"},
                        headers=ADMIN_A).status_code == 200
    assert client.get("/api/settings", headers=ALICE).json()["unknown_supplier_action"] == "ticket"
    assert client.get("/api/settings", headers=BOB).json()["unknown_supplier_action"] == "reject"


# ---- reset ------------------------------------------------------------------

def test_reset_clears_only_the_callers_workspace(client, tmp_path):
    pdf = invoice(tmp_path, "keep", invoice_no="WS-3")
    upload(client, ALICE, pdf, "alice.pdf")
    upload(client, BOB, pdf, "bob.pdf")
    assert len(client.get("/api/runs", headers=ALICE).json()) == 1
    assert len(client.get("/api/runs", headers=BOB).json()) == 1

    body = client.post("/api/admin/reset", headers=BOB).json()
    assert body["ok"] is True and body["workspace"] == "bob-workspace-002"
    assert client.get("/api/runs", headers=BOB).json() == []
    assert len(client.get("/api/runs", headers=ALICE).json()) == 1, "Alice's demo was not touched"


def test_reset_restores_the_seeded_demo_and_both_roles_may_run_it(client, tmp_path):
    upload(client, ALICE, invoice(tmp_path, "spend", invoice_no="WS-4"), "spend.pdf")
    for headers in (ALICE, ADMIN_A):    # a workspace belongs to its browser, not to a role
        assert client.post("/api/admin/reset", headers=headers).status_code == 200
    after = client.get("/api/workspace", headers=ALICE).json()["counts"]
    assert after["invoices"] == 0 and after["suppliers"] > 0 and after["orders"] > 0
    po = next(p for p in client.get("/api/pos", headers=ALICE).json() if p["po_id"] == "PO-1001")
    assert po["consumed_minor"] == 0, "the ledger is cleared with the invoices"


def test_each_workspace_keeps_its_files_apart(client, tmp_path):
    upload(client, ALICE, invoice(tmp_path, "files", invoice_no="WS-5"), "files.pdf")
    root = tmp_path / "workspaces"
    assert (root / "alice-workspace-1" / "app.db").exists()
    assert list((root / "alice-workspace-1" / "pdfs").glob("*.pdf")), "the original is stored per workspace"
    assert not (root / "bob-workspace-002").exists(), "an unused workspace is never created"
    assert shared_dir(str(tmp_path)) == root / DEFAULT_WORKSPACE
