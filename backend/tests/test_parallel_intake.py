"""Parallel reading. The model calls for several documents overlap; every
database write — duplicate checks, the ledger — stays under the worker lock.
Parallelism changes wall time, never cost or outcome."""
import threading
import time

import pytest

import app.extractor as extractor
import app.pipeline as pipeline
from app.db import connect
from app.extractor import BudgetExceeded, CallBudget, SelectionList
from app.intake import BatchRegistry, expand_uploads
from app.ledger import consumed_minor
from app.main import seed_if_empty
from app.policy import DEFAULT_POLICY
from app.rules import Route
from tests.test_pipeline import make_pdf, stub_extract


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, "extract_native", stub_extract)
    conn = connect(str(tmp_path / "app.db"))
    seed_if_empty(conn)
    yield conn, str(tmp_path)
    conn.close()


def pdf_bytes(tmp_path, name, **kw) -> bytes:
    path = tmp_path / f"{name}.pdf"
    make_pdf(str(path), **kw)
    return path.read_bytes()


def run_batch(conn, data_dir, parts, concurrency=3, timeout=20):
    registry = BatchRegistry(conn, threading.Lock(), DEFAULT_POLICY, data_dir, concurrency=concurrency)
    batch = registry.start(expand_uploads(parts), "reviewer")
    deadline = time.time() + timeout
    while batch.status != "done" and time.time() < deadline:
        time.sleep(0.02)
    registry.shutdown()
    assert batch.status == "done", "batch did not finish"
    return batch


# ---- the phases ------------------------------------------------------------------

def test_reading_needs_no_database(env, tmp_path):
    """READ takes an Ingest and a data dir — no connection — so it can run on
    any thread while the lock is held by someone else."""
    conn, data_dir = env
    path = str(tmp_path / "r.pdf"); make_pdf(path)
    ingest = pipeline.ingest_document(conn, path, "r.pdf", data_dir, DEFAULT_POLICY)
    assert ingest.result is None and ingest.stored.exists()
    reading = pipeline.read_document(ingest, data_dir)
    assert reading.failure is None and reading.not_invoice is None
    assert "supplier_name" in reading.fields
    assert [e[1] for e in reading.events][:3] == ["classified", "document_type", "attempts"]
    # nothing has reached the run yet: the events are written by DECIDE
    assert conn.execute("SELECT count(*) FROM run_events WHERE run_id=?", (ingest.run_id,)).fetchone()[0] == 0
    result = pipeline.decide_document(conn, ingest, reading, DEFAULT_POLICY)
    assert result.decision.route is Route.AUTO_APPROVE
    kinds = [r[0] for r in conn.execute("SELECT event_type FROM run_events WHERE run_id=? ORDER BY seq", (ingest.run_id,))]
    assert kinds[:3] == ["classified", "document_type", "attempts"] and "decision" in kinds


def test_the_lock_is_released_while_the_model_is_called(env, tmp_path, monkeypatch):
    conn, data_dir = env
    lock = threading.Lock()
    seen = {}

    def observing(rev, budget):
        seen["locked_during_model_call"] = lock.locked()
        return stub_extract(rev, budget)
    monkeypatch.setattr(pipeline, "extract_native", observing)
    path = str(tmp_path / "l.pdf"); make_pdf(path)
    r = pipeline.process_document(conn, path, "l.pdf", DEFAULT_POLICY, data_dir, lock=lock)
    assert r.posted
    assert seen["locked_during_model_call"] is False
    assert not lock.locked()


def test_an_identical_file_never_reaches_the_model(env, tmp_path, monkeypatch):
    conn, data_dir = env
    calls = []
    monkeypatch.setattr(pipeline, "extract_native", lambda rev, budget: calls.append(1) or stub_extract(rev, budget))
    path = str(tmp_path / "d.pdf"); make_pdf(path)
    first = pipeline.process_document(conn, path, "d.pdf", DEFAULT_POLICY, data_dir)
    again = pipeline.process_document(conn, path, "d-again.pdf", DEFAULT_POLICY, data_dir)
    assert first.posted and again.decision.route is Route.REJECT
    assert len(calls) == 1


def test_a_failed_reading_is_recorded_on_the_run_under_the_lock(env, tmp_path):
    conn, data_dir = env
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"%PDF-1.4 not really")
    with pytest.raises(pipeline.OperationalFailure) as e:
        pipeline.process_document(conn, str(bad), "bad.pdf", DEFAULT_POLICY, data_dir, lock=threading.Lock())
    row = conn.execute("SELECT run_status, failure_reason FROM runs WHERE run_id=?", (e.value.run_id,)).fetchone()
    assert row["run_status"] == "failed" and row["failure_reason"].startswith("parse_error")


# ---- the batch -------------------------------------------------------------------

def test_documents_in_a_batch_are_read_concurrently_and_all_commit(env, tmp_path, monkeypatch):
    conn, data_dir = env
    guard, state = threading.Lock(), {"inflight": 0, "peak": 0}

    def slow(rev, budget):
        with guard:
            state["inflight"] += 1
            state["peak"] = max(state["peak"], state["inflight"])
        try:
            time.sleep(0.25)
            return stub_extract(rev, budget)
        finally:
            with guard:
                state["inflight"] -= 1
    monkeypatch.setattr(pipeline, "extract_native", slow)

    # Globex against PO-1002 ($30,000), one invoice per day: four invoices of
    # $6,495 fit inside one order, and distinct dates keep them clear of the
    # same-day duplicate signal. Both are deliberate — the only thing under
    # test here is whether the documents were read at the same time, so nothing
    # else may be the reason one of them does not approve.
    parts = [(f"p{i}.pdf", pdf_bytes(tmp_path, f"p{i}", invoice_no=f"PAR-{i}",
                                     supplier="Globex Industrial", po="PO-1002",
                                     date=f"2026-08-{10 + i:02d}")) for i in range(4)]
    t0 = time.monotonic()
    batch = run_batch(conn, data_dir, parts, concurrency=3)
    elapsed = time.monotonic() - t0

    assert state["peak"] >= 2, "readings never overlapped"
    assert elapsed < 4 * 0.25, f"took {elapsed:.2f}s — sequential"
    assert all(it.status == "done" and it.route == "AUTO_APPROVE" for it in batch.items)
    assert [it.filename for it in batch.items] == [f"p{i}.pdf" for i in range(4)], "item order is the upload order"
    # four postings, one ledger, no double counting
    assert consumed_minor(conn, "PO-1002") == 4 * 649500
    assert conn.execute("SELECT count(*) FROM ledger_events WHERE kind='posting'").fetchone()[0] == 4


def test_the_same_file_twice_in_one_batch_is_read_once(env, tmp_path, monkeypatch):
    conn, data_dir = env
    calls = []
    monkeypatch.setattr(pipeline, "extract_native", lambda rev, budget: calls.append(1) or stub_extract(rev, budget))
    same = pdf_bytes(tmp_path, "same", invoice_no="TWICE-1")
    batch = run_batch(conn, data_dir, [("a.pdf", same), ("copy.pdf", same)])
    routes = sorted(it.route for it in batch.items)
    assert routes == ["AUTO_APPROVE", "REJECT"]
    assert len(calls) == 1
    assert conn.execute("SELECT count(*) FROM ledger_events WHERE kind='posting'").fetchone()[0] == 1


def test_one_broken_reading_fails_its_own_item_only(env, tmp_path, monkeypatch):
    conn, data_dir = env

    def flaky(rev, budget):
        if any("BOOM" in b.text for b in rev.blocks):
            raise RuntimeError("model exploded")
        return stub_extract(rev, budget)
    monkeypatch.setattr(pipeline, "extract_native", flaky)
    parts = [("ok.pdf", pdf_bytes(tmp_path, "ok", invoice_no="OK-1")),
             ("boom.pdf", pdf_bytes(tmp_path, "boom", invoice_no="BOOM-1"))]
    batch = run_batch(conn, data_dir, parts)
    by = {it.filename: it for it in batch.items}
    assert by["ok.pdf"].status == "done" and by["ok.pdf"].route == "AUTO_APPROVE"
    assert by["boom.pdf"].status == "failed" and "RuntimeError" in by["boom.pdf"].reason
    # the failed reading left a failed run, not one stuck "running"
    row = conn.execute("SELECT run_status, failure_reason FROM runs WHERE run_id=?", (by["boom.pdf"].run_id,)).fetchone()
    assert row["run_status"] == "failed" and "unexpected" in row["failure_reason"]


def test_concurrency_comes_from_the_environment(monkeypatch):
    from app.intake import extract_concurrency
    monkeypatch.setenv("EXTRACT_CONCURRENCY", "5")
    assert extract_concurrency() == 5
    monkeypatch.setenv("EXTRACT_CONCURRENCY", "0")
    assert extract_concurrency() == 1, "never fewer than one reader"
    monkeypatch.setenv("EXTRACT_CONCURRENCY", "lots")
    assert extract_concurrency() == 3


# ---- the model gate --------------------------------------------------------------

class _Err(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


class _Resp:
    text = '{"selections": []}'
    usage_metadata = None


def _fake_client(answers):
    class Models:
        def generate_content(self, **kw):
            a = answers.pop(0)
            if isinstance(a, Exception):
                raise a
            return a
    class Client:
        models = Models()
    return Client()


def test_rate_limit_answers_wait_before_the_retry(monkeypatch):
    slept = []
    monkeypatch.setattr(extractor, "_sleep", lambda s: slept.append(s))
    monkeypatch.setattr(extractor, "_client", lambda: _fake_client(
        [_Err(429, "RESOURCE_EXHAUSTED: quota"), _Err(503, "UNAVAILABLE"), _Resp()]))
    budget = CallBudget()
    out = extractor._generate(budget, "extract", extractor.PRIMARY_MODEL, contents=[], schema=SelectionList)
    assert out.selections == []
    assert len(slept) == 2 and 2.0 <= slept[0] < 2.6 and 4.0 <= slept[1] < 4.6, slept
    assert [a.get("backoff_seconds") is not None for a in budget.attempts] == [True, True, False]


def test_other_errors_retry_at_once_and_the_budget_still_bounds_them(monkeypatch):
    slept = []
    monkeypatch.setattr(extractor, "_sleep", lambda s: slept.append(s))
    monkeypatch.setattr(extractor, "_client", lambda: _fake_client(
        [ValueError("bad json"), ValueError("bad json"), ValueError("bad json")]))
    with pytest.raises(BudgetExceeded):
        extractor._generate(CallBudget(), "extract", extractor.PRIMARY_MODEL, contents=[], schema=SelectionList)
    assert slept == []


def test_a_backoff_that_would_overrun_the_wall_clock_is_not_taken(monkeypatch):
    slept = []
    monkeypatch.setattr(extractor, "_sleep", lambda s: slept.append(s))
    monkeypatch.setattr(extractor, "_client", lambda: _fake_client([_Err(429, "quota"), _Resp()]))
    budget = CallBudget(wall_seconds=1.0)
    with pytest.raises(BudgetExceeded):
        extractor._generate(budget, "extract", extractor.PRIMARY_MODEL, contents=[], schema=SelectionList)
    assert slept == []


def test_the_gate_admits_exactly_the_configured_number(monkeypatch):
    monkeypatch.setenv("EXTRACT_CONCURRENCY", "2")
    gate = extractor._gate()
    assert gate.acquire(blocking=False) and gate.acquire(blocking=False)
    assert not gate.acquire(blocking=False), "a third request must wait"
    gate.release(); gate.release()
    monkeypatch.setenv("EXTRACT_CONCURRENCY", "3")
    assert extractor._gate() is not gate, "a changed setting rebuilds the gate"
