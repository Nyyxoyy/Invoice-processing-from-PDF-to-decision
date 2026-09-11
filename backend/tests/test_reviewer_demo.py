import json
import zipfile
from pathlib import Path

from app.automation import saved_confidence
from app.db import connect
from app.main import seed_if_empty, sample_manifest
from app.pipeline import process_document
from app.policy import DEFAULT_POLICY
from tests.test_pipeline import TICKET_POLICY, stub_extract

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
    # Under the default setting the unknown supplier (reviewer-03) is rejected
    # outright, so the only unattended request the kit produces is the missing PO.
    assert {r['kind'] for r in conn.execute("SELECT kind FROM tickets WHERE requested_by='invoice-ai'")} == {'raise_po'}
    assert conn.execute("SELECT count(*) FROM ledger_events WHERE kind='posting'").fetchone()[0] == 2
    conn.close()


def test_starter_kit_unknown_supplier_becomes_a_request_under_the_ticket_setting(tmp_path, monkeypatch):
    """Same collection, Unknown suppliers switched to "raise an onboarding
    request": reviewer-03 is held instead of rejected and Invoice AI asks
    procurement to onboard Summit Studio."""
    monkeypatch.setattr('app.pipeline.extract_native', stub_extract)
    conn = connect(str(tmp_path / 'ticket.db'))
    seed_if_empty(conn)
    name = 'reviewer-03-new-supplier.pdf'
    result = process_document(conn, str(ROOT / 'fixtures/pdfs' / name), name, TICKET_POLICY, str(tmp_path))
    assert conn.execute('SELECT disposition FROM runs WHERE run_id=?',
                        (result.run_id,)).fetchone()[0] == 'held'
    ticket = conn.execute("SELECT * FROM tickets WHERE requested_by='invoice-ai'").fetchone()
    assert ticket['kind'] == 'onboard_supplier' and 'Summit Studio' in ticket['note']
    conn.close()


def test_dataset_suppliers_are_registered_except_the_two_demo_unknowns(tmp_path):
    """Every supplier the shipped dataset names is in the register, so a first
    run stalls on a real defect rather than on missing demo data. The two
    fixtures for the unknown-supplier path must stay absent."""
    from app.pipeline import resolve_vendor
    conn = connect(str(tmp_path / 'seed.db'))
    seed_if_empty(conn)
    for name in ('Harbor Office Supplies', 'Cedar Cloud Services', 'Bioplex',
                 'Vortex Consulting GmbH', 'Northwind Supplies LLC', 'Globex Industrial',
                 'Initech Services', 'Zencorporations'):
        assert resolve_vendor(conn, name) is not None, name
    for absent in ('Acme Widgets Ltd', 'Summit Studio'):
        assert resolve_vendor(conn, absent) is None, absent
    conn.close()


def test_public_dataset_only_contains_archive_members_without_predictions():
    from app.main import list_samples
    entries = list_samples()
    bundle = next(e for e in entries if e.get('recommended'))
    assert {e['name'] for e in entries} == set(bundle['members']) | {bundle['name']}
    assert len(entries) == 8
    assert all('expect' not in e and 'next_step' not in e for e in entries)
    assert all('DEMO-' in e['title'] for e in entries if e['name'].endswith('.pdf') and '07-' not in e['name'])


def test_the_image_ships_every_file_the_dataset_page_needs():
    """The onboarding collection is a catalogue (reviewer-demo.json) plus the
    PDFs it names. Ship one without the other and /api/samples returns nothing,
    which the dataset page can only render as "collection unavailable" — a
    break that never shows up locally, where the repo is the filesystem."""
    dockerfile = (ROOT / 'Dockerfile').read_text()
    copied = [line.split()[1] for line in dockerfile.splitlines() if line.startswith('COPY ')]
    for needed in ('fixtures/pdfs', 'fixtures/reviewer-demo.json'):
        assert any(needed == c or needed.startswith(c.rstrip('/') + '/') for c in copied), \
            f'{needed} is not COPYed into the image'
