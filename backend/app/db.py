"""SQLite schema + connection. Constraints ARE the last line of defense:
business-key uniqueness on logical invoices, one active posting per invoice."""
from __future__ import annotations

import json
import sqlite3

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS documents (
    document_id TEXT PRIMARY KEY,
    sha256      TEXT NOT NULL UNIQUE,
    filename    TEXT,
    bytes_path  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vendors (
    supplier_id TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'approved',   -- approved | blocked
    country     TEXT,
    aliases     TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS pos (
    po_id        TEXT PRIMARY KEY,
    supplier_id  TEXT NOT NULL REFERENCES vendors(supplier_id),
    currency     TEXT NOT NULL,
    amount_minor INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open'       -- open | closed
);

-- Logical business invoice. Identity = business key, enforced here.
CREATE TABLE IF NOT EXISTS invoices (
    invoice_id           TEXT PRIMARY KEY,
    workspace            TEXT NOT NULL,
    buyer                TEXT NOT NULL,
    supplier_id          TEXT NOT NULL REFERENCES vendors(supplier_id),
    invoice_no_canonical TEXT NOT NULL,
    invoice_no_raw       TEXT NOT NULL,
    gross_minor          INTEGER,
    invoice_date         TEXT,
    currency             TEXT,
    UNIQUE (workspace, buyer, supplier_id, invoice_no_canonical)
);

CREATE TABLE IF NOT EXISTS runs (
    run_id         TEXT PRIMARY KEY,
    document_id    TEXT NOT NULL REFERENCES documents(document_id),
    invoice_id     TEXT REFERENCES invoices(invoice_id),
    run_status     TEXT NOT NULL DEFAULT 'queued',  -- queued|running|completed|failed
    failure_reason TEXT,
    disposition    TEXT,                            -- approved|held|rejected|NULL
    decision_mode  TEXT,                            -- automatic|automatic_exception|reviewer|NULL
    policy_version INTEGER,
    snapshot_json  TEXT,                            -- historical A, PO/vendor snapshot, budget numbers
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at    TEXT
);

-- Append-only. kind: opening | posting | reversal.
CREATE TABLE IF NOT EXISTS ledger_events (
    ledger_event_id TEXT PRIMARY KEY,
    invoice_id      TEXT REFERENCES invoices(invoice_id),  -- NULL only for opening
    po_id           TEXT NOT NULL REFERENCES pos(po_id),
    run_id          TEXT REFERENCES runs(run_id),
    kind            TEXT NOT NULL,
    amount_minor    INTEGER NOT NULL,
    currency        TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One active posting per logical invoice.
CREATE UNIQUE INDEX IF NOT EXISTS one_posting_per_invoice
    ON ledger_events(invoice_id) WHERE kind = 'posting';

CREATE TABLE IF NOT EXISTS run_events (
    run_id     TEXT NOT NULL REFERENCES runs(run_id),
    seq        INTEGER NOT NULL,
    ts         TEXT NOT NULL DEFAULT (datetime('now')),
    stage      TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload    TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (run_id, seq)
);

-- Immutable field-interpretation revisions per run. seq 1 = extraction;
-- reviewer corrections append, never overwrite.
CREATE TABLE IF NOT EXISTS field_revisions (
    revision_id TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(run_id),
    seq         INTEGER NOT NULL,
    source      TEXT NOT NULL,            -- extraction | reviewer
    actor       TEXT,
    fields_json TEXT NOT NULL,
    context_json TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (run_id, seq)
);

-- Requests from invoice reviewers to procurement. Append-only status changes
-- are recorded on the invoice run's audit trail as well.
CREATE TABLE IF NOT EXISTS tickets (
    ticket_id       TEXT PRIMARY KEY,
    run_id          TEXT REFERENCES runs(run_id),   -- NULL for a request raised from the Requests page
    kind            TEXT NOT NULL,        -- unblock_supplier | onboard_supplier | raise_po | amend_po | other
    note            TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'open',   -- open | resolved | declined
    requested_by    TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_by     TEXT,
    resolution_note TEXT,
    resolved_at     TEXT,
    supplier_id     TEXT,                 -- the supplier the request is about (pinned at creation)
    known_pos       TEXT,                 -- JSON: orders that already existed when the request was made
    subject         TEXT,                 -- e.g. the supplier name to onboard, for standalone requests
    amount_minor    INTEGER,              -- requested order amount (standalone raise_po)
    currency        TEXT
);

CREATE TABLE IF NOT EXISTS policies (
    version     INTEGER PRIMARY KEY,
    config_json TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


MIGRATIONS = [
    ("runs", "kind", "ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'intake'", None),
    ("runs", "parent_run_id", "ALTER TABLE runs ADD COLUMN parent_run_id TEXT", None),
    ("runs", "actor", "ALTER TABLE runs ADD COLUMN actor TEXT", None),
    ("runs", "idempotency_key", "ALTER TABLE runs ADD COLUMN idempotency_key TEXT", None),
    # (table, column, ddl, backfill-sql or None)
    ("invoices", "gross_minor", "ALTER TABLE invoices ADD COLUMN gross_minor INTEGER", None),
    ("invoices", "invoice_date", "ALTER TABLE invoices ADD COLUMN invoice_date TEXT", None),
    # legacy rows were written under the USD-only schema: that context, not a
    # guess, establishes their denomination
    ("invoices", "currency", "ALTER TABLE invoices ADD COLUMN currency TEXT",
     "UPDATE invoices SET currency='USD' WHERE currency IS NULL"),
    ("tickets", "supplier_id", "ALTER TABLE tickets ADD COLUMN supplier_id TEXT", None),
    ("tickets", "known_pos", "ALTER TABLE tickets ADD COLUMN known_pos TEXT", None),
    ("tickets", "subject", "ALTER TABLE tickets ADD COLUMN subject TEXT", None),
    ("tickets", "amount_minor", "ALTER TABLE tickets ADD COLUMN amount_minor INTEGER", None),
    ("tickets", "currency", "ALTER TABLE tickets ADD COLUMN currency TEXT", None),
]


def _relax_ticket_run(conn: sqlite3.Connection) -> None:
    """Older databases created tickets.run_id NOT NULL; standalone requests
    need it optional. SQLite cannot alter a constraint, so rebuild the table
    once, keeping every row."""
    info = {r[1]: r for r in conn.execute("PRAGMA table_info(tickets)")}
    if not info or info["run_id"][3] == 0:   # notnull flag
        return
    conn.execute("PRAGMA foreign_keys=OFF")
    conn.executescript("""
        BEGIN;
        CREATE TABLE tickets_new (
            ticket_id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(run_id), kind TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', requested_by TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_by TEXT, resolution_note TEXT,
            resolved_at TEXT, supplier_id TEXT, known_pos TEXT, subject TEXT, amount_minor INTEGER, currency TEXT);
        INSERT INTO tickets_new (ticket_id, run_id, kind, note, status, requested_by, created_at, resolved_by,
            resolution_note, resolved_at, supplier_id, known_pos)
          SELECT ticket_id, run_id, kind, note, status, requested_by, created_at, resolved_by,
            resolution_note, resolved_at, supplier_id, known_pos FROM tickets;
        DROP TABLE tickets;
        ALTER TABLE tickets_new RENAME TO tickets;
        COMMIT;
    """)
    conn.execute("PRAGMA foreign_keys=ON")


def _migrate(conn: sqlite3.Connection) -> None:
    for table, column, ddl, backfill in MIGRATIONS:
        cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        if column not in cols:
            conn.execute(ddl)
            if backfill:
                conn.execute(backfill)


def alias_list(value) -> list[str]:
    """The aliases column as a list. NULL, empty or malformed content (seen once
    in a live database) reads as no aliases instead of taking the app down."""
    if not value:
        return []
    try:
        data = json.loads(value)
    except (TypeError, ValueError):
        return []
    return [str(a).lower() for a in data] if isinstance(data, list) else []


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=10, isolation_level=None,
                           check_same_thread=False)  # cross-thread use serialized by the worker lock
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _migrate(conn)
    _relax_ticket_run(conn)
    conn.execute("UPDATE vendors SET aliases='[]' WHERE aliases IS NULL OR aliases=''")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS runs_idem ON runs(idempotency_key) "
                 "WHERE idempotency_key IS NOT NULL")
    return conn
