"""One workspace per visitor.

A hosted demo has many people in it at once. With a single shared database the
second person sees the first person's invoices, and worse, spends the first
person's purchase-order budget — two testers approving against PO-1001 would
exhaust it between them and neither result would mean anything.

So each visitor gets their own workspace: their own SQLite database, their own
stored PDFs and extraction evidence, their own suppliers and orders seeded from
the same demo data, and their own settings. The browser generates an id once and
keeps it in its own local storage, then sends it with every request; the server
never issues or tracks identities, and a workspace is only ever reachable by
someone who already holds its id.

Requests without an id fall back to the shared `demo` workspace, so curl, the
health check and anything without JavaScript keep working exactly as before.

Workspaces are demo scratch space, not accounts. They are capped and the least
recently used are dropped once they have been idle long enough, which keeps a
public demo from filling its disk with abandoned databases.
"""
from __future__ import annotations

import os
import re
import shutil
import threading
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path

from .db import connect
from .policy import Policy

DEFAULT_WORKSPACE = "demo"
# The id is a filesystem path segment, so it is validated rather than trusted:
# anything that is not plainly a generated id is refused, not sanitised.
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_WORKSPACES = int(os.environ.get("MAX_WORKSPACES", "64"))
IDLE_EVICT_SECONDS = float(os.environ.get("WORKSPACE_IDLE_SECONDS", "3600"))

_current: ContextVar["Workspace | None"] = ContextVar("current_workspace", default=None)


def valid_id(raw: str | None) -> str | None:
    """The workspace id in `raw`, or None when it is absent or not an id."""
    if not raw:
        return None
    raw = raw.strip()
    if raw == DEFAULT_WORKSPACE or ID_PATTERN.match(raw):
        return raw
    return None


@dataclass
class Workspace:
    """One visitor's demo: a database, the files that belong to its rows, the
    lock that serializes its writes, and the switches it has set."""
    id: str
    dir: Path
    conn: object
    lock: threading.Lock = field(default_factory=threading.Lock)
    values: dict = field(default_factory=dict)
    last_used: float = field(default_factory=time.monotonic)
    _batches: object = None

    @property
    def data_dir(self) -> str:
        return str(self.dir)

    def policy(self) -> Policy:
        from . import settings
        return settings.policy_for(self.values)

    @property
    def batches(self):
        """Built on first use: most workspaces never run a batch, and a registry
        owns a worker pool."""
        if self._batches is None:
            from .intake import BatchRegistry
            self._batches = BatchRegistry(self.conn, self.lock, self.policy, self.data_dir)
        return self._batches

    def close(self) -> None:
        batches = self._batches
        if batches is not None:
            try:
                batches.shutdown(timeout=30)
            except Exception:  # noqa: BLE001 — shutdown must not block eviction
                pass
        try:
            self.conn.close()
        except Exception:  # noqa: BLE001
            pass


class Registry:
    """Owns every live workspace. Creation is serialized; a workspace is created
    once and then reused for every request that carries its id."""

    def __init__(self, root: str):
        self.root = Path(root)
        self._guard = threading.Lock()
        self._spaces: dict[str, Workspace] = {}

    def _path(self, workspace_id: str) -> Path:
        return self.root / "workspaces" / workspace_id

    def get(self, workspace_id: str | None) -> Workspace:
        wid = valid_id(workspace_id) or DEFAULT_WORKSPACE
        with self._guard:
            ws = self._spaces.get(wid)
            if ws is None:
                ws = self._open(wid)
                self._spaces[wid] = ws
                self._evict_locked()
            ws.last_used = time.monotonic()
            return ws

    def _open(self, wid: str) -> Workspace:
        from . import settings
        from .main import seed_if_empty
        from .pipeline import startup_recovery
        from .review import settle_requests
        directory = self._path(wid)
        directory.mkdir(parents=True, exist_ok=True)
        conn = connect(str(directory / "app.db"))
        startup_recovery(conn)   # a workspace reloaded after a restart has no runs in flight
        seed_if_empty(conn)
        settle_requests(conn, "system")
        return Workspace(id=wid, dir=directory, conn=conn, values=settings.load(directory))

    def _evict_locked(self) -> None:
        """Drop the least recently used workspaces once over the cap, but only
        ones idle long enough that nobody is plausibly still using them. The
        shared demo workspace is never evicted."""
        if len(self._spaces) <= MAX_WORKSPACES:
            return
        now = time.monotonic()
        candidates = sorted(
            (ws for wid, ws in self._spaces.items()
             if wid != DEFAULT_WORKSPACE and now - ws.last_used > IDLE_EVICT_SECONDS),
            key=lambda ws: ws.last_used)
        for ws in candidates[:len(self._spaces) - MAX_WORKSPACES]:
            self._spaces.pop(ws.id, None)
            ws.close()
            shutil.rmtree(ws.dir, ignore_errors=True)

    def reset(self, ws: Workspace) -> int:
        """Clear one workspace back to its seeded state: its rows, its stored
        originals and evidence, and any batches it was tracking. Another
        visitor's workspace is untouched, because it is a different database."""
        from .main import seed_if_empty
        removed = 0
        with ws.lock:
            conn = ws.conn
            conn.execute("BEGIN IMMEDIATE")
            try:
                for table in ("field_revisions", "run_events", "ledger_events", "tickets", "runs",
                              "invoices", "documents", "pos", "vendors"):
                    conn.execute(f"DELETE FROM {table}")
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            seed_if_empty(conn)
            for sub in ("pdfs", "evidence"):
                folder = ws.dir / sub
                if folder.is_dir():
                    for f in folder.iterdir():
                        if f.is_file():
                            f.unlink()
                            removed += 1
            if ws._batches is not None:
                ws._batches._batches.clear()
        return removed

    def close_all(self) -> None:
        with self._guard:
            spaces, self._spaces = list(self._spaces.values()), {}
        for ws in spaces:
            ws.close()

    def stats(self) -> dict:
        with self._guard:
            return {"live": len(self._spaces), "cap": MAX_WORKSPACES}


_registry: Registry | None = None


def init(root: str) -> Registry:
    global _registry
    _registry = Registry(root)
    return _registry


def registry() -> Registry:
    if _registry is None:
        raise RuntimeError("workspaces.init() has not run")
    return _registry


def use(ws: Workspace):
    """Bind a workspace to the current request. The token is returned so the
    caller can restore the previous one."""
    return _current.set(ws)


def release(token) -> None:
    _current.reset(token)


def shared_dir(data_root: str) -> Path:
    """Where the shared `demo` workspace keeps its database and files. Tests and
    tools that prepare state before the server starts write here."""
    return Path(data_root) / "workspaces" / DEFAULT_WORKSPACE


def current() -> Workspace:
    """The workspace this request belongs to, falling back to the shared demo
    one outside a request (background threads, scripts, tests)."""
    ws = _current.get()
    return ws if ws is not None else registry().get(DEFAULT_WORKSPACE)
