"""Remote intake sources: Google Drive folders and Google Cloud Storage buckets.

STATUS (2026-09-11): implemented; client libraries installed
(`requirements.txt`); activates as soon as a deployment supplies a service
account and a bucket/folder. Until then `GET /api/sources` reports them as
"not connected" with the setup steps. The connectors that need no cloud
account at all — paste-a-link, watched folder, IMAP mailbox — live in
`connectors.py` and are always listed alongside. Everything below is real
code that turns on when the environment variables are present —
nothing in the batch pipeline needs to change, because a remote import ends
in the exact same place as a browser upload: a list of `(filename, bytes)`
handed to `intake.expand_uploads`, then a batch.

How it will work
----------------
1. **Credentials** — one service account for the deployment, never end-user
   OAuth. AP staff should not be asked to grant a demo app access to their
   personal Drive, and a service account keeps the audit trail on the
   deployment identity. The JSON key is supplied by environment:

       GOOGLE_APPLICATION_CREDENTIALS=/secrets/sa.json     # path (Render secret file), or
       GOOGLE_SERVICE_ACCOUNT_JSON='{...}'                  # inline JSON

   * GCS: grant the service account `roles/storage.objectViewer` on the bucket.
   * Drive: share the intake folder with the service account's e-mail
     (viewer). Shared drives work the same way with `supportsAllDrives=True`.

2. **Scope** — one bucket/prefix and one Drive folder per deployment:

       GCS_BUCKET=ap-invoice-intake        GCS_PREFIX=incoming/
       GDRIVE_FOLDER_ID=1AbC...

   Listing is limited to that scope; the API never takes an arbitrary bucket
   or folder from the client. The reviewer picks files *within* the scope.

3. **Flow** — `GET /api/sources/{kind}/files` lists PDFs and ZIPs in scope
   (name, size, modified, id). `POST /api/sources/{kind}/import` with the
   chosen ids downloads each object (size-capped, same 10 MB / 60 MB limits
   as uploads), and calls `intake.expand_uploads` → `BatchRegistry.start`.
   The response is the same batch payload the browser upload returns, so the
   UI reuses the batch progress page unchanged.

4. **Idempotence** — the pipeline's SHA-256 document identity already makes
   re-importing the same object a `duplicate_submission` rejection, so a
   scheduled "import everything new" job (later) needs no extra bookkeeping.
   A future poller would remember `updated`/`modifiedTime` per source as a
   watermark and import only newer objects.

5. **Not doing** — write-back (moving processed files to a `done/` prefix),
   Drive change notifications (push channels need a public HTTPS endpoint and
   renewals), per-user OAuth. All are additive on top of this module.

Enable
------
    (libraries already installed)
    export GOOGLE_APPLICATION_CREDENTIALS=... GCS_BUCKET=... GDRIVE_FOLDER_ID=...
"""
from __future__ import annotations

import io
import json
import os
from dataclasses import dataclass

from .intake import MAX_ARCHIVE_BYTES, MAX_PDF_BYTES, IntakeError



@dataclass
class RemoteFile:
    id: str
    name: str
    size: int
    modified: str | None

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "size": self.size, "modified": self.modified}


def _is_intake_name(name: str) -> bool:
    lower = name.lower()
    return lower.endswith(".pdf") or lower.endswith(".zip")


def _size_limit_for(name: str) -> int:
    return MAX_ARCHIVE_BYTES if name.lower().endswith(".zip") else MAX_PDF_BYTES


def _credentials():
    """Service-account credentials from env. Returns None when unconfigured."""
    try:
        from google.oauth2 import service_account  # type: ignore
    except ImportError:
        return None
    inline = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    scopes = ["https://www.googleapis.com/auth/devstorage.read_only",
              "https://www.googleapis.com/auth/drive.readonly"]
    if inline:
        return service_account.Credentials.from_service_account_info(json.loads(inline), scopes=scopes)
    if path and os.path.exists(path):
        return service_account.Credentials.from_service_account_file(path, scopes=scopes)
    return None


class RemoteSource:
    kind: str
    label: str
    setup: list[str]

    def library_installed(self) -> bool:
        raise NotImplementedError

    def scope(self) -> str | None:
        raise NotImplementedError

    def status(self) -> dict:
        installed = self.library_installed()
        creds = _credentials() is not None if installed else False
        scope = self.scope()
        configured = installed and creds and bool(scope)
        if not installed:
            reason = "Client library not installed on the server."
        elif not creds:
            reason = "No service-account credentials configured."
        elif not scope:
            reason = f"No {self.label} location configured."
        else:
            reason = None
        return {"kind": self.kind, "label": self.label, "configured": configured,
                "scope": scope if configured else None, "reason": reason, "setup": self.setup}

    def require(self) -> None:
        st = self.status()
        if not st["configured"]:
            raise IntakeError(501, f"{self.label} is not connected. {st['reason']}")

    def list_files(self) -> list[RemoteFile]:
        raise NotImplementedError

    def fetch(self, ids: list[str]) -> list[tuple[str, bytes]]:
        raise NotImplementedError


class GcsSource(RemoteSource):
    kind = "gcs"
    label = "Google Cloud Storage"
    setup = [
        "Create a service account and grant it roles/storage.objectViewer on the intake bucket.",
        "Set GOOGLE_APPLICATION_CREDENTIALS (key file path) or GOOGLE_SERVICE_ACCOUNT_JSON.",
        "Set GCS_BUCKET and optionally GCS_PREFIX (for example incoming/).",
    ]

    def library_installed(self) -> bool:
        try:
            import google.cloud.storage  # noqa: F401  type: ignore
            return True
        except ImportError:
            return False

    def scope(self) -> str | None:
        bucket = os.environ.get("GCS_BUCKET")
        if not bucket:
            return None
        return f"gs://{bucket}/{os.environ.get('GCS_PREFIX', '')}"

    def _bucket(self):
        from google.cloud import storage  # type: ignore
        client = storage.Client(credentials=_credentials(),
                                project=os.environ.get("GOOGLE_CLOUD_PROJECT"))
        return client.bucket(os.environ["GCS_BUCKET"])

    def list_files(self) -> list[RemoteFile]:
        self.require()
        prefix = os.environ.get("GCS_PREFIX", "")
        out = []
        for blob in self._bucket().list_blobs(prefix=prefix, max_results=500):
            name = blob.name.rsplit("/", 1)[-1]
            if not name or not _is_intake_name(name):
                continue
            out.append(RemoteFile(blob.name, name, blob.size or 0,
                                  blob.updated.isoformat() if blob.updated else None))
        return out

    def fetch(self, ids: list[str]) -> list[tuple[str, bytes]]:
        self.require()
        prefix = os.environ.get("GCS_PREFIX", "")
        bucket = self._bucket()
        parts = []
        for object_name in ids:
            if not object_name.startswith(prefix):
                raise IntakeError(403, "That object is outside the configured intake prefix.")
            blob = bucket.get_blob(object_name)
            if blob is None:
                raise IntakeError(404, f"{object_name} was not found in the bucket.")
            name = object_name.rsplit("/", 1)[-1]
            if (blob.size or 0) > _size_limit_for(name):
                raise IntakeError(413, f"{name} is over the size limit.")
            parts.append((name, blob.download_as_bytes()))
        return parts


class GoogleDriveSource(RemoteSource):
    kind = "gdrive"
    label = "Google Drive"
    setup = [
        "Create a service account; share the intake folder (or shared drive) with its e-mail as Viewer.",
        "Set GOOGLE_APPLICATION_CREDENTIALS (key file path) or GOOGLE_SERVICE_ACCOUNT_JSON.",
        "Set GDRIVE_FOLDER_ID to the folder id from its URL.",
    ]

    def library_installed(self) -> bool:
        try:
            import googleapiclient.discovery  # noqa: F401  type: ignore
            return True
        except ImportError:
            return False

    def scope(self) -> str | None:
        folder = os.environ.get("GDRIVE_FOLDER_ID")
        return f"drive://folders/{folder}" if folder else None

    def _service(self):
        from googleapiclient.discovery import build  # type: ignore
        return build("drive", "v3", credentials=_credentials(), cache_discovery=False)

    def list_files(self) -> list[RemoteFile]:
        self.require()
        folder = os.environ["GDRIVE_FOLDER_ID"]
        q = (f"'{folder}' in parents and trashed = false and "
             "(mimeType = 'application/pdf' or mimeType = 'application/zip' "
             "or mimeType = 'application/x-zip-compressed')")
        out, token = [], None
        svc = self._service()
        while True:
            resp = svc.files().list(q=q, pageSize=200, pageToken=token, supportsAllDrives=True,
                                    includeItemsFromAllDrives=True,
                                    fields="nextPageToken, files(id, name, size, modifiedTime)").execute()
            for f in resp.get("files", []):
                if _is_intake_name(f["name"]):
                    out.append(RemoteFile(f["id"], f["name"], int(f.get("size", 0)), f.get("modifiedTime")))
            token = resp.get("nextPageToken")
            if not token:
                break
        return out

    def fetch(self, ids: list[str]) -> list[tuple[str, bytes]]:
        self.require()
        from googleapiclient.http import MediaIoBaseDownload  # type: ignore
        folder = os.environ["GDRIVE_FOLDER_ID"]
        svc = self._service()
        parts = []
        for file_id in ids:
            meta = svc.files().get(fileId=file_id, supportsAllDrives=True,
                                   fields="id, name, size, parents").execute()
            if folder not in (meta.get("parents") or []):
                raise IntakeError(403, "That file is outside the configured intake folder.")
            name = meta["name"]
            if int(meta.get("size", 0)) > _size_limit_for(name):
                raise IntakeError(413, f"{name} is over the size limit.")
            buf = io.BytesIO()
            downloader = MediaIoBaseDownload(buf, svc.files().get_media(fileId=file_id, supportsAllDrives=True))
            done = False
            while not done:
                _, done = downloader.next_chunk()
            parts.append((name, buf.getvalue()))
        return parts


SOURCES: dict[str, object] = {}
SOURCE_ORDER = ("folder", "link", "mail", "gdrive", "gcs")


def build_sources(data_dir: str) -> dict:
    """Instantiate every connector once per process (the folder watcher owns a thread)."""
    from .connectors import FolderSource, MailSource, UrlSource
    SOURCES.clear()
    for src in (FolderSource(data_dir), UrlSource(), MailSource(), GoogleDriveSource(), GcsSource()):
        SOURCES[src.kind] = src
    return SOURCES


def describe_sources() -> list[dict]:
    out = []
    for k in SOURCE_ORDER:
        if k not in SOURCES:
            continue
        st = SOURCES[k].status()
        st.setdefault("mode", "files")
        # Onboarding lists Drive even before setup so its Connect panel can
        # explain the required read-only service account and folder sharing.
        out.append(st)
    return out


def get_source(kind: str):
    src = SOURCES.get(kind)
    if src is None:
        raise IntakeError(404, "Unknown source.")
    return src
