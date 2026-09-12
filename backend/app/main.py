"""Minimal API: upload -> decision, runs, run detail. Dashboard UI comes next."""
from __future__ import annotations

import json
import os
import tempfile
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.concurrency import run_in_threadpool

from pydantic import BaseModel

from .db import connect
from .auth import ROLES, auth_gate, current_user, require_admin, require_reviewer
from .normalize import display_values, unusable_reason
from .review import (TICKET_KINDS, ReviewError, attest_fields, budget_forecast, confirm_not_duplicate, correct_field,
                     create_po, delete_po, invoice_gross_minor,
                     delete_vendor, diagnose_run, field_diagnosis, list_tickets, load_latest,
                     onboard_vendor, open_standalone_request, open_ticket, po_candidates, procurement_asks, procurement_queue, reevaluate, reject,
                     resolve_ticket, settle_requests, update_po, update_vendor)
from .pipeline import OperationalFailure, process_document, startup_recovery
from .intake import BatchRegistry, IntakeError, expand_uploads
from .sources import build_sources, describe_sources, get_source
from .ledger import CommitResult
from .policy import UNKNOWN_SUPPLIER_ACTIONS
from . import settings

DATA_DIR = os.environ.get("DATA_DIR", str(Path(__file__).resolve().parents[2] / "data"))
MAX_UPLOAD_BYTES = 10 * 1024 * 1024


def seed_if_empty(conn) -> None:
    from .demo_data import seed_reviewer_demo
    if conn.execute("SELECT COUNT(*) c FROM vendors").fetchone()["c"]:
        seed_reviewer_demo(conn)
        return
    vendors = [
        ("sup-northwind", "Northwind Supplies LLC", "approved", "US", '["northwind supplies llc", "northwind supplies"]'),
        ("sup-globex", "Globex Industrial", "approved", "US", '["globex industrial", "globex"]'),
        ("sup-initech", "Initech Services", "approved", "US", '["initech services", "initech"]'),
        ("sup-shady", "Shady Imports Co", "blocked", "US", '["shady imports co", "shady imports"]'),
        ("sup-zencorp", "Zencorporations", "approved", "DE", '["zencorporations", "zencorporation"]'),
    ]
    conn.executemany("INSERT INTO vendors (supplier_id, name, status, country, aliases) VALUES (?,?,?,?,?)", vendors)
    pos = [
        ("PO-1001", "sup-northwind", "USD", 1_000_000, "open"),   # $10,000
        ("PO-1002", "sup-globex", "USD", 3_000_000, "open"),      # $30,000 split demo
        ("PO-1003", "sup-initech", "USD", 500_000, "open"),       # $5,000
        ("PO-1004", "sup-northwind", "USD", 200_000, "closed"),   # closed PO
        ("PO-2001", "sup-zencorp", "EUR", 500_000, "open"),       # EUR 5,000
    ]
    conn.executemany("INSERT INTO pos (po_id, supplier_id, currency, amount_minor, status) VALUES (?,?,?,?,?)", pos)
    seed_reviewer_demo(conn)


def load_env_file() -> None:
    """Load KEY=value lines from project-root .env when not already set."""
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_env_file()
    Path(DATA_DIR).mkdir(parents=True, exist_ok=True)
    settings.init(DATA_DIR)
    conn = connect(str(Path(DATA_DIR) / "app.db"))
    interrupted = startup_recovery(conn)
    seed_if_empty(conn)
    from .automation import reconcile_non_invoice_holds
    reconcile_non_invoice_holds(conn, settings.current_policy())
    settle_requests(conn, "system")
    app.state.conn = conn
    app.state.work_lock = threading.Lock()  # single bounded worker: one pipeline at a time
    app.state.interrupted_on_boot = interrupted
    app.state.batches = BatchRegistry(conn, app.state.work_lock,
                                      settings.current_policy, DATA_DIR)
    sources = build_sources(DATA_DIR)

    def folder_pickup(parts):
        try:
            app.state.batches.start(expand_uploads(parts), "watched-folder")
        except IntakeError:
            pass  # every part was unusable; the files are already in rejected/
    if os.environ.get("INTAKE_FOLDER_DISABLED") != "1":
        sources["folder"].start(folder_pickup)
    yield
    sources["folder"].stop()
    app.state.batches.shutdown()
    conn.close()


app = FastAPI(title="AP Invoice Decisioning", lifespan=lifespan, dependencies=[Depends(auth_gate)])
app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")


_STATIC_DIR = Path(__file__).parent / "static"


def app_version() -> str:
    """Newest modification time across the frontend files. The page compares
    it with the one it loaded and reloads itself when they differ, so a tab
    left open for hours never keeps running yesterday's JavaScript."""
    newest = 0
    for name in ("index.html", "app.js", "app.css", "workflow.js"):
        try:
            newest = max(newest, int((_STATIC_DIR / name).stat().st_mtime))
        except OSError:
            pass
    return str(newest)


@app.middleware("http")
async def static_no_stale_cache(request, call_next):
    """The frontend is plain static files edited in place; make browsers
    revalidate them on every load so a CSS/JS change is never served stale,
    and stamp every response with the current frontend version."""
    response = await call_next(request)
    if request.url.path.startswith("/static/") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    response.headers["X-App-Version"] = app_version()
    return response


@app.get("/api/auth/config")
def auth_config():
    """Open demo: no passwords. Roles are switched from the top bar and the
    bearer token is the role name; the server enforces each role's limits."""
    return {"open_access": True, "roles": [{"role": r, **meta} for r, meta in ROLES.items()]}


@app.get("/api/auth/me")
def auth_me(user: dict = Depends(current_user)):
    return user


@app.post("/api/invoices")
async def upload_invoice(file: UploadFile, user: dict = Depends(require_reviewer)):
    raw = await file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "file too large")
    if not raw.startswith(b"%PDF"):
        raise HTTPException(422, "not a PDF")
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name
    def work():
        # The lock goes IN, so it covers ingest and the decision but not the
        # model call: a second upload arriving meanwhile is read alongside this
        # one instead of queueing behind it.
        return process_document(app.state.conn, tmp_path, file.filename or "upload.pdf",
                                settings.current_policy(), DATA_DIR, lock=app.state.work_lock)

    try:
        result = await run_in_threadpool(work)
    except OperationalFailure as e:
        raise HTTPException(422, {"run_id": e.run_id, "run_status": "failed", "error": e.reason})
    finally:
        os.unlink(tmp_path)
    return {
        "run_id": result.run_id,
        "invoice_id": result.invoice_id or None,
        "route": result.decision.route.value,
        "codes": [c.value for c in result.decision.codes],
        "explanation": result.explanation,
        "posted": result.posted,
    }


# ---- bulk intake: several PDFs or a ZIP -----------------------------------
class ImportBody(BaseModel):
    ids: list[str] = []
    urls: list[str] = []


def _start_batch(parts: list[tuple[str, bytes]], user: dict) -> dict:
    try:
        items = expand_uploads(parts)
    except IntakeError as e:
        raise HTTPException(e.status, e.message)
    batch = app.state.batches.start(items, user["role"])
    return batch.public()


@app.post("/api/invoices/batch")
async def upload_batch(files: list[UploadFile], user: dict = Depends(require_reviewer)):
    """Many PDFs and/or ZIP archives in one request. Validates and expands
    synchronously, processes in the background; poll GET /api/batches/{id}."""
    parts = [(f.filename or "upload", await f.read()) for f in files]
    return _start_batch(parts, user)


@app.get("/api/batches")
def list_batches(user: dict = Depends(require_reviewer)):
    return app.state.batches.list()


@app.get("/api/batches/{batch_id}")
def batch_detail(batch_id: str):
    batch = app.state.batches.get(batch_id)
    if batch is None:
        raise HTTPException(404, "This batch is no longer tracked. Its finished invoices are in the inbox.")
    return batch.public()


class SettingsBody(BaseModel):
    unknown_supplier_action: str | None = None


UNKNOWN_SUPPLIER_LABELS = {
    "reject": "Reject the invoice automatically",
    "ticket": "Hold it and raise an onboarding request",
}


def _settings_payload() -> dict:
    """Current switches plus the choices, so the UI never hardcodes them."""
    return {**settings.get(),
            "choices": {"unknown_supplier_action": [
                {"value": v, "label": UNKNOWN_SUPPLIER_LABELS[v]} for v in UNKNOWN_SUPPLIER_ACTIONS]}}


@app.get("/api/settings")
def get_settings(user: dict = Depends(current_user)):
    """Readable by both roles: a reviewer needs to know why an invoice from an
    unknown supplier was rejected rather than sent to procurement."""
    return _settings_payload()


@app.patch("/api/settings")
def patch_settings(body: SettingsBody, user: dict = Depends(require_admin)):
    """Procurement owns the supplier register, so it owns this switch too."""
    try:
        settings.update(body.model_dump(exclude_none=True))
    except ValueError as e:
        raise HTTPException(422, str(e))
    return _settings_payload()


@app.get("/api/sources")
def list_sources():
    """Remote intake sources and whether each is connected (see sources.py)."""
    return describe_sources()


@app.get("/api/sources/{kind}/files")
def source_files(kind: str, user: dict = Depends(require_reviewer)):
    try:
        return [f.public() if hasattr(f, "public") else f for f in get_source(kind).list_files()]
    except IntakeError as e:
        raise HTTPException(e.status, e.message)


class FolderSettings(BaseModel):
    dir: str | None = None
    reset: bool = False


@app.post("/api/sources/folder/settings")
def folder_settings(body: FolderSettings, user: dict = Depends(current_user)):
    """Point the watched folder somewhere else (any signed-in user; it is a
    demo workspace setting, not master data). Persisted in DATA_DIR."""
    src = get_source("folder")
    try:
        return src.reset_dir() if body.reset else src.set_dir(body.dir or "")
    except IntakeError as e:
        raise HTTPException(e.status, e.message)


@app.post("/api/sources/{kind}/import")
async def source_import(kind: str, body: ImportBody, user: dict = Depends(require_reviewer)):
    """Import from a connector as a batch. `ids` selects listed files (folder
    entries, mailbox messages, Drive ids, GCS object names); `urls` is for
    the paste-a-link connector. The watched folder accepts an empty selection
    and takes everything waiting."""
    try:
        source = get_source(kind)
        if kind == "link":
            selection = body.urls
            if not selection:
                raise IntakeError(422, "Paste at least one link.")
        else:
            selection = body.ids
            if not selection and kind != "folder":
                raise IntakeError(422, "Choose at least one file to import.")
        parts = await run_in_threadpool(source.fetch, selection[:50])
    except IntakeError as e:
        raise HTTPException(e.status, e.message)
    return _start_batch(parts, user)


@app.get("/api/edge-cases")
def edge_cases():
    """The catalogue of faulty-document cases the product handles, with the
    limits it enforces — served from code so the page never drifts from the
    behaviour."""
    from .edge_cases import catalogue
    return catalogue()


@app.get("/api/edge-cases/result/{name}")
def edge_case_result(name: str):
    """The saved result of one probe upload, rendered by the Edge cases page.
    Nothing is processed: this is the record of a run that already happened."""
    from .edge_cases import saved_result
    result = saved_result(name)
    if result is None:
        raise HTTPException(404, "no such saved result")
    return result


@app.get("/api/edge-cases/fixture/{name}")
def edge_case_fixture(name: str):
    """The exact file the probe uploaded for a case, so a claim can be
    re-checked by hand."""
    from .edge_cases import fixture_path
    path = fixture_path(name)
    if path is None:
        raise HTTPException(404, "no such fixture")
    media = "application/pdf" if path.suffix == ".pdf" else "application/octet-stream"
    return FileResponse(str(path), media_type=media, filename=path.name)


@app.get("/api/runs")
def list_runs():
    rows = app.state.conn.execute(
        "SELECT r.run_id, r.run_status, r.disposition, r.decision_mode, r.kind, "
        "r.failure_reason, r.invoice_id, r.document_id, r.parent_run_id, r.created_at, r.finished_at, r.snapshot_json, d.filename, "
        "(SELECT fields_json FROM field_revisions f WHERE f.run_id=r.run_id ORDER BY seq DESC LIMIT 1) AS fields_json, "
        "(SELECT context_json FROM field_revisions f WHERE f.run_id=r.run_id ORDER BY seq DESC LIMIT 1) AS context_json "
        "FROM runs r JOIN documents d USING (document_id) ORDER BY r.created_at DESC, r.rowid DESC").fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["codes"] = json.loads(item.pop("snapshot_json") or "{}").get("codes", [])
        fields = json.loads(item.pop('fields_json') or '{}')
        context = json.loads(item.pop('context_json') or '{}')
        item['summary'] = {name: rec.get('raw_value') for name, rec in fields.items()}
        if not item['summary'].get('currency'):
            item['summary']['currency'] = (context.get('currency') or {}).get('code')
        from .normalize import display_values
        item['display'] = display_values(item['summary'], (context.get('currency') or {}).get('code'))
        from .automation import saved_confidence
        item['confidence'] = saved_confidence(app.state.conn, item['run_id'])
        result.append(item)
    return result


@app.post('/api/runs/{run_id}/retry')
async def retry_run(run_id: str, as_invoice: bool = False, user: dict = Depends(require_reviewer)):
    """Retry an interrupted/unreadable attempt without erasing its history.
    ``as_invoice`` re-reads a document the type gate rejected as "not an
    invoice", skipping that gate (reviewer override, recorded on the run)."""
    def work():
        with app.state.work_lock:
            row = app.state.conn.execute(
                'SELECT d.bytes_path, d.filename FROM runs r JOIN documents d USING(document_id) WHERE run_id=?',
                (run_id,)).fetchone()
            if row is None:
                raise HTTPException(404, 'Invoice not found')
            try:
                result = process_document(app.state.conn, row['bytes_path'], row['filename'],
                                          settings.current_policy(), DATA_DIR,
                                          retry_of=run_id, as_invoice=as_invoice)
            except ValueError as e:
                raise HTTPException(409, str(e))
            except OperationalFailure as e:
                raise HTTPException(422, {'run_id': e.run_id, 'error': e.reason})
            return {'run_id': result.run_id}
    return await run_in_threadpool(work)


@app.get("/api/runs/{run_id}")
def run_detail(run_id: str):
    run = app.state.conn.execute(
        "SELECT r.*, d.filename FROM runs r JOIN documents d USING (document_id) WHERE r.run_id=?",
        (run_id,)).fetchone()
    if run is None:
        raise HTTPException(404, "no such run")
    events = app.state.conn.execute(
        "SELECT seq, ts, stage, event_type, payload FROM run_events WHERE run_id=? ORDER BY seq", (run_id,)).fetchall()
    out = dict(run)
    from .automation import saved_confidence
    out["confidence"] = saved_confidence(app.state.conn, run_id)
    out["snapshot"] = json.loads(out.pop("snapshot_json") or "null")
    out["events"] = [{**dict(e), "payload": json.loads(e["payload"])} for e in events]
    return out


@app.delete("/api/runs/{run_id}")
def delete_run(run_id: str, user: dict = Depends(require_admin)):
    """Remove one processing attempt. Runs that POSTED money are protected —
    deleting them would falsify the ledger; clear those with a workspace reset.
    Orphaned documents/invoices (no remaining runs, no postings) are removed,
    which also frees the file hash for a fresh re-upload."""
    conn = app.state.conn
    with app.state.work_lock:
        run = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if run is None:
            raise HTTPException(404, "no such run")
        posted = conn.execute(
            "SELECT 1 FROM ledger_events WHERE run_id=? AND kind='posting'", (run_id,)).fetchone()
        if posted:
            raise HTTPException(409, "this run posted an amount to the ledger — posted runs cannot be deleted (use reset to clear the whole demo workspace)")
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute("DELETE FROM tickets WHERE run_id=?", (run_id,))
            conn.execute("DELETE FROM field_revisions WHERE run_id=?", (run_id,))
            conn.execute("DELETE FROM run_events WHERE run_id=?", (run_id,))
            conn.execute("UPDATE runs SET parent_run_id=NULL WHERE parent_run_id=?", (run_id,))
            conn.execute("DELETE FROM runs WHERE run_id=?", (run_id,))
            # orphaned document: no other runs -> remove row + stored file
            doc = conn.execute("SELECT 1 FROM runs WHERE document_id=?", (run["document_id"],)).fetchone()
            if doc is None:
                row = conn.execute("SELECT bytes_path FROM documents WHERE document_id=?",
                                   (run["document_id"],)).fetchone()
                conn.execute("DELETE FROM documents WHERE document_id=?", (run["document_id"],))
                if row and row["bytes_path"]:
                    Path(row["bytes_path"]).unlink(missing_ok=True)
            # orphaned invoice: no runs, no ledger events
            if run["invoice_id"]:
                used = conn.execute(
                    "SELECT 1 FROM runs WHERE invoice_id=? UNION SELECT 1 FROM ledger_events WHERE invoice_id=?",
                    (run["invoice_id"], run["invoice_id"])).fetchone()
                if used is None:
                    conn.execute("DELETE FROM invoices WHERE invoice_id=?", (run["invoice_id"],))
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    return {"ok": True, "deleted": run_id}


@app.get("/api/pos")
def list_pos():
    rows = app.state.conn.execute(
        "SELECT p.po_id, p.supplier_id, p.currency, p.amount_minor, p.status, "
        "COALESCE((SELECT SUM(CASE kind WHEN 'reversal' THEN -amount_minor ELSE amount_minor END) "
        "FROM ledger_events le WHERE le.po_id = p.po_id), 0) AS consumed_minor FROM pos p").fetchall()
    from .review import invoices_by_po
    grouped = invoices_by_po(app.state.conn)
    return [{**dict(r), "invoices": grouped.get(r["po_id"], [])} for r in rows]


class CorrectBody(BaseModel):
    field: str
    value: str
    actor: str = "reviewer@demo"
    expected_seq: int


class AttestBody(BaseModel):
    fields: list[str]
    actor: str = "reviewer@demo"
    expected_seq: int


class DecideBody(BaseModel):
    actor: str = "reviewer@demo"
    idempotency_key: str
    reason: str = ""


def _review_guard(fn):
    def wrapper(*a, **kw):
        with app.state.work_lock:
            try:
                return fn(*a, **kw)
            except ReviewError as e:
                raise HTTPException(e.status, e.message)
    return wrapper


@app.get("/api/runs/{run_id}/review")
def review_view(run_id: str):
    try:
        seq, fields, context = load_latest(app.state.conn, run_id)
    except ReviewError as e:
        raise HTTPException(e.status, e.message)
    diagnosis = diagnose_run(app.state.conn, run_id, fields, context)
    from .pipeline import resolve_vendor
    from .normalize import extract_name, extract_po_refs
    sup = fields.get("supplier_name")
    vendor = resolve_vendor(app.state.conn, extract_name(sup.raw_value) if sup and sup.raw_value else None)
    # budget forecast: for every selectable order, and for the order the invoice references now
    gross_minor, inv_currency = invoice_gross_minor(fields, context)
    candidates = []
    for c in po_candidates(app.state.conn, fields):
        row = app.state.conn.execute("SELECT * FROM pos WHERE po_id=?", (c["po_id"],)).fetchone()
        candidates.append({**c, **{k: v for k, v in budget_forecast(app.state.conn, row, gross_minor, inv_currency, settings.current_policy()).items()
                                   if k in ("remaining_minor", "status", "short_minor")}})
    po_rec = fields.get("po_reference")
    refs = extract_po_refs(po_rec.raw_value) if po_rec and po_rec.raw_value else []
    if po_rec and po_rec.raw_value and app.state.conn.execute("SELECT 1 FROM pos WHERE po_id=?", (po_rec.raw_value.strip(),)).fetchone():
        refs = [po_rec.raw_value.strip()]
    budget = None
    if len(refs) == 1:
        row = app.state.conn.execute("SELECT * FROM pos WHERE po_id=?", (refs[0],)).fetchone()
        if row is not None and vendor is not None and row["supplier_id"] == vendor["supplier_id"]:
            budget = {**budget_forecast(app.state.conn, row, gross_minor, inv_currency, settings.current_policy()),
                      "gross_minor": gross_minor}
    return {
        "po_supplier_id": vendor["supplier_id"] if vendor else None,
        "revision_seq": seq,
        "fields": {f: {**vars(r), "problem": diagnosis["field_problems"].get(f),
                       # a scan reading can only be attested when it has one legal reading
                       "attestable": r.read_method == "llm_vision" and r.status == "selected"
                                     and unusable_reason(f, r.raw_value) is None}
                   for f, r in fields.items()},
        "context": context,
        "po_candidates": candidates,
        "budget": budget,
        "display": display_values({n: r.raw_value for n, r in fields.items()}, (context.get("currency") or {}).get("code")),
        "diagnosis": diagnosis,
        # what procurement still owes here (empty = the rest is the reviewer's)
        "procurement_needs": procurement_asks(app.state.conn, fields, context, diagnosis),
    }


@app.post("/api/runs/{run_id}/review/correct")
def review_correct(run_id: str, body: CorrectBody, user: dict = Depends(require_reviewer)):
    seq = _review_guard(correct_field)(
        app.state.conn, run_id, body.field, body.value, user["actor"], body.expected_seq)
    return {"revision_seq": seq, "settled": _settle(user["actor"])}


@app.post("/api/runs/{run_id}/review/attest")
def review_attest(run_id: str, body: AttestBody, user: dict = Depends(require_reviewer)):
    return {"revision_seq": _review_guard(attest_fields)(
        app.state.conn, run_id, body.fields, user["actor"], body.expected_seq)}


class DistinctBody(BaseModel):
    note: str
    expected_seq: int


@app.post("/api/runs/{run_id}/review/confirm-distinct")
def review_confirm_distinct(run_id: str, body: DistinctBody, user: dict = Depends(require_reviewer)):
    return {"revision_seq": _review_guard(confirm_not_duplicate)(
        app.state.conn, run_id, user["actor"], body.note, body.expected_seq)}


@app.post("/api/runs/{run_id}/review/approve")
def review_approve(run_id: str, body: DecideBody, user: dict = Depends(require_reviewer)):
    result = _review_guard(reevaluate)(
        app.state.conn, run_id, user["actor"], body.idempotency_key, settings.current_policy())
    if isinstance(result, CommitResult):
        return {"run_id": result.run_id, "invoice_id": result.invoice_id or None,
                "route": result.decision.route.value,
                "codes": [c.value for c in result.decision.codes],
                "explanation": result.explanation, "posted": result.posted}
    return result


@app.post("/api/runs/{run_id}/review/reject")
def review_reject(run_id: str, body: DecideBody, user: dict = Depends(require_reviewer)):
    return _review_guard(reject)(
        app.state.conn, run_id, user["actor"], body.reason or "reviewer rejection", body.idempotency_key)


@app.post("/api/admin/reset")
def demo_reset(user: dict = Depends(require_admin)):
    """Wipe demo workspace and reseed. Local demo convenience; a hosted deploy
    gates this behind reviewer sign-in."""
    conn = app.state.conn
    with app.state.work_lock:
        conn.execute("BEGIN IMMEDIATE")
        try:
            for table in ("field_revisions", "run_events", "ledger_events", "tickets", "runs", "invoices",
                          "documents", "pos", "vendors"):
                conn.execute(f"DELETE FROM {table}")
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        seed_if_empty(conn)
        # stored originals and extraction evidence belong to the rows just removed
        removed = 0
        for sub in ("pdfs", "evidence"):
            folder = Path(DATA_DIR) / sub
            if folder.is_dir():
                for f in folder.iterdir():
                    if f.is_file():
                        f.unlink()
                        removed += 1
        if getattr(app.state, "batches", None) is not None:
            app.state.batches._batches.clear()
    return {"ok": True, "files_removed": removed}


@app.get("/")
@app.get("/onboarding")
@app.get("/onboarding/dataset")
@app.get("/app")
def index():
    return FileResponse(Path(__file__).parent / "static" / "index.html")


def _run_doc_path(run_id: str) -> str:
    row = app.state.conn.execute(
        "SELECT d.bytes_path FROM runs r JOIN documents d USING (document_id) WHERE r.run_id=?",
        (run_id,)).fetchone()
    if row is None or not row["bytes_path"]:
        raise HTTPException(404, "no document for this run")
    return row["bytes_path"]


@app.get("/api/runs/{run_id}/document")
def run_document(run_id: str):
    """Page geometry + evidence blocks so the UI can overlay field locations."""
    path = _run_doc_path(run_id)
    ev = app.state.conn.execute(
        "SELECT payload FROM run_events WHERE run_id=? AND event_type='classified'", (run_id,)).fetchone()
    blocks = []
    if ev:
        rev_id = json.loads(ev["payload"]).get("extraction_revision_id")
        rev_file = Path(DATA_DIR) / "evidence" / f"{rev_id}.json"
        if rev_file.exists():
            blocks = json.loads(rev_file.read_text()).get("blocks", [])
    import fitz
    doc = fitz.open(path)
    try:
        pages = [{"page": i + 1, "width": doc[i].rect.width, "height": doc[i].rect.height}
                 for i in range(len(doc))]
    finally:
        doc.close()
    return {"pages": pages, "blocks": blocks}


@app.get("/api/runs/{run_id}/page/{page}")
def run_page_png(run_id: str, page: int):
    from .evidence import render_page_png
    path = _run_doc_path(run_id)
    try:
        png = render_page_png(path, page, dpi=120)
    except Exception:
        raise HTTPException(404, "page not renderable")
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "max-age=3600"})


class VendorBody(BaseModel):
    name: str
    country: str | None = None
    actor: str = "procurement@demo"
    run_id: str | None = None


class POBody(BaseModel):
    po_id: str
    supplier_id: str
    currency: str
    amount: str
    actor: str = "procurement@demo"
    run_id: str | None = None


def _settle(actor: str) -> list:
    """Settlement writes to the shared connection, so it takes the same worker
    lock every other write takes (the guarded call has released it by now)."""
    with app.state.work_lock:
        return settle_requests(app.state.conn, actor)


def _with_settled(result: dict, actor: str) -> dict:
    """Attach the requests that this master-data change completed."""
    return {**result, "settled": _settle(actor)}


@app.post("/api/vendors")
def add_vendor(body: VendorBody, user: dict = Depends(require_admin)):
    out = _review_guard(onboard_vendor)(app.state.conn, body.name, body.country, user["actor"], body.run_id)
    return _with_settled(out, user["actor"])


@app.post("/api/pos")
def add_po(body: POBody, user: dict = Depends(require_admin)):
    out = _review_guard(create_po)(app.state.conn, body.po_id, body.supplier_id, body.currency,
                                   body.amount, user["actor"], body.run_id)
    return _with_settled(out, user["actor"])


class POPatch(BaseModel):
    amount: str | None = None
    status: str | None = None


@app.patch("/api/pos/{po_id}")
def edit_po(po_id: str, body: POPatch, user: dict = Depends(require_admin)):
    out = _review_guard(update_po)(app.state.conn, po_id, amount=body.amount, status=body.status,
                                   actor=user["actor"])
    return _with_settled(out, user["actor"])


@app.delete("/api/pos/{po_id}")
def remove_po(po_id: str, user: dict = Depends(require_admin)):
    return _review_guard(delete_po)(app.state.conn, po_id)


@app.get("/api/queue/procurement")
def queue_procurement(user: dict = Depends(require_admin)):
    with app.state.work_lock:
        return procurement_queue(app.state.conn)


class TicketBody(BaseModel):
    run_id: str
    kind: str
    note: str = ""


class StandaloneRequestBody(BaseModel):
    kind: str                      # onboard_supplier | raise_po
    subject: str | None = None     # supplier name to onboard
    supplier_id: str | None = None # supplier the order is for
    amount: str | None = None      # requested order amount (raise_po)
    currency: str | None = None
    note: str = ""


@app.post("/api/requests")
def create_standalone_request(body: StandaloneRequestBody, user: dict = Depends(require_reviewer)):
    return _review_guard(open_standalone_request)(app.state.conn, body.kind, body.note, user["actor"],
                                                  subject=body.subject, supplier_id=body.supplier_id,
                                                  amount=body.amount, currency=body.currency)


class TicketResolveBody(BaseModel):
    outcome: str  # resolved | declined
    note: str = ""


@app.get("/api/tickets/kinds")
def ticket_kinds(user: dict = Depends(current_user)):
    return [{"kind": k, "label": v} for k, v in TICKET_KINDS.items()]


@app.post("/api/tickets")
def create_ticket(body: TicketBody, user: dict = Depends(require_reviewer)):
    return _review_guard(open_ticket)(app.state.conn, body.run_id, body.kind, body.note, user["actor"])


@app.get("/api/tickets")
def get_tickets(status: str = "open", run_id: str | None = None, document_id: str | None = None,
                user: dict = Depends(current_user)):
    return list_tickets(app.state.conn, status=status, run_id=run_id, document_id=document_id)


@app.post("/api/tickets/{ticket_id}/resolve")
def close_ticket(ticket_id: str, body: TicketResolveBody, user: dict = Depends(require_admin)):
    return _review_guard(resolve_ticket)(app.state.conn, ticket_id, body.outcome, body.note, user["actor"])


class VendorPatch(BaseModel):
    name: str | None = None
    country: str | None = None
    status: str | None = None
    aliases: list[str] | None = None       # replace the supplier's other names
    add_aliases: list[str] | None = None   # tie another name (subsidiary, brand) to this supplier
    run_id: str | None = None              # audit the change on an invoice
    actor: str = "procurement@demo"


@app.patch("/api/vendors/{supplier_id}")
def edit_vendor(supplier_id: str, body: VendorPatch, user: dict = Depends(require_admin)):
    out = _review_guard(update_vendor)(app.state.conn, supplier_id, name=body.name,
                                       country=body.country, status=body.status, aliases=body.aliases,
                                       add_aliases=body.add_aliases, actor=user["actor"], run_id=body.run_id)
    return _with_settled(out, user["actor"])


@app.delete("/api/vendors/{supplier_id}")
def remove_vendor(supplier_id: str, user: dict = Depends(require_admin)):
    return _review_guard(delete_vendor)(app.state.conn, supplier_id)


@app.get("/api/vendors")
def list_vendors():
    rows = app.state.conn.execute(
        "SELECT v.supplier_id, v.name, v.status, v.country, v.aliases, "
        "(SELECT COUNT(*) FROM pos p WHERE p.supplier_id = v.supplier_id AND p.status='open') AS open_pos, "
        "(SELECT COUNT(*) FROM pos p WHERE p.supplier_id = v.supplier_id) AS total_pos, "
        "(SELECT COUNT(*) FROM invoices i WHERE i.supplier_id = v.supplier_id) AS invoices "
        "FROM vendors v ORDER BY v.name").fetchall()
    from .review import vendor_aliases
    return [{**{k: r[k] for k in r.keys() if k != "aliases"}, "aliases": vendor_aliases(r)} for r in rows]


@app.get("/api/audit")
def audit_feed(limit: int = 100):
    rows = app.state.conn.execute(
        "SELECT e.run_id, e.seq, e.ts, e.stage, e.event_type, e.payload, d.filename "
        "FROM run_events e JOIN runs r USING (run_id) JOIN documents d USING (document_id) "
        "ORDER BY e.ts DESC, e.run_id, e.seq DESC LIMIT ?", (min(limit, 300),)).fetchall()
    return [{**dict(r), "payload": json.loads(r["payload"])} for r in rows]


SAMPLES_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "pdfs"


def sample_manifest() -> list[dict]:
    """The sample library: one PDF per situation a reviewer can meet, generated
    by tools/make_samples.py with a manifest (title, blurb, category, expected
    outcome). Files present on disk but not in the manifest are listed too."""
    manifest_path = SAMPLES_DIR / "samples.json"
    entries: list[dict] = []
    if manifest_path.exists():
        try:
            entries = [e for e in json.loads(manifest_path.read_text()) if (SAMPLES_DIR / e["name"]).exists()]
        except (ValueError, KeyError):
            entries = []
    demo_catalog = SAMPLES_DIR.parent / "reviewer-demo.json"
    if demo_catalog.exists():
        demo_entries = json.loads(demo_catalog.read_text())
        demo_names = {e["name"] for e in demo_entries}
        entries = [e for e in entries if e["name"] not in demo_names]
        entries.extend(e for e in demo_entries if (SAMPLES_DIR / e["name"]).is_file())
    listed = {e["name"] for e in entries}
    if SAMPLES_DIR.exists():
        for f in sorted(SAMPLES_DIR.glob("*")):
            if f.suffix.lower() in (".pdf", ".zip") and f.name not in listed:
                entries.append({"name": f.name, "title": f.stem.replace("-", " ").replace("_", " "),
                                "blurb": "Sample document", "category": "Other samples", "expect": "varies"})
    return entries


def _sample_path(name: str) -> Path:
    path = (SAMPLES_DIR / name).resolve()
    if not str(path).startswith(str(SAMPLES_DIR.resolve())) or not path.is_file():
        raise HTTPException(404, "no such sample")
    return path


class SampleBatchBody(BaseModel):
    names: list[str]


@app.get("/api/samples")
def list_samples():
    entries = sample_manifest()
    bundles = [e for e in entries if e.get("onboarding") and e.get("members")]
    included = {name for b in bundles for name in [b["name"], *b["members"]]}
    # Keep internal expected outcomes out of the public catalog.
    return [{k: v for k, v in e.items() if k not in ("expect", "next_step")}
            for e in entries if e["name"] in included]


@app.get("/api/samples/{name}/download")
def download_sample(name: str):
    if name not in {e["name"] for e in list_samples()}:
        raise HTTPException(404, "no such sample")
    path = _sample_path(name)
    return FileResponse(path, media_type="application/zip" if path.suffix == ".zip" else "application/pdf", filename=path.name)


@app.post("/api/samples/run-batch")
def run_samples_batch(body: SampleBatchBody, user: dict = Depends(require_reviewer)):
    """Run several samples (PDFs and/or the ZIP bundle) as one batch — the same
    path a multi-file upload takes, so results land in the inbox one by one."""
    if not body.names:
        raise HTTPException(422, "Choose at least one sample.")
    parts = [(p.name, p.read_bytes()) for p in (_sample_path(n) for n in dict.fromkeys(body.names))]
    return _start_batch(parts, user)


@app.post("/api/samples/{name}/run")
async def run_sample(name: str, user: dict = Depends(require_reviewer)):
    path = _sample_path(name)
    if path.suffix.lower() != ".pdf":
        raise HTTPException(422, "Archives run as a batch. Use the batch action for this sample.")

    def work():
        with app.state.work_lock:
            return process_document(app.state.conn, str(path), name, settings.current_policy(), DATA_DIR)

    try:
        result = await run_in_threadpool(work)
    except OperationalFailure as e:
        raise HTTPException(422, {"run_id": e.run_id, "run_status": "failed", "error": e.reason})
    return {"run_id": result.run_id, "route": result.decision.route.value,
            "codes": [c.value for c in result.decision.codes],
            "explanation": result.explanation, "posted": result.posted}


@app.get("/api/health")
def health():
    return {"ok": True, "interrupted_on_boot": app.state.interrupted_on_boot, "app_version": app_version()}
