"""Intake connectors that need no cloud account: paste-a-link, a watched
folder, and an IMAP mailbox.

All three end where a browser upload ends — a list of `(filename, bytes)`
handed to `intake.expand_uploads` and a batch — so nothing downstream knows
or cares where a document came from.

Link intake (`UrlSource`)
    The reviewer pastes one or more URLs. Google Drive share links
    ("anyone with the link") are rewritten to the direct-download form, so a
    Drive file works without any Google API or service account; public GCS
    objects, signed URLs and any HTTPS link work as-is. Guards: http(s) only,
    hosts that resolve to loopback/private/link-local addresses are refused
    (SSRF), redirects are re-checked, bodies are read with a hard byte cap,
    and the connect/read timeout is short.

Watched folder (`FolderSource`)
    A directory on the server (`INTAKE_DIR`, default `<DATA_DIR>/intake`).
    Anything that lands there — from a Drive/Dropbox desktop sync client, an
    SFTP drop, `gcsfuse`, a Render disk, a cron `gsutil rsync` — is picked up
    by a poller (`INTAKE_POLL_SECONDS`, default 10). A file is taken only
    once its size has been stable across two polls so half-written files are
    never read. Accepted files move to `processed/`, anything unusable to
    `rejected/`, so the folder itself is always "what is still waiting".

Mailbox (`MailSource`)
    Suppliers e-mail invoices to an AP inbox. `INTAKE_IMAP_HOST`,
    `INTAKE_IMAP_USER`, `INTAKE_IMAP_PASSWORD` (an app password), optional
    `INTAKE_IMAP_FOLDER` (INBOX). Listing shows unseen messages that carry
    PDF/ZIP attachments; importing fetches the attachments and marks the
    message seen. Standard library `imaplib`/`email` only.
"""
from __future__ import annotations

import email
import imaplib
import ipaddress
import json
import os
import re
import shutil
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from email.header import decode_header, make_header
from html import unescape as html_unescape
from pathlib import Path

from .intake import MAX_ARCHIVE_BYTES, MAX_BATCH_DOCUMENTS, MAX_PDF_BYTES, PDF_MAGIC, ZIP_MAGIC, IntakeError

# ---------------------------------------------------------------------------
# paste-a-link
# ---------------------------------------------------------------------------
_DRIVE_ID = re.compile(r"/file/d/([A-Za-z0-9_-]{10,})|[?&]id=([A-Za-z0-9_-]{10,})")
_CONTENT_DISPOSITION_NAME = re.compile(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', re.IGNORECASE)
URL_TIMEOUT_SECONDS = 20
MAX_LINKS_PER_IMPORT = MAX_BATCH_DOCUMENTS


def normalize_link(url: str) -> str:
    """Rewrite well-known share links to a direct download."""
    url = url.strip()
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower()
    if host in ("drive.google.com", "docs.google.com"):
        m = _DRIVE_ID.search(url)
        if m:
            file_id = m.group(1) or m.group(2)
            return f"https://drive.google.com/uc?export=download&id={file_id}"
    if host == "storage.cloud.google.com":  # console link -> public object URL
        return "https://storage.googleapis.com" + parsed.path
    if host == "www.dropbox.com" and "dl=0" in url:
        return url.replace("dl=0", "dl=1")
    return url


def _is_public_address(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return bool(infos)


def check_link(url: str) -> urllib.parse.ParseResult:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise IntakeError(422, f"Only http(s) links are accepted: {url[:80]}")
    if os.environ.get("INTAKE_ALLOW_PRIVATE_LINKS") != "1" and not _is_public_address(parsed.hostname):
        raise IntakeError(422, f"{parsed.hostname} is not a public address. Links must point at a public server.")
    return parsed


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Surface redirects so every hop goes through check_link."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise _Redirect(newurl)


class _Redirect(Exception):
    def __init__(self, url):
        super().__init__(url)
        self.url = url


def _filename_from(response, url: str, fallback: str) -> str:
    cd = response.headers.get("Content-Disposition", "")
    m = _CONTENT_DISPOSITION_NAME.search(cd)
    if m:
        name = urllib.parse.unquote(m.group(1)).strip()
        if name:
            return Path(name).name
    tail = urllib.parse.unquote(Path(urllib.parse.urlparse(url).path).name)
    return tail or fallback  # the caller appends .pdf/.zip from the file signature


def fetch_link(url: str, *, opener=None) -> tuple[str, bytes]:
    """Download one link with SSRF, redirect and size guards."""
    opener = opener or urllib.request.build_opener(_NoRedirect)
    current = normalize_link(url)
    for _hop in range(5):
        check_link(current)
        req = urllib.request.Request(current, headers={"User-Agent": "ap-invoice-desk/1.0"})
        try:
            with opener.open(req, timeout=URL_TIMEOUT_SECONDS) as resp:
                cap = MAX_ARCHIVE_BYTES
                data = resp.read(cap + 1)
                if len(data) > cap:
                    raise IntakeError(413, f"{current[:80]} is larger than the 60 MB limit.")
                name = _filename_from(resp, current, "download")
                if data.startswith(PDF_MAGIC) and not name.lower().endswith(".pdf"):
                    name += ".pdf"
                elif data.startswith(ZIP_MAGIC) and not name.lower().endswith(".zip"):
                    name += ".zip"
                elif not data.startswith((PDF_MAGIC, ZIP_MAGIC)):
                    hint = " (a Google Drive link must be shared as “anyone with the link”)" \
                        if "drive.google.com" in current else ""
                    raise IntakeError(422, f"{name} is not a PDF or ZIP{hint}.")
                if data.startswith(PDF_MAGIC) and len(data) > MAX_PDF_BYTES:
                    raise IntakeError(413, f"{name} is larger than 10 MB.")
                return name, data
        except _Redirect as r:
            current = urllib.parse.urljoin(current, r.url)
            continue
        except urllib.error.HTTPError as e:
            raise IntakeError(422, f"The server answered {e.code} for {current[:80]}.")
        except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
            raise IntakeError(422, f"Could not download {current[:80]}: {getattr(e, 'reason', e)}")
    raise IntakeError(422, f"Too many redirects for {url[:80]}.")


class UrlSource:
    kind = "link"
    label = "Paste a link"
    setup = ["Nothing to configure. Share the file as “anyone with the link” (Google Drive), or use a public/signed URL."]

    def status(self) -> dict:
        return {"kind": self.kind, "label": self.label, "configured": True, "scope": "any public https link",
                "reason": None, "setup": self.setup, "mode": "links"}

    def list_files(self) -> list[dict]:
        return []

    def fetch(self, urls: list[str]) -> list[tuple[str, bytes]]:
        clean = [u.strip() for u in urls if u and u.strip()]
        if not clean:
            raise IntakeError(422, "Paste at least one link.")
        if len(clean) > MAX_LINKS_PER_IMPORT:
            raise IntakeError(422, f"At most {MAX_LINKS_PER_IMPORT} links per import.")
        return [fetch_link(u) for u in dict.fromkeys(clean)]


# ---------------------------------------------------------------------------
# public Google Drive folder (no API key, no service account)
# ---------------------------------------------------------------------------
_DRIVE_FOLDER_ID = re.compile(r"drive\.google\.com/(?:drive/(?:u/\d+/)?folders/|embeddedfolderview\?id=)([A-Za-z0-9_-]{10,})")
_DRIVE_ENTRY = re.compile(r'id="entry-([A-Za-z0-9_-]+)".*?flip-entry-title">([^<]*)<', re.S)


def drive_folder_id(text: str) -> str | None:
    m = _DRIVE_FOLDER_ID.search(text or "")
    return m.group(1) if m else None


def list_public_drive_folder(folder_id: str, *, opener=None) -> list[dict]:
    """Files in a Drive folder shared as "anyone with the link", read from
    Drive's public embedded folder view. No credentials involved; a private
    folder simply lists nothing (and the status says so)."""
    opener = opener or urllib.request.build_opener()
    url = f"https://drive.google.com/embeddedfolderview?id={folder_id}"
    req = urllib.request.Request(url, headers={"User-Agent": "ap-invoice-desk/1.0"})
    try:
        with opener.open(req, timeout=URL_TIMEOUT_SECONDS) as resp:
            html = resp.read(4 * 1024 * 1024).decode("utf-8", "replace")
    except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
        raise IntakeError(422, f"Could not reach Google Drive: {getattr(e, 'reason', e)}")
    out = []
    for file_id, raw_name in _DRIVE_ENTRY.findall(html):
        name = html_unescape(raw_name).strip()
        if name.lower().endswith((".pdf", ".zip")):
            out.append({"id": file_id, "name": name, "size": 0, "modified": None})
    return out


class FolderSource:
    kind = "folder"
    label = "Watched folder"
    setup = ["Paste a Google Drive folder link shared as “anyone with the link”, or type a folder path on this machine (Dropbox, iCloud, a Drive desktop sync folder…), then save.",
             "Anything synced or dropped into it (PDFs or ZIPs) is picked up automatically within a few seconds.",
             "Processed files move to processed/, unusable ones to rejected/, so the folder only ever holds what is waiting."]

    def __init__(self, data_dir: str):
        self.data_dir = Path(data_dir)
        self.settings_file = self.data_dir / "intake-settings.json"
        self.default_dir = Path(os.environ.get("INTAKE_DIR") or self.data_dir / "intake")
        self.drive_folder: str | None = None   # set -> watching a public Drive folder instead of a local path
        self.seen_drive_ids: set[str] = set()
        self.dir = self._load_dir()
        self.poll_seconds = max(2, int(os.environ.get("INTAKE_POLL_SECONDS", "10")))
        self._sizes: dict[str, int] = {}
        self._guard = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._on_batch = None
        self.last_scan: float | None = None
        self.picked_up = 0

    # -- where to watch: changeable from the UI, persisted next to the database --
    def _load_dir(self) -> Path:
        try:
            saved = json.loads(self.settings_file.read_text())
        except (OSError, ValueError):
            saved = {}
        self.drive_folder = saved.get("drive_folder") or None
        self.seen_drive_ids = set(saved.get("seen_drive_ids") or [])
        if saved.get("dir"):
            return Path(saved["dir"])
        return self.default_dir

    def _save(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.settings_file.write_text(json.dumps({
            "dir": str(self.dir) if self.dir != self.default_dir else None,
            "drive_folder": self.drive_folder,
            "seen_drive_ids": sorted(self.seen_drive_ids)[-2000:],
        }))

    def set_dir(self, raw: str) -> dict:
        """Point the watcher at another folder. Validates that the path is
        absolute, creatable and writable, creates it (plus processed/ and
        rejected/), persists the choice, and forgets size bookkeeping of the
        old folder. Returns the new status."""
        text = (raw or "").strip()
        if not text:
            raise IntakeError(422, "Enter a folder path or a Google Drive folder link.")
        folder_id = drive_folder_id(text)
        if folder_id:
            list_public_drive_folder(folder_id)  # reachable? (a private folder lists as empty)
            with self._guard:
                self.drive_folder = folder_id
                self.seen_drive_ids = set()
                self._sizes.clear()
            self._save()
            return self.status()
        if text.startswith(("http://", "https://")):
            raise IntakeError(422, "Only Google Drive folder links are supported here (share the folder as “anyone with the link”). For other clouds, sync the folder to this machine and enter its path.")
        path = Path(os.path.expanduser(text))
        if not path.is_absolute():
            raise IntakeError(422, "Use an absolute path, for example /Users/you/Dropbox/Invoices.")
        if path.exists() and not path.is_dir():
            raise IntakeError(422, f"{path} is a file, not a folder.")
        try:
            for sub in ("", "processed", "rejected"):
                (path / sub).mkdir(parents=True, exist_ok=True)
            probe = path / ".intake-write-test"
            probe.write_text("ok")
            probe.unlink()
        except OSError as e:
            raise IntakeError(422, f"The server cannot write to {path}: {e.strerror or e}")
        with self._guard:
            self.dir = path
            self.drive_folder = None
            self._sizes.clear()
        self._save()
        return self.status()

    def reset_dir(self) -> dict:
        try:
            self.settings_file.unlink()
        except OSError:
            pass
        with self._guard:
            self.dir = self.default_dir
            self.drive_folder = None
            self.seen_drive_ids = set()
            self._sizes.clear()
        self.ensure_dirs()
        return self.status()

    # -- Drive-folder mode ------------------------------------------------
    def _drive_new(self) -> list[dict]:
        return [f for f in list_public_drive_folder(self.drive_folder) if f["id"] not in self.seen_drive_ids]

    def _drive_take(self, ids: list[str] | None = None) -> list[tuple[str, bytes]]:
        parts: list[tuple[str, bytes]] = []
        for f in self._drive_new():
            if ids and f["id"] not in ids:
                continue
            try:
                name, data = fetch_link(f"https://drive.google.com/uc?export=download&id={f['id']}")
            except IntakeError:
                # unreadable (too large, not shared): remember it so we do not retry every poll
                with self._guard:
                    self.seen_drive_ids.add(f["id"])
                continue
            with self._guard:
                self.seen_drive_ids.add(f["id"])
            parts.append((f["name"] if f["name"].lower().endswith((".pdf", ".zip")) else name, data))
            if len(parts) >= MAX_BATCH_DOCUMENTS:
                break
        if parts:
            self._save()
        return parts

    def ensure_dirs(self) -> None:
        for sub in ("", "processed", "rejected"):
            (self.dir / sub).mkdir(parents=True, exist_ok=True)

    def status(self) -> dict:
        if self.drive_folder:
            try:
                pending = len(self._drive_new())
                reason = None
            except IntakeError as e:
                pending, reason = 0, e.message
            scope = f"https://drive.google.com/drive/folders/{self.drive_folder}"
            is_default = False
        else:
            pending, reason = len(self.pending()), None
            scope, is_default = str(self.dir), self.dir == self.default_dir
        return {"kind": self.kind, "label": self.label, "configured": True, "scope": scope,
                "remote": bool(self.drive_folder),
                "default_scope": str(self.default_dir), "is_default": is_default,
                "reason": reason, "setup": self.setup, "mode": "folder",
                "pending": pending, "picked_up": self.picked_up, "last_scan": self.last_scan,
                "poll_seconds": self.poll_seconds}

    def pending(self) -> list[Path]:
        if not self.dir.is_dir():
            return []
        return sorted(p for p in self.dir.iterdir()
                      if p.is_file() and not p.name.startswith(".") and p.suffix.lower() in (".pdf", ".zip"))

    def list_files(self) -> list[dict]:
        if self.drive_folder:
            return self._drive_new()
        out = []
        for p in self.pending():
            st = p.stat()
            out.append({"id": p.name, "name": p.name, "size": st.st_size,
                        "modified": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(st.st_mtime))})
        return out

    def _stable(self, p: Path) -> bool:
        """True once the size has not changed since the previous poll."""
        size = p.stat().st_size
        prev = self._sizes.get(p.name)
        self._sizes[p.name] = size
        return prev == size and size > 0

    def take(self, names: list[str] | None = None, *, require_stable: bool = True) -> list[tuple[str, bytes]]:
        """Move ready files out of the folder and return their bytes."""
        if self.drive_folder:
            return self._drive_take(names)
        self.ensure_dirs()
        picked: list[tuple[str, bytes]] = []
        wanted = set(names) if names else None
        for p in self.pending():
            if wanted is not None and p.name not in wanted:
                continue
            if require_stable and not self._stable(p):
                continue
            try:
                data = p.read_bytes()
            except OSError:
                continue
            ok = data.startswith((PDF_MAGIC, ZIP_MAGIC))
            dest_dir = self.dir / ("processed" if ok else "rejected")
            dest = dest_dir / p.name
            n = 1
            while dest.exists():
                dest = dest_dir / f"{p.stem}-{n}{p.suffix}"
                n += 1
            shutil.move(str(p), str(dest))
            self._sizes.pop(p.name, None)
            if ok:
                picked.append((p.name, data))
            if len(picked) >= MAX_BATCH_DOCUMENTS:
                break
        return picked

    def fetch(self, ids: list[str]) -> list[tuple[str, bytes]]:
        parts = self.take(ids or None, require_stable=False)
        if not parts:
            raise IntakeError(404, "No new PDF or ZIP is waiting in the folder.")
        return parts

    # -- background poller ------------------------------------------------
    def start(self, on_batch) -> None:
        """on_batch(parts: list[(name, bytes)]) -> None; called from the poller thread."""
        self._on_batch = on_batch
        self.ensure_dirs()
        self._thread = threading.Thread(target=self._loop, name="intake-folder", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=30)

    def scan_once(self) -> int:
        self.last_scan = time.time()
        parts = self.take()
        if parts and self._on_batch:
            self._on_batch(parts)
            self.picked_up += len(parts)
        return len(parts)

    def _loop(self) -> None:
        while not self._stop.wait(self.poll_seconds):
            try:
                self.scan_once()
            except Exception:  # a bad file must never kill the poller
                pass


# ---------------------------------------------------------------------------
# IMAP mailbox
# ---------------------------------------------------------------------------
def _decode(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


class MailSource:
    kind = "mail"
    label = "E-mail inbox (IMAP)"
    setup = ["Create an AP mailbox (for example ap-invoices@yourcompany.com) with IMAP enabled.",
             "Set INTAKE_IMAP_HOST, INTAKE_IMAP_USER and INTAKE_IMAP_PASSWORD (use an app password, never the account password).",
             "Optional: INTAKE_IMAP_FOLDER (default INBOX). Only unseen messages with PDF/ZIP attachments are listed."]

    def _cfg(self) -> dict | None:
        host, user, pw = (os.environ.get(k) for k in ("INTAKE_IMAP_HOST", "INTAKE_IMAP_USER", "INTAKE_IMAP_PASSWORD"))
        if not (host and user and pw):
            return None
        return {"host": host, "user": user, "password": pw, "folder": os.environ.get("INTAKE_IMAP_FOLDER", "INBOX")}

    def status(self) -> dict:
        cfg = self._cfg()
        return {"kind": self.kind, "label": self.label, "configured": cfg is not None,
                "scope": f"{cfg['user']} · {cfg['folder']}" if cfg else None,
                "reason": None if cfg else "No mailbox configured.", "setup": self.setup, "mode": "files"}

    def require(self) -> dict:
        cfg = self._cfg()
        if cfg is None:
            raise IntakeError(501, f"{self.label} is not connected. No mailbox configured.")
        return cfg

    def _connect(self, cfg):
        conn = imaplib.IMAP4_SSL(cfg["host"], timeout=20)
        conn.login(cfg["user"], cfg["password"])
        conn.select(cfg["folder"])
        return conn

    @staticmethod
    def _attachments(msg) -> list[tuple[str, bytes]]:
        out = []
        for part in msg.walk():
            name = _decode(part.get_filename())
            if not name or not name.lower().endswith((".pdf", ".zip")):
                continue
            payload = part.get_payload(decode=True)
            if payload and payload.startswith((PDF_MAGIC, ZIP_MAGIC)):
                out.append((Path(name).name, payload))
        return out

    def list_files(self) -> list[dict]:
        cfg = self.require()
        conn = self._connect(cfg)
        try:
            _, data = conn.search(None, "UNSEEN")
            out = []
            for uid in (data[0].split() if data and data[0] else [])[-100:]:
                _, msg_data = conn.fetch(uid, "(BODY.PEEK[])")
                msg = email.message_from_bytes(msg_data[0][1])
                atts = self._attachments(msg)
                if not atts:
                    continue
                out.append({"id": uid.decode(), "name": f"{_decode(msg.get('Subject')) or '(no subject)'} — {', '.join(n for n, _ in atts)}",
                            "size": sum(len(b) for _, b in atts), "modified": msg.get("Date"),
                            "from": _decode(msg.get("From"))})
            return out
        finally:
            conn.logout()

    def fetch(self, ids: list[str]) -> list[tuple[str, bytes]]:
        cfg = self.require()
        conn = self._connect(cfg)
        parts: list[tuple[str, bytes]] = []
        try:
            for uid in ids:
                if not uid.isdigit():
                    raise IntakeError(422, "Bad message id.")
                _, msg_data = conn.fetch(uid.encode(), "(BODY.PEEK[])")
                msg = email.message_from_bytes(msg_data[0][1])
                atts = self._attachments(msg)
                parts.extend(atts)
                if atts:
                    conn.store(uid.encode(), "+FLAGS", "\\Seen")
        finally:
            conn.logout()
        if not parts:
            raise IntakeError(404, "Those messages carry no PDF or ZIP attachment.")
        return parts
