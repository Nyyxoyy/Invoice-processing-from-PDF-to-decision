"""The "Unknown suppliers" switch: reject the invoice, or hold it and ask
procurement to onboard. Default is reject — an unknown supplier cannot be paid.

Covers the decision core, the pipeline's tri-state supplier gate, the settings
API, and that a rejection caused only by an absent supplier stays recoverable.
"""
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

import app.pipeline as pipeline
import app.settings as settings
from app.policy import DEFAULT_POLICY, Policy
from app.review import load_latest, onboard_vendor, reevaluate, save_revision
from app.rules import Code, ResolverInput, Route, resolve
from tests.test_pipeline import TICKET_POLICY, env, run_pdf  # noqa: F401  (env is a fixture)

UNKNOWN = "Meridian Freight SARL"


# ---------------------------------------------------------------- decision core

def test_default_policy_rejects_an_unknown_supplier():
    assert DEFAULT_POLICY.unknown_vendor_action == "reject"
    d = resolve(ResolverInput(vendor_resolved=False), DEFAULT_POLICY)
    assert d.route is Route.REJECT and d.codes == (Code.VENDOR_UNKNOWN,)


def test_ticket_setting_holds_the_same_facts():
    d = resolve(ResolverInput(vendor_resolved=False), TICKET_POLICY)
    assert d.route is Route.HOLD_REVIEW and Code.VENDOR_UNKNOWN in d.codes


def test_an_unread_supplier_name_never_rejects():
    """None is uncertainty, not absence. Rejecting on it would turn a bad scan
    into a verdict against the supplier."""
    for policy in (DEFAULT_POLICY, TICKET_POLICY):
        d = resolve(ResolverInput(vendor_resolved=None), policy)
        assert d.route is Route.HOLD_REVIEW and Code.VENDOR_UNKNOWN in d.codes


def test_a_blocked_supplier_still_outranks_an_unknown_one():
    d = resolve(ResolverInput(vendor_resolved=True, vendor_blocked=True), DEFAULT_POLICY)
    assert d.codes == (Code.VENDOR_BLOCKED,)


def test_policy_refuses_an_unsupported_action():
    with pytest.raises(ValueError):
        replace(DEFAULT_POLICY, unknown_vendor_action="ignore")


# -------------------------------------------------------------------- pipeline

def test_pipeline_rejects_by_default_and_raises_no_request(env):
    conn, _ = env
    r = run_pdf(env, "unknown-default", supplier=UNKNOWN, invoice_no="MRD-1")
    assert r.decision.route is Route.REJECT
    assert r.decision.codes == (Code.VENDOR_UNKNOWN,)
    assert not r.posted and r.invoice_id == ""
    assert conn.execute("SELECT disposition FROM runs WHERE run_id=?",
                        (r.run_id,)).fetchone()[0] == "rejected"
    assert conn.execute("SELECT count(*) FROM tickets").fetchone()[0] == 0
    assert "not in the supplier register" in r.explanation


def test_pipeline_holds_and_requests_onboarding_under_the_ticket_setting(env):
    conn, _ = env
    r = run_pdf(env, "unknown-ticket", policy=TICKET_POLICY, supplier=UNKNOWN, invoice_no="MRD-2")
    assert r.decision.route is Route.HOLD_REVIEW
    ticket = conn.execute("SELECT * FROM tickets").fetchone()
    assert ticket["kind"] == "onboard_supplier" and UNKNOWN in ticket["note"]


def test_an_unreadable_supplier_name_holds_even_under_reject(env):
    """A missing name resolves to no vendor, exactly like an unknown one — but
    the register says nothing about it, so it can only be held for a human."""
    conn, _ = env
    r = run_pdf(env, "unreadable", supplier=UNKNOWN, invoice_no="MRD-3")
    _, fields, context = load_latest(conn, r.run_id)
    fields["supplier_name"].status = "missing"
    fields["supplier_name"].raw_value = None
    save_revision(conn, r.run_id, "extraction", None, fields, context)

    out = reevaluate(conn, r.run_id, "reviewer@demo", "idem-unreadable", DEFAULT_POLICY)
    assert out.decision.route is Route.HOLD_REVIEW
    assert Code.VENDOR_UNKNOWN in out.decision.codes


def test_a_rejected_unknown_supplier_is_recoverable_after_onboarding(env):
    """The rejection is not a dead end: once procurement onboards the supplier
    and its order, the same invoice re-evaluates and posts."""
    from app.review import create_po
    conn, _ = env
    r = run_pdf(env, "recoverable", supplier=UNKNOWN, invoice_no="MRD-4", po="MRDPO-1")
    assert r.decision.route is Route.REJECT

    v = onboard_vendor(conn, UNKNOWN, "FR", "procurement@demo", run_id=r.run_id)
    create_po(conn, "MRDPO-1", v["supplier_id"], "USD", "10000.00", "procurement@demo", run_id=r.run_id)
    out = reevaluate(conn, r.run_id, "reviewer@demo", "idem-recover", DEFAULT_POLICY)
    assert out.decision.route is Route.AUTO_APPROVE and out.posted


def test_other_rejections_stay_final(env):
    """Only the supplier-register rejections reopen. A blocked-supplier reject
    already did; a duplicate must not start doing so."""
    from app.review import ReviewError
    conn, data_dir = env
    first = run_pdf(env, "dupe-final")
    path = conn.execute("SELECT bytes_path FROM documents JOIN runs USING(document_id) "
                        "WHERE run_id=?", (first.run_id,)).fetchone()[0]
    second = pipeline.process_document(conn, path, "dupe-final-again.pdf", DEFAULT_POLICY, data_dir)
    assert second.decision.route is Route.REJECT
    with pytest.raises(ReviewError):
        reevaluate(conn, second.run_id, "reviewer@demo", "idem-dupe", DEFAULT_POLICY)


# -------------------------------------------------------------------- settings

@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("INTAKE_FOLDER_DISABLED", "1")
    monkeypatch.setattr(pipeline, "extract_native", lambda *a, **k: (_ for _ in ()).throw(AssertionError()))
    import app.main as main
    monkeypatch.setattr(main, "DATA_DIR", str(tmp_path))
    with TestClient(main.app) as client:
        yield client


def _hdr(role):
    return {"Authorization": f"Bearer {role}"}


def test_settings_default_and_choices(api):
    body = api.get("/api/settings", headers=_hdr("reviewer")).json()
    assert body["unknown_supplier_action"] == "reject"
    assert [c["value"] for c in body["choices"]["unknown_supplier_action"]] == ["reject", "ticket"]


def test_only_procurement_can_change_the_switch(api):
    assert api.patch("/api/settings", json={"unknown_supplier_action": "ticket"},
                     headers=_hdr("reviewer")).status_code == 403
    r = api.patch("/api/settings", json={"unknown_supplier_action": "ticket"}, headers=_hdr("admin"))
    assert r.status_code == 200 and r.json()["unknown_supplier_action"] == "ticket"
    assert settings.current_policy().unknown_vendor_action == "ticket"


def test_an_invalid_action_is_refused_not_ignored(api):
    assert api.patch("/api/settings", json={"unknown_supplier_action": "maybe"},
                     headers=_hdr("admin")).status_code == 422
    assert api.get("/api/settings", headers=_hdr("admin")).json()["unknown_supplier_action"] == "reject"


def test_the_choice_survives_a_restart(api, tmp_path):
    api.patch("/api/settings", json={"unknown_supplier_action": "ticket"}, headers=_hdr("admin"))
    assert settings.init(str(tmp_path))["unknown_supplier_action"] == "ticket"


def test_a_corrupt_settings_file_falls_back_to_the_default(tmp_path):
    (tmp_path / settings.SETTINGS_FILE).write_text("{not json")
    assert settings.init(str(tmp_path))["unknown_supplier_action"] == "reject"
