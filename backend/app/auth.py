"""Role-based access with server-side enforcement.

Two roles, two access codes. In a deployed environment the codes come from
environment variables (ADMIN_ACCESS_CODE, REVIEWER_ACCESS_CODE) and are
compared in constant time; locally they fall back to demo defaults and the
API advertises that it is in dev mode so the sign-in screen can show them.
The bearer token IS the access code — a deliberate stand-in for SSO/OIDC:
swap `resolve_user` for an identity-provider check and nothing else moves.

  admin     procurement / administration: suppliers, purchase orders, the
            procurement queue, workspace reset. Reads invoices; never approves.
  reviewer  accounts payable: upload, correct, attest, approve/reject.
            Cannot change suppliers or purchase orders.
  The split is deliberate segregation of duties: whoever creates the budget
  (vendor + PO) is not the person who releases money against it.
"""
from __future__ import annotations

import hmac
import os

from fastapi import HTTPException, Request

ROLES = {
    "admin": {"label": "Procurement admin", "actor": "procurement@demo",
              "description": "Manages suppliers and purchase orders, works the procurement queue, resets the demo. Can read invoices but never approves them."},
    "reviewer": {"label": "Invoice reviewer", "actor": "reviewer@demo",
                 "description": "Uploads and reviews invoices, corrects details, approves or rejects. Cannot change suppliers or purchase orders."},
}
DEV_CODES = {"admin": "admin-demo", "reviewer": "reviewer-demo"}
PUBLIC_PATHS = {"/", "/api/health", "/api/auth/config", "/api/auth/login"}
PUBLIC_PREFIXES = ("/static/",)


def access_codes() -> tuple[dict[str, str], bool]:
    """(role -> code, dev_mode). dev_mode is True when any code fell back."""
    codes, dev = {}, False
    for role in ROLES:
        env = os.environ.get(f"{role.upper()}_ACCESS_CODE", "").strip()
        if env:
            codes[role] = env
        else:
            codes[role] = DEV_CODES[role]
            dev = True
    return codes, dev


def resolve_user(token: str | None) -> dict | None:
    if not token:
        return None
    codes, _ = access_codes()
    for role, code in codes.items():
        if hmac.compare_digest(token.encode(), code.encode()):
            return {"role": role, **ROLES[role]}
    return None


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    # <img src> cannot send headers: rendered page images only may pass the
    # code as a query parameter. Kept to that one route so codes never end up
    # in URLs for anything else.
    if "/page/" in request.url.path and request.url.path.startswith("/api/runs/"):
        return request.query_params.get("access_code") or None
    return None


async def auth_gate(request: Request) -> None:
    """App-level dependency: every non-public route needs a valid role."""
    path = request.url.path
    if path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES):
        request.state.user = None
        return
    user = resolve_user(_bearer(request))
    if user is None:
        raise HTTPException(401, "Sign in with an access code to continue.")
    request.state.user = user


def current_user(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(401, "Sign in with an access code to continue.")
    return user


def require_reviewer(request: Request) -> dict:
    user = current_user(request)
    if user["role"] != "reviewer":
        raise HTTPException(403, "Only an invoice reviewer can do this. Approvals are kept separate from procurement on purpose.")
    return user


def require_admin(request: Request) -> dict:
    user = current_user(request)
    if user["role"] != "admin":
        raise HTTPException(403, "Only an administrator can do this. Ask procurement, or switch to the administrator role if you have its access code.")
    return user
