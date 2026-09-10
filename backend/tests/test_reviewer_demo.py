import json
import zipfile
from pathlib import Path

from app.automation import saved_confidence
from app.db import connect
from app.main import seed_if_empty, sample_manifest
from app.pipeline import process_document
from app.policy import DEFAULT_POLICY
from tests.test_pipeline import stub_extract

ROOT = Path(__file__).resolve().parents[2]


def test_starter_kit_real_pipeline_and_seed(tmp_path, monkeypatch):
    monkeypatch.setattr('app.pipeline.extract_native', stub_extract)
    conn = connect(str(tmp_path / 'test.db'))
    seed_if_empty(conn)
    seed_if_empty(conn)
    entries = [e for e in sample_manifest() if e.get('onboarding')]
    bundle = next(e for e in entries if e.get('recommended'))
    with zipfile.ZipFile(ROOT / 'fixtures/pdfs' / bundle['name']) as z:
        assert z.namelist() == bundle['members']
        assert len(z.namelist()) == 7
    for e in entries:
        if e['name'].endswith('.zip'):
            continue
        result = process_document(conn, str(ROOT / 'fixtures/pdfs' / e['name']), e['name'], DEFAULT_POLICY, str(tmp_path))
        disposition = conn.execute('SELECT disposition FROM runs WHERE run_id=?', (result.run_id,)).fetchone()[0]
        assert disposition == e['expect'], (e['name'], result.decision.codes)
        if '05-totals' in e['name'] or '06-date' in e['name']:
            assert saved_confidence(conn, result.run_id)['band'] == 'low'
        if e['expect'] == 'approved':
            assert result.posted and saved_confidence(conn, result.run_id)['band'] == 'high'
    assert {r['kind'] for r in conn.execute("SELECT kind FROM tickets WHERE requested_by='invoice-ai'")} == {'onboard_supplier', 'raise_po'}
    assert conn.execute("SELECT count(*) FROM ledger_events WHERE kind='posting'").fetchone()[0] == 2
    conn.close()


def test_public_dataset_only_contains_archive_members_without_predictions():
    from app.main import list_samples
    entries = list_samples()
    bundle = next(e for e in entries if e.get('recommended'))
    assert {e['name'] for e in entries} == set(bundle['members']) | {bundle['name']}
    assert len(entries) == 8
    assert all('expect' not in e and 'next_step' not in e for e in entries)
    assert all('DEMO-' in e['title'] for e in entries if e['name'].endswith('.pdf') and '07-' not in e['name'])
