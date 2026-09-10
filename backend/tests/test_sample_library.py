"""The sample library must demonstrate what it says: every generated sample
reaches the outcome its manifest promises (offline, model stubbed)."""
import json
from pathlib import Path

import pytest

import app.pipeline as pipeline
from app.db import connect
from app.main import seed_if_empty, sample_manifest
from app.policy import DEFAULT_POLICY
from tests.test_pipeline import stub_extract

SAMPLES = Path(__file__).resolve().parents[2] / "fixtures" / "pdfs"
ROUTE_TO_EXPECT = {"AUTO_APPROVE": "approved", "APPROVE_WITH_EXCEPTION": "approved",
                   "HOLD_REVIEW": "held", "REJECT": "rejected"}


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, "extract_native", stub_extract)
    conn = connect(str(tmp_path / "app.db"))
    seed_if_empty(conn)
    yield conn, str(tmp_path)
    conn.close()


def test_manifest_lists_every_file_and_covers_every_outcome():
    entries = sample_manifest()
    names = {e["name"] for e in entries}
    on_disk = {p.name for p in SAMPLES.glob("*") if p.suffix in (".pdf", ".zip")}
    assert on_disk <= names
    assert {e["expect"] for e in entries} >= {"approved", "held", "rejected", "failed", "mixed"}
    assert len({e["category"] for e in entries}) >= 6
    assert all(e["title"] and e["blurb"] for e in entries)


def test_generated_samples_reach_their_promised_outcome(env):
    conn, data_dir = env
    manifest = json.loads((SAMPLES / "samples.json").read_text())
    checked = 0
    for entry in manifest:  # manifest order matters: duplicates follow their originals
        name = entry["name"]
        if entry["expect"] in ("varies", "mixed") or name == "40-scanned-invoice.pdf":
            continue  # real-world scans and the image-only page need the vision model
        try:
            result = pipeline.process_document(conn, str(SAMPLES / name), name, DEFAULT_POLICY, data_dir)
            got = ROUTE_TO_EXPECT[result.decision.route.value]
        except pipeline.OperationalFailure:
            got = "failed"
        assert got == entry["expect"], f"{name}: expected {entry['expect']}, got {got}"
        checked += 1
    assert checked >= 20
