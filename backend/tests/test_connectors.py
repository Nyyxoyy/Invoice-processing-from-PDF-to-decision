"""Connectors that need no cloud account: paste-a-link, watched folder, mailbox status."""
import io
import time
import urllib.request

import pytest
from fastapi.testclient import TestClient

import app.main as main_mod
import app.pipeline as pipeline_mod
from app import connectors
from app.connectors import FolderSource, IntakeError, UrlSource, fetch_link, normalize_link
from tests.test_intake_batch import REVIEWER, ADMIN, make_pdf, make_zip, wait_batch
from tests.test_pipeline import stub_extract


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main_mod, "DATA_DIR", str(tmp_path))
    monkeypatch.setenv("INTAKE_POLL_SECONDS", "2")
    monkeypatch.delenv("INTAKE_DIR", raising=False)
    monkeypatch.setattr(pipeline_mod, "extract_native", stub_extract)
    with TestClient(main_mod.app) as c:
        yield c


# ---- links -------------------------------------------------------------------

def test_share_links_are_rewritten_to_direct_downloads():
    assert normalize_link("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing") == \
        "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp"
    assert normalize_link("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp") == \
        "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp"
    assert normalize_link("https://storage.cloud.google.com/bkt/incoming/a.pdf") == \
        "https://storage.googleapis.com/bkt/incoming/a.pdf"
    assert normalize_link("https://www.dropbox.com/s/x/a.pdf?dl=0").endswith("dl=1")
    assert normalize_link("https://example.com/a.pdf") == "https://example.com/a.pdf"


def test_private_and_non_http_links_are_refused(monkeypatch):
    monkeypatch.delenv("INTAKE_ALLOW_PRIVATE_LINKS", raising=False)
    for bad in ("ftp://example.com/a.pdf", "file:///etc/passwd", "http://127.0.0.1/a.pdf",
                "http://localhost/a.pdf", "http://10.0.0.5/a.pdf", "http://169.254.169.254/latest"):
        with pytest.raises(IntakeError) as e:
            connectors.check_link(bad)
        assert e.value.status == 422


class FakeResponse(io.BytesIO):
    def __init__(self, data, headers):
        super().__init__(data)
        self.headers = headers

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


class FakeOpener:
    def __init__(self, routes):
        self.routes = routes
        self.seen = []

    def open(self, req, timeout=None):
        self.seen.append(req.full_url)
        kind, payload = self.routes[req.full_url]
        if kind == "redirect":
            raise connectors._Redirect(payload)
        data, headers = payload
        return FakeResponse(data, headers)


def test_fetch_link_follows_redirects_and_names_the_file(monkeypatch):
    monkeypatch.setenv("INTAKE_ALLOW_PRIVATE_LINKS", "1")   # fake hosts never resolve
    pdf = make_pdf("LNK-1")
    opener = FakeOpener({
        "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp": ("redirect", "https://dl.example/blob"),
        "https://dl.example/blob": ("body", (pdf, {"Content-Disposition": 'attachment; filename="inv 7.pdf"'})),
        "https://x.example/bundle": ("body", (make_zip({"a.pdf": pdf}), {"Content-Type": "application/zip"})),
        "https://x.example/page": ("body", (b"<html>login</html>", {"Content-Type": "text/html"})),
    })
    name, data = fetch_link("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", opener=opener)
    assert (name, data) == ("inv 7.pdf", pdf)
    name, _ = fetch_link("https://x.example/bundle", opener=opener)
    assert name == "bundle.zip"
    with pytest.raises(IntakeError) as e:
        fetch_link("https://x.example/page", opener=opener)
    assert "not a PDF or ZIP" in e.value.message


def test_link_import_endpoint_starts_a_batch(client, monkeypatch):
    pdf = make_pdf("LNK-2")
    monkeypatch.setattr(connectors, "fetch_link", lambda url, opener=None: ("linked.pdf", pdf))
    monkeypatch.setattr(UrlSource, "fetch", lambda self, urls: [connectors.fetch_link(u) for u in urls])
    r = client.post("/api/sources/link/import", json={"urls": ["https://example.com/x.pdf"]}, headers=REVIEWER)
    assert r.status_code == 200, r.text
    done = wait_batch(client, r.json()["batch_id"])
    assert done["items"][0]["filename"] == "linked.pdf" and done["items"][0]["status"] == "done"
    assert client.post("/api/sources/link/import", json={"urls": []}, headers=REVIEWER).status_code == 422
    assert client.post("/api/sources/link/import", json={"urls": ["https://e.com/x"]}, headers=ADMIN).status_code == 403


# ---- watched folder ------------------------------------------------------------

def test_folder_takes_only_stable_files_and_sorts_them(tmp_path):
    src = FolderSource(str(tmp_path))
    src.ensure_dirs()
    (src.dir / "a.pdf").write_bytes(make_pdf("F-1"))
    (src.dir / "junk.pdf").write_bytes(b"not a pdf")
    (src.dir / "notes.txt").write_bytes(b"ignored")
    assert src.take() == []                     # first sight: size recorded, nothing taken
    parts = src.take()                           # second poll: stable -> taken
    assert [n for n, _ in parts] == ["a.pdf"]
    assert (src.dir / "processed" / "a.pdf").exists()
    assert (src.dir / "rejected" / "junk.pdf").exists()
    assert (src.dir / "notes.txt").exists()      # never touched
    assert src.pending() == []


def test_folder_poller_creates_batches(client, tmp_path):
    folder = tmp_path / "intake"
    assert folder.is_dir()                        # created at startup
    (folder / "drop.pdf").write_bytes(make_pdf("F-2"))
    deadline = time.time() + 15
    while time.time() < deadline:
        batches = client.get("/api/batches", headers=REVIEWER).json()
        if batches and batches[0]["status"] == "done":
            break
        time.sleep(0.2)
    else:
        raise AssertionError("watched folder never produced a finished batch")
    b = batches[0]
    assert b["created_by"] == "watched-folder" and b["items"][0]["filename"] == "drop.pdf"
    assert (folder / "processed" / "drop.pdf").exists()
    st = {s["kind"]: s for s in client.get("/api/sources", headers=REVIEWER).json()}["folder"]
    assert st["configured"] and st["picked_up"] >= 1 and st["pending"] == 0


def test_folder_manual_import_and_listing(client, tmp_path):
    folder = tmp_path / "intake"
    (folder / "now.pdf").write_bytes(make_pdf("F-3"))
    listed = client.get("/api/sources/folder/files", headers=REVIEWER).json()
    assert [f["name"] for f in listed] == ["now.pdf"] or listed == []   # poller may have raced us
    r = client.post("/api/sources/folder/import", json={"ids": []}, headers=REVIEWER)
    assert r.status_code in (200, 404)           # 404 only if the poller already took it
    assert client.post("/api/sources/mail/import", json={"ids": ["1"]}, headers=REVIEWER).status_code == 501


def test_folder_can_be_repointed_from_the_api_and_persists(client, tmp_path):
    new_dir = tmp_path / "Dropbox" / "Invoices"
    r = client.post("/api/sources/folder/settings", json={"dir": str(new_dir)}, headers=REVIEWER)
    assert r.status_code == 200, r.text
    assert r.json()["scope"] == str(new_dir) and r.json()["is_default"] is False
    assert (new_dir / "processed").is_dir() and (new_dir / "rejected").is_dir()
    assert (tmp_path / "intake-settings.json").exists()
    # files dropped into the new folder are the ones listed
    (new_dir / "x.pdf").write_bytes(make_pdf("F-9"))
    assert [f["name"] for f in client.get("/api/sources/folder/files", headers=REVIEWER).json()] == ["x.pdf"]
    # bad inputs are refused with a reason
    assert client.post("/api/sources/folder/settings", json={"dir": "relative/path"}, headers=REVIEWER).status_code == 422
    assert client.post("/api/sources/folder/settings", json={"dir": ""}, headers=REVIEWER).status_code == 422
    # back to default
    r = client.post("/api/sources/folder/settings", json={"reset": True}, headers=REVIEWER)
    assert r.json()["is_default"] is True and r.json()["scope"] == str(tmp_path / "intake")


def test_folder_setting_survives_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(main_mod, "DATA_DIR", str(tmp_path))
    monkeypatch.setenv("INTAKE_FOLDER_DISABLED", "1")
    target = tmp_path / "elsewhere"
    with TestClient(main_mod.app) as c:
        assert c.post("/api/sources/folder/settings", json={"dir": str(target)}, headers=REVIEWER).status_code == 200
    with TestClient(main_mod.app) as c:
        st = {s["kind"]: s for s in c.get("/api/sources", headers=REVIEWER).json()}["folder"]
        assert st["scope"] == str(target)


def test_drive_folder_link_is_parsed_and_listed(monkeypatch):
    from app.connectors import drive_folder_id, list_public_drive_folder
    assert drive_folder_id("https://drive.google.com/drive/folders/1OPkLWn4ZxwNNRsFcdAMvi82qVfXzZrEG?usp=sharing") == \
        "1OPkLWn4ZxwNNRsFcdAMvi82qVfXzZrEG"
    assert drive_folder_id("https://drive.google.com/drive/u/0/folders/1OPkLWn4ZxwNNRsFcdAMvi82qVfXzZrEG") == \
        "1OPkLWn4ZxwNNRsFcdAMvi82qVfXzZrEG"
    assert drive_folder_id("/Users/x/Invoices") is None
    html = ('<div class="flip-entry" id="entry-AAA111bbb222"><div class="flip-entry-title">inv&amp;co.pdf</div></div>'
            '<div class="flip-entry" id="entry-BBB111bbb222"><div class="flip-entry-title">photo.png</div></div>'
            '<div class="flip-entry" id="entry-CCC111bbb222"><div class="flip-entry-title">pack.ZIP</div></div>')
    opener = FakeOpener({"https://drive.google.com/embeddedfolderview?id=F1234567890": ("body", (html.encode(), {}))})
    files = list_public_drive_folder("F1234567890", opener=opener)
    assert [(f["id"], f["name"]) for f in files] == [("AAA111bbb222", "inv&co.pdf"), ("CCC111bbb222", "pack.ZIP")]


def test_folder_setting_accepts_a_drive_folder_and_polls_it(client, tmp_path, monkeypatch):
    pdf = make_pdf("DRV-1")
    listing = [{"id": "AAA111bbb222", "name": "from-drive.pdf", "size": 0, "modified": None}]
    monkeypatch.setattr(connectors, "list_public_drive_folder", lambda fid, opener=None: list(listing))
    monkeypatch.setattr(connectors, "fetch_link", lambda url, opener=None: ("from-drive.pdf", pdf))
    r = client.post("/api/sources/folder/settings",
                    json={"dir": "https://drive.google.com/drive/folders/1OPkLWn4ZxwNNRsFcdAMvi82qVfXzZrEG?usp=sharing"},
                    headers=REVIEWER)
    assert r.status_code == 200, r.text
    st = r.json()
    assert st["remote"] is True and st["pending"] == 1 and "1OPkLWn4Zxw" in st["scope"]
    assert [f["name"] for f in client.get("/api/sources/folder/files", headers=REVIEWER).json()] == ["from-drive.pdf"]
    r = client.post("/api/sources/folder/import", json={"ids": []}, headers=REVIEWER)
    assert r.status_code == 200, r.text
    done = wait_batch(client, r.json()["batch_id"])
    assert done["items"][0]["filename"] == "from-drive.pdf" and done["items"][0]["status"] == "done"
    # already-imported files are not offered again, and the memory survives a restart
    assert client.get("/api/sources/folder/files", headers=REVIEWER).json() == []
    saved = __import__("json").loads((tmp_path / "intake-settings.json").read_text())
    assert saved["drive_folder"] == "1OPkLWn4ZxwNNRsFcdAMvi82qVfXzZrEG" and "AAA111bbb222" in saved["seen_drive_ids"]
    # other clouds: clear message
    bad = client.post("/api/sources/folder/settings", json={"dir": "https://www.dropbox.com/sh/abc"}, headers=REVIEWER)
    assert bad.status_code == 422 and "Google Drive folder links" in bad.json()["detail"]
