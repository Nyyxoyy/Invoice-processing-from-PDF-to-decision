"""Stateful invariants: concurrency, duplicate-after-approval, content
conflict, opening balance, idempotency."""
import threading
import uuid

import pytest

from app.db import connect
from app.ledger import canonical_invoice_no, commit_decision, consumed_minor
from app.policy import DEFAULT_POLICY
from app.rules import Code, ResolverInput, Route

WS, BUYER = "demo", "acme-corp"

def seed(conn):
    conn.execute("INSERT INTO vendors (supplier_id, name) VALUES ('sup-1', 'Vendor One')")
    conn.execute("INSERT INTO pos (po_id, supplier_id, currency, amount_minor) VALUES ('po-1', 'sup-1', 'USD', 1000000)")

def new_run(conn, doc_suffix=""):
    doc_id = f"doc_{uuid.uuid4().hex[:8]}{doc_suffix}"
    conn.execute("INSERT INTO documents (document_id, sha256) VALUES (?, ?)", (doc_id, uuid.uuid4().hex))
    run_id = f"run_{uuid.uuid4().hex[:8]}"
    conn.execute("INSERT INTO runs (run_id, document_id, run_status) VALUES (?, ?, 'running')", (run_id, doc_id))
    return run_id

def gates():
    return ResolverInput(vendor_resolved=True, vendor_blocked=False, po_confirmed=True,
                         required_fields_ok=True, arithmetic_ok=True)

def commit(conn, run_id, invoice_no, minor, po="po-1"):
    return commit_decision(conn, run_id=run_id, workspace=WS, buyer=BUYER, supplier_id="sup-1",
                           invoice_no_raw=invoice_no, invoice_minor=minor, currency="USD",
                           po_id=po, gates=gates(), policy=DEFAULT_POLICY)


@pytest.fixture
def db(tmp_path):
    conn = connect(str(tmp_path / "t.db"))
    seed(conn)
    yield conn
    conn.close()


def test_happy_path_posts_and_completes(db):
    r = commit(db, new_run(db), "INV-1", 500000)
    assert r.decision.route == Route.AUTO_APPROVE and r.posted
    row = db.execute("SELECT run_status, disposition FROM runs WHERE run_id=?", (r.run_id,)).fetchone()
    assert (row["run_status"], row["disposition"]) == ("completed", "approved")
    assert consumed_minor(db, "po-1") == 500000


def test_duplicate_after_approval_original_untouched(db):
    r1 = commit(db, new_run(db), "INV-2", 500000)
    assert r1.posted
    r2 = commit(db, new_run(db), "INV-2", 500000)  # same key, same total
    assert r2.decision.route == Route.REJECT
    assert Code.DUP_INVOICE_NO in r2.decision.codes
    assert r2.invoice_id == r1.invoice_id and r2.linked_existing_invoice
    orig = db.execute("SELECT disposition FROM runs WHERE run_id=?", (r1.run_id,)).fetchone()
    assert orig["disposition"] == "approved"          # original untouched
    assert consumed_minor(db, "po-1") == 500000        # balance unchanged


def test_content_conflict_versions_preserved_no_second_posting(db):
    r1 = commit(db, new_run(db), "INV-3", 500000)
    r2 = commit(db, new_run(db), "INV-3", 700000)      # same key, different total
    assert r2.decision.route == Route.HOLD_REVIEW
    assert Code.CONTENT_CONFLICT in r2.decision.codes
    assert consumed_minor(db, "po-1") == 500000
    assert db.execute("SELECT COUNT(*) c FROM runs WHERE invoice_id=?", (r1.invoice_id,)).fetchone()["c"] == 2


def test_concurrent_different_invoices_race_for_budget(tmp_path):
    path = str(tmp_path / "c.db")
    conn = connect(path); seed(conn); run_a, run_b = new_run(conn), new_run(conn); conn.close()
    results = {}
    def worker(name, run_id, inv_no):
        c = connect(path)
        results[name] = commit(c, run_id, inv_no, 700000)  # two $7k on $10k PO
        c.close()
    t1 = threading.Thread(target=worker, args=("a", run_a, "INV-A"))
    t2 = threading.Thread(target=worker, args=("b", run_b, "INV-B"))
    t1.start(); t2.start(); t1.join(); t2.join()
    routes = sorted(r.decision.route for r in results.values())
    assert routes == [Route.AUTO_APPROVE, Route.HOLD_REVIEW]   # exactly one posts
    check = connect(path)
    assert consumed_minor(check, "po-1") == 700000
    check.close()


def test_concurrent_same_invoice_one_posting(tmp_path):
    path = str(tmp_path / "s.db")
    conn = connect(path); seed(conn); run_a, run_b = new_run(conn), new_run(conn); conn.close()
    results = {}
    def worker(name, run_id):
        c = connect(path)
        results[name] = commit(c, run_id, "INV-SAME", 300000)  # balance fits both
        c.close()
    t1 = threading.Thread(target=worker, args=("a", run_a))
    t2 = threading.Thread(target=worker, args=("b", run_b))
    t1.start(); t2.start(); t1.join(); t2.join()
    assert sorted(r.decision.route for r in results.values()) == [Route.AUTO_APPROVE, Route.REJECT]
    check = connect(path)
    assert check.execute("SELECT COUNT(*) c FROM invoices WHERE invoice_no_canonical='INV-SAME'").fetchone()["c"] == 1
    assert check.execute("SELECT COUNT(*) c FROM ledger_events WHERE kind='posting'").fetchone()["c"] == 1
    check.close()


def test_opening_balance_counted_once(db):
    db.execute("INSERT INTO ledger_events (ledger_event_id, invoice_id, po_id, run_id, kind, amount_minor, currency) "
               "VALUES ('led_open', NULL, 'po-1', NULL, 'opening', 900000, 'USD')")
    r = commit(db, new_run(db), "INV-4", 200000)   # cum $11k on $10k, D=$1k > $500
    assert r.decision.route == Route.HOLD_REVIEW
    assert Code.PO_BUDGET_EXCEEDED in r.decision.codes


def test_canonicalization_preserves_leading_zeros():
    assert canonical_invoice_no("  inv 00123 ") == "INV 00123"
    assert canonical_invoice_no("00123") != canonical_invoice_no("123")


def test_pending_hold_does_not_consume(db):
    g = gates(); g.scan_gate = True
    r = commit_decision(db, run_id=new_run(db), workspace=WS, buyer=BUYER, supplier_id="sup-1",
                        invoice_no_raw="INV-5", invoice_minor=500000, currency="USD",
                        po_id="po-1", gates=g, policy=DEFAULT_POLICY)
    assert r.decision.route == Route.HOLD_REVIEW and not r.posted
    assert consumed_minor(db, "po-1") == 0
