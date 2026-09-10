"""Bulk intake: several PDFs at once, or a ZIP archive of PDFs.

The single-file endpoint stays synchronous (the UI shows one live progress
card). A *batch* is different: it may hold dozens of documents and take
minutes, so the request only validates and expands the upload, then hands the
queue to a background thread and returns a batch id the UI polls.

Each document still goes through `process_document` on its own — same
identity, duplicate and ledger rules as a single upload — and each gets its
own run, so the inbox shows batch results exactly like individual uploads.
Documents are processed one at a time under the same worker lock as every
other pipeline call (single bounded worker, see IMPLEMENTATION.md §10).

Batch state is in-memory (`app.state.batches`). If the server restarts mid
batch, the finished runs are already in the database and the ones in flight
are marked `interrupted` by startup recovery; the batch progress view is the
only thing lost, and the UI says so.

ZIP handling is deliberately conservative:
  * only regular entries whose name ends with `.pdf` and whose bytes start
    with `%PDF` are accepted; everything else is reported as *skipped* with a
    reason (macOS resource forks, folders, spreadsheets, nested archives…);
  * the declared uncompressed size is checked *before* the entry is read, so
    a zip bomb is refused without inflating it;
  * encrypted entries are skipped (we never prompt for archive passwords);
  * nested archives are not expanded (one level keeps the limits meaningful);
  * a hard cap on documents per batch keeps one upload from monopolising the
    worker for an hour.
"""
from __future__ import annotations

import io
import os
import tempfile
import threading
import time
import uuid
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import PurePosixPath

MAX_PDF_BYTES = 10 * 1024 * 1024        # same as the single-file endpoint
MAX_ARCHIVE_BYTES = 60 * 1024 * 1024    # compressed ZIP upload
MAX_BATCH_DOCUMENTS = 25                # PDFs actually processed per batch
MAX_BATCH_UPLOAD_BYTES = 120 * 1024 * 1024  # sum of all parts in one request
BATCH_RETENTION_SECONDS = 24 * 3600
PDF_MAGIC = b"%PDF"
ZIP_MAGIC = b"PK\x03\x04"


class IntakeError(Exception):
    """Whole-request rejection (nothing was queued)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class IntakeItem:
    item_id: str
    filename: str            # name shown to the user and stored on the document
    source: str              # "upload" or "zip:<archive name>"
    size: int
    status: str = "queued"   # queued | running | done | failed | skipped
    reason: str | None = None  # skip reason or failure text
    run_id: str | None = None
    route: str | None = None
    explanation: str | None = None
    tmp_path: str | None = field(default=None, repr=False)

    def public(self) -> dict:
        d = asdict(self)
        d.pop("tmp_path", None)
        return d


def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _spool(raw: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(raw)
        return tmp.name


def _skipped(name: str, source: str, size: int, reason: str) -> IntakeItem:
    return IntakeItem(_uid("item"), name, source, size, status="skipped", reason=reason)


def expand_archive(archive_name: str, raw: bytes, accepted_so_far: int) -> list[IntakeItem]:
    """Turn one ZIP into intake items. Never inflates more than we would accept."""
    items: list[IntakeItem] = []
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        return [_skipped(archive_name, "upload", len(raw), "This ZIP archive could not be opened.")]
    source = f"zip:{archive_name}"
    accepted = accepted_so_far
    with zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            path = PurePosixPath(info.filename)
            name = path.name
            if not name or name.startswith(".") or any(part == "__MACOSX" for part in path.parts):
                continue  # resource forks and hidden files: silently ignored, they are never documents
            if info.flag_bits & 0x1:
                items.append(_skipped(name, source, info.file_size, "Encrypted entries are not extracted."))
                continue
            lower = name.lower()
            if lower.endswith(".zip"):
                items.append(_skipped(name, source, info.file_size, "Nested archives are not expanded. Upload it separately."))
                continue
            if not lower.endswith(".pdf"):
                items.append(_skipped(name, source, info.file_size, "Not a PDF."))
                continue
            if info.file_size > MAX_PDF_BYTES:
                items.append(_skipped(name, source, info.file_size, "Larger than 10 MB."))
                continue
            if info.file_size == 0:
                items.append(_skipped(name, source, 0, "Empty file."))
                continue
            if accepted >= MAX_BATCH_DOCUMENTS:
                items.append(_skipped(name, source, info.file_size,
                                      f"Over the {MAX_BATCH_DOCUMENTS}-document batch limit. Upload it in a later batch."))
                continue
            # read with a hard ceiling so a lying header cannot inflate past the limit
            with zf.open(info) as fh:
                data = fh.read(MAX_PDF_BYTES + 1)
            if len(data) > MAX_PDF_BYTES:
                items.append(_skipped(name, source, len(data), "Larger than 10 MB."))
                continue
            if not data.startswith(PDF_MAGIC):
                items.append(_skipped(name, source, len(data), "Not a readable PDF (wrong file signature)."))
                continue
            accepted += 1
            items.append(IntakeItem(_uid("item"), name, source, len(data), tmp_path=_spool(data)))
    return items


def expand_uploads(parts: list[tuple[str, bytes]]) -> list[IntakeItem]:
    """Validate and expand every uploaded part into intake items.

    `parts` is [(filename, bytes)]. Raises IntakeError when the request as a
    whole is unacceptable; per-file problems become *skipped* items instead so
    one bad file never blocks the rest of the batch.
    """
    if not parts:
        raise IntakeError(422, "Choose at least one PDF or ZIP file.")
    total = sum(len(b) for _, b in parts)
    if total > MAX_BATCH_UPLOAD_BYTES:
        raise IntakeError(413, "This upload is too large. Split it into smaller batches.")
    items: list[IntakeItem] = []
    accepted = 0
    for filename, raw in parts:
        name = PurePosixPath(filename or "upload").name or "upload"
        lower = name.lower()
        if raw.startswith(ZIP_MAGIC) or lower.endswith(".zip"):
            if len(raw) > MAX_ARCHIVE_BYTES:
                items.append(_skipped(name, "upload", len(raw), "ZIP archives over 60 MB are not accepted."))
                continue
            expanded = expand_archive(name, raw, accepted)
            accepted += sum(1 for i in expanded if i.status == "queued")
            items.extend(expanded)
            continue
        if not raw:
            items.append(_skipped(name, "upload", 0, "Empty file."))
            continue
        if len(raw) > MAX_PDF_BYTES:
            items.append(_skipped(name, "upload", len(raw), "Larger than 10 MB."))
            continue
        if not raw.startswith(PDF_MAGIC):
            items.append(_skipped(name, "upload", len(raw), "Not a PDF."))
            continue
        if accepted >= MAX_BATCH_DOCUMENTS:
            items.append(_skipped(name, "upload", len(raw),
                                  f"Over the {MAX_BATCH_DOCUMENTS}-document batch limit. Upload it in a later batch."))
            continue
        accepted += 1
        items.append(IntakeItem(_uid("item"), name, "upload", len(raw), tmp_path=_spool(raw)))
    if accepted == 0:
        # release any spooled temp files (there are none when nothing was accepted, but be safe)
        for it in items:
            if it.tmp_path:
                _unlink(it.tmp_path)
        reasons = sorted({i.reason for i in items if i.reason})
        raise IntakeError(422, "Nothing in this upload could be processed. " + " ".join(reasons))
    return items


def _unlink(path: str | None) -> None:
    if path:
        try:
            os.unlink(path)
        except OSError:
            pass


@dataclass
class Batch:
    batch_id: str
    items: list[IntakeItem]
    created_by: str
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    status: str = "queued"  # queued | running | done

    def public(self) -> dict:
        counts = {k: 0 for k in ("queued", "running", "done", "failed", "skipped")}
        for it in self.items:
            counts[it.status] = counts.get(it.status, 0) + 1
        return {
            "batch_id": self.batch_id,
            "status": self.status,
            "created_by": self.created_by,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
            "counts": counts,
            "total": len(self.items),
            "items": [i.public() for i in self.items],
        }


class BatchRegistry:
    """Owns batches and the background worker that drains them, one document
    at a time, under the app's single worker lock."""

    def __init__(self, conn, work_lock: threading.Lock, process, policy, data_dir: str):
        self._conn = conn
        self._lock = work_lock
        self._process = process
        self._policy = policy
        self._data_dir = data_dir
        self._batches: dict[str, Batch] = {}
        self._guard = threading.Lock()
        self._threads: list[threading.Thread] = []
        self._closing = False

    def get(self, batch_id: str) -> Batch | None:
        return self._batches.get(batch_id)

    def list(self) -> list[dict]:
        self._prune()
        return [b.public() for b in sorted(self._batches.values(), key=lambda b: -b.created_at)]

    def start(self, items: list[IntakeItem], created_by: str) -> Batch:
        self._prune()
        batch = Batch(_uid("batch"), items, created_by)
        with self._guard:
            if self._closing:
                for it in items:
                    _unlink(it.tmp_path)
                raise IntakeError(503, "The server is shutting down. Try again in a moment.")
            self._batches[batch.batch_id] = batch
            self._threads = [t for t in self._threads if t.is_alive()]
            t = threading.Thread(target=self._run, args=(batch,), name=f"batch-{batch.batch_id}", daemon=True)
            self._threads.append(t)
        t.start()
        return batch

    def shutdown(self, timeout: float = 120.0) -> None:
        """Stop accepting batches and wait for in-flight documents. Called from
        the app lifespan so the database is never closed under a worker."""
        with self._guard:
            self._closing = True
            threads = list(self._threads)
        deadline = time.time() + timeout
        for t in threads:
            t.join(max(0.0, deadline - time.time()))

    def _prune(self) -> None:
        cutoff = time.time() - BATCH_RETENTION_SECONDS
        with self._guard:
            for bid in [b for b, v in self._batches.items() if v.finished_at and v.finished_at < cutoff]:
                del self._batches[bid]

    def _run(self, batch: Batch) -> None:
        from .pipeline import OperationalFailure  # local import keeps this module import-light for tests
        batch.status = "running"
        for item in batch.items:
            if item.status != "queued":
                continue
            if self._closing:
                item.status = "failed"
                item.reason = "Server shut down before this document was processed."
                _unlink(item.tmp_path)
                item.tmp_path = None
                continue
            item.status = "running"
            try:
                with self._lock:
                    result = self._process(self._conn, item.tmp_path, item.filename, self._policy, self._data_dir)
                item.run_id = result.run_id
                item.route = result.decision.route.value
                item.explanation = result.explanation
                item.status = "done"
            except OperationalFailure as e:
                item.run_id = e.run_id
                item.reason = e.reason
                item.status = "failed"
            except Exception as e:  # never let one document kill the batch thread
                item.reason = f"Unexpected error: {e.__class__.__name__}"
                item.status = "failed"
            finally:
                _unlink(item.tmp_path)
                item.tmp_path = None
        batch.status = "done"
        batch.finished_at = time.time()
