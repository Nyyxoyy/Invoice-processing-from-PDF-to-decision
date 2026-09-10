"""Role-based access with server-side enforcement.

Two roles, no passwords (2026-09-11). This is an open demo: the reviewer
workspace opens directly and the top bar switches roles. The bearer token is
the role name itself (`reviewer` / `admin`); the legacy demo codes are still
accepted as aliases so older tabs and scripts keep working. What matters is
that the SERVER decides what each role may do on every request — the split
below is enforced here, not by which buttons the page shows. Swapping
`resolve_user` for an identity-provider check (SSO/OIDC) is the only change
needed to make this real.

  admin     procurement / administration: suppliers, purchase orders, the
            procurement queue, workspace reset. Reads invoices; never approves.
  reviewer  accounts payable: upload, correct, attest, approve/reject.
            Cannot change suppliers or purchase orders.
  The split is deliberate segregation of duties: whoever creates the budget
  (vendor + PO) is not the person who releases money against it.
"""
from __future__ import annotations

from fastapi import HTTPException, Request

ROLES = {
    "admin": {"label": "Procurement admin", "actor": "procurement@demo",
              "description": "Manages suppliers and purchase orders, works the procurement queue, resets the demo. Can read invoices but never approves them."},
    "reviewer": {"label": "Invoice reviewer", "actor": "reviewer@demo",
                 "description": "Uploads and reviews invoices, corrects details, approves or rejects. Cannot change suppliers or purchase orders."},
}
# legacy demo codes, kept as aliases of the role they used to unlock
ROLE_ALIASES = {"admin-demo": "admin", "reviewer-demo": "reviewer"}
PUBLIC_PATHS = {"/", "/onboarding", "/onboarding/dataset", "/app", "/api/health", "/api/auth/config"}
PUBLIC_PREFIXES = ("/static/",)


def resolve_user(token: str | None) -> dict | None:
    if not token:
        return None
    role = ROLE_ALIASES.get(token, token).strip().lower()
    if role in ROLES:
        return {"role": role, **ROLES[role]}
    return None


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    # <img src> cannot send headers: rendered page images only may pass the
    # role as a query parameter (`role`; `access_code` kept for older tabs).
    if "/page/" in request.url.path and request.url.path.startswith("/api/runs/"):
        return request.query_params.get("role") or request.query_params.get("access_code") or None
    return None


async def auth_gate(request: Request) -> None:
    """App-level dependency: every non-public route needs a valid role."""
    path = request.url.path
    if path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES):
        request.state.user = None
        return
    user = resolve_user(_bearer(request))
    if user is None:
        raise HTTPException(401, "Choose a role (reviewer or admin) to continue.")
    request.state.user = user


def current_user(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(401, "Choose a role (reviewer or admin) to continue.")
    return user


def require_reviewer(request: Request) -> dict:
    user = current_user(request)
    if user["role"] != "reviewer":
        raise HTTPException(403, "Only an invoice reviewer can do this. Approvals are kept separate from procurement on purpose.")
    return user


def require_admin(request: Request) -> dict:
    user = current_user(request)
    if user["role"] != "admin":
        raise HTTPException(403, "Only an administrator can do this. Switch to the procurement role in the top bar.")
    return user
