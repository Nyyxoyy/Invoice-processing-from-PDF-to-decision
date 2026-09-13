"""Regression coverage for history-preserving recovery and the invoice inbox."""
import pytest
from app import main, pipeline, workspaces
from app.db import connect
from app.main import seed_if_empty
from app.policy import DEFAULT_POLICY
from app.review import correct_field, reevaluate, load_latest
from test_pipeline import make_pdf, stub_extract


@pytest.fixture
def recovery_env(tmp_path, monkeypatch):
    """These tests call the endpoint functions directly, with no request to
    carry a workspace id, so one is bound around them by hand."""
    conn = connect(str(tmp_path / 'app.db'))
    seed_if_empty(conn)
    monkeypatch.setattr(pipeline, 'extract_native', stub_extract)
    space = workspaces.Workspace(id='recovery-test', dir=tmp_path, conn=conn)
    token = workspaces.use(space)
    yield conn, tmp_path
    workspaces.release(token)
    conn.close()


def test_retry_keeps_failed_history_and_posts_once(recovery_env, monkeypatch):
    conn, path = recovery_env
    pdf = path / 'invoice.pdf'
    make_pdf(pdf)
    prepare = pipeline.prepare_evidence
    monkeypatch.setattr(pipeline, 'prepare_evidence', lambda _: (_ for _ in ()).throw(ValueError('temporary reader failure')))
    with pytest.raises(pipeline.OperationalFailure) as failure:
        pipeline.process_document(conn, str(pdf), pdf.name, DEFAULT_POLICY, str(path))
    old_id = failure.value.run_id
    monkeypatch.setattr(pipeline, 'prepare_evidence', prepare)
    doc = conn.execute('SELECT * FROM documents').fetchone()
    result = pipeline.process_document(conn, doc['bytes_path'], pdf.name, DEFAULT_POLICY, str(path), retry_of=old_id)
    assert result.posted
    assert conn.execute('SELECT run_status FROM runs WHERE run_id=?', (old_id,)).fetchone()[0] == 'failed'
    assert conn.execute('SELECT parent_run_id FROM runs WHERE run_id=?', (result.run_id,)).fetchone()[0] == old_id
    assert conn.execute('SELECT COUNT(*) FROM documents').fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM ledger_events WHERE kind='posting'").fetchone()[0] == 1
    assert main.run_detail(old_id)['events'][0]['event_type'] == 'operational_failure'
    with pytest.raises(ValueError, match='newer result'):
        pipeline.process_document(conn, doc['bytes_path'], pdf.name, DEFAULT_POLICY, str(path), retry_of=old_id)
    with pytest.raises(ValueError, match='Only a failed reading'):
        pipeline.process_document(conn, doc['bytes_path'], pdf.name, DEFAULT_POLICY, str(path), retry_of=result.run_id)


def test_retry_endpoint_retains_failure_instead_of_deleting(recovery_env, monkeypatch):
    import asyncio
    import threading
    from fastapi import HTTPException
    conn, path = recovery_env
    monkeypatch.setattr(main, 'DATA_DIR', str(path))
    pdf = path / 'broken.pdf'
    pdf.write_bytes(b'%PDF-1.7\nbroken')
    with pytest.raises(pipeline.OperationalFailure) as first:
        pipeline.process_document(conn, str(pdf), pdf.name, DEFAULT_POLICY, str(path))
    with pytest.raises(HTTPException) as second:
        asyncio.run(main.retry_run(first.value.run_id))
    assert second.value.status_code == 422
    child = second.value.detail['run_id']
    assert main.run_detail(child)['parent_run_id'] == first.value.run_id
    assert main.run_detail(child)['run_status'] == 'failed'
    assert conn.execute('SELECT COUNT(*) FROM runs').fetchone()[0] == 2


def test_inbox_summary_and_parent_link_use_latest_saved_revision(recovery_env):
    conn, path = recovery_env
    pdf = path / 'ambiguous-date.pdf'
    make_pdf(pdf, date='03.04.2026')
    original = pipeline.process_document(conn, str(pdf), pdf.name, DEFAULT_POLICY, str(path))
    seq, _, _ = load_latest(conn, original.run_id)
    correct_field(conn, original.run_id, 'invoice_date', '2026-04-03', 'test', seq)
    child = reevaluate(conn, original.run_id, 'test', 'ux-review-1', DEFAULT_POLICY)
    rows = main.list_runs()
    assert rows[0]['run_id'] == child.run_id  # stable when timestamps tie
    assert rows[0]['parent_run_id'] == original.run_id
    assert rows[0]['summary']['invoice_date'] == '2026-04-03'
    assert rows[0]['summary']['supplier_name'] == 'Northwind Supplies LLC'
    assert rows[0]['document_id'] == rows[1]['document_id']


def test_invalid_correction_returns_recovery_hint_without_saving(recovery_env):
    from app.review import ReviewError
    conn, path = recovery_env
    pdf = path / 'invalid-correction.pdf'
    make_pdf(pdf, date='03.04.2026')
    result = pipeline.process_document(conn, str(pdf), pdf.name, DEFAULT_POLICY, str(path))
    seq, fields, _ = load_latest(conn, result.run_id)
    with pytest.raises(ReviewError, match='YYYY-MM-DD') as error:
        correct_field(conn, result.run_id, 'invoice_date', 'not a date', 'test', seq)
    assert error.value.status == 422
    saved_seq, saved_fields, _ = load_latest(conn, result.run_id)
    assert saved_seq == seq
    assert saved_fields['invoice_date'].raw_value == fields['invoice_date'].raw_value


def test_rejection_keeps_invoice_details_in_inbox(recovery_env):
    from app.review import reject
    conn, path = recovery_env
    pdf = path / 'reject-with-context.pdf'
    make_pdf(pdf, date='03.04.2026')
    original = pipeline.process_document(conn, str(pdf), pdf.name, DEFAULT_POLICY, str(path))
    result = reject(conn, original.run_id, 'test', 'Need a corrected invoice', 'ux-reject-1')
    latest = main.list_runs()[0]
    assert latest['run_id'] == result['run_id']
    assert latest['disposition'] == 'rejected'
    assert latest['summary']['supplier_name'] == 'Northwind Supplies LLC'
    assert latest['summary']['invoice_gross_total'] == '$6,495.00'
    assert load_latest(conn, result['run_id'])[1]['invoice_date'].raw_value == '03.04.2026'
