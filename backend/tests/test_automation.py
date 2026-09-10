"""Real pipeline, model fixture: confidence routing and unattended handoff."""
import json
from test_pipeline import env, run_pdf
from app.automation import saved_confidence, finish_automation


def test_clean_high_confidence_no_ticket(env):
    conn, _ = env
    result = run_pdf(env, 'auto-clean')
    c = saved_confidence(conn, result.run_id)
    assert c['band'] == 'high' and c['score'] == 100
    assert result.posted
    assert conn.execute('SELECT count(*) FROM tickets').fetchone()[0] == 0


def test_unknown_supplier_and_po_one_combined_request(env):
    conn, _ = env
    result = run_pdf(env, 'auto-new', supplier='New Supplier LLC', po='PO-9876')
    t = conn.execute('SELECT * FROM tickets').fetchone()
    assert t['kind'] == 'onboard_supplier' and t['requested_by'] == 'invoice-ai'
    assert 'PO-9876' in t['note'] and 'New Supplier LLC' in t['note']
    assert not result.posted
    assert saved_confidence(conn, result.run_id)['band'] == 'low'
    finish_automation(conn, result)
    assert conn.execute('SELECT count(*) FROM tickets').fetchone()[0] == 1


def test_missing_po_auto_request_even_with_other_orders(env):
    conn, _ = env
    result = run_pdf(env, 'auto-po', po='PO-9876')
    t = conn.execute('SELECT * FROM tickets').fetchone()
    assert t['kind'] == 'raise_po' and 'PO-9876' in t['note']
    assert saved_confidence(conn, result.run_id)['band'] == 'medium'
    assert not result.posted


def test_unreadable_supplier_does_not_invent_onboarding(env):
    conn, _ = env
    from app.review import load_latest, save_revision
    result = run_pdf(env, 'auto-unreadable', tax='$400.00')
    _, fields, context = load_latest(conn, result.run_id)
    fields['supplier_name'].status = 'missing'
    fields['supplier_name'].raw_value = None
    save_revision(conn, result.run_id, 'extraction', None, fields, context)
    finish_automation(conn, result)
    assert saved_confidence(conn, result.run_id)['band'] == 'low'
    assert conn.execute('SELECT count(*) FROM tickets').fetchone()[0] == 0


def test_bad_totals_never_high_confidence(env):
    conn, _ = env
    result = run_pdf(env, 'auto-math', tax='$400.00')
    c = saved_confidence(conn, result.run_id)
    assert c['supplier_match'] and c['po_match']
    assert c['band'] == 'low' and not result.posted


def test_duplicate_does_not_open_another_ticket(env):
    conn, _ = env
    first = run_pdf(env, 'auto-dupe', supplier='New Supplier LLC')
    from app.pipeline import process_document
    from app.policy import DEFAULT_POLICY
    path = conn.execute('SELECT bytes_path FROM documents JOIN runs USING(document_id) WHERE run_id=?', (first.run_id,)).fetchone()[0]
    process_document(conn, path, 'duplicate.pdf', DEFAULT_POLICY, env[1])
    assert conn.execute('SELECT count(*) FROM tickets').fetchone()[0] == 1
