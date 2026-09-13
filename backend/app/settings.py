"""Runtime workspace settings that procurement can change without a redeploy.

These are *policy switches*, not per-run data: they live in a small JSON file
next to the database (same place `connectors.py` keeps the watched-folder
choice) so a workspace reset — which clears invoices — never silently reverts a
decision procurement made about how the AI should behave.

Each workspace carries its own switches, for the same reason it carries its own
invoices: on a shared demo one visitor flipping a switch must not change how
another visitor's invoices are decided.

Today there is one switch, `unknown_supplier_action`, which decides what happens
when an invoice names a supplier that is not in the register:

  reject  (default)  the invoice is rejected outright; nothing is posted and no
                     procurement request is raised. Unknown suppliers cannot be
                     paid, so this is the safe default.
  ticket             the invoice is held and Invoice AI opens an
                     `onboard_supplier` request for procurement.

Only a *verified* supplier name can trigger either path — an unreadable name is
uncertainty, not evidence that a supplier is absent, and always holds. That
distinction lives in the pipeline (`gates.vendor_resolved` is tri-state); this
module only carries the choice.
"""
from __future__ import annotations

import json
import threading
from dataclasses import replace
from pathlib import Path

from .policy import DEFAULT_POLICY, UNKNOWN_SUPPLIER_ACTIONS, Policy

SETTINGS_FILE = "workspace-settings.json"

DEFAULTS: dict = {"unknown_supplier_action": "reject"}

_guard = threading.Lock()


def _coerce(raw: dict) -> dict:
    values = dict(DEFAULTS)
    action = raw.get("unknown_supplier_action")
    if action in UNKNOWN_SUPPLIER_ACTIONS:
        values["unknown_supplier_action"] = action
    return values


def load(directory: Path) -> dict:
    """Read one workspace's switches. Malformed or absent file -> defaults."""
    try:
        saved = json.loads((Path(directory) / SETTINGS_FILE).read_text())
    except (OSError, ValueError):
        saved = {}
    return _coerce(saved if isinstance(saved, dict) else {})


def get() -> dict:
    """The switches of the workspace this request belongs to."""
    from .workspaces import current
    return dict(current().values)


def update(changes: dict) -> dict:
    """Apply and persist for the current workspace. Unknown keys and invalid
    values are rejected loudly — a silently ignored setting is worse than an
    error."""
    from .workspaces import current
    action = changes.get("unknown_supplier_action")
    if action is not None and action not in UNKNOWN_SUPPLIER_ACTIONS:
        raise ValueError(f"unknown_supplier_action must be one of {', '.join(UNKNOWN_SUPPLIER_ACTIONS)}")
    ws = current()
    with _guard:
        values = dict(ws.values)
        if action is not None:
            values["unknown_supplier_action"] = action
        ws.values = values
        ws.dir.mkdir(parents=True, exist_ok=True)
        (ws.dir / SETTINGS_FILE).write_text(json.dumps(values, indent=1))
        return dict(values)


def policy_for(values: dict) -> Policy:
    """DEFAULT_POLICY with one workspace's switches applied."""
    action = (values or {}).get("unknown_supplier_action", DEFAULTS["unknown_supplier_action"])
    return replace(DEFAULT_POLICY, unknown_vendor_action=action)


def current_policy() -> Policy:
    """The policy of the workspace this request belongs to. Every decision path
    resolves through here, so a change takes effect on the next run without a
    restart — and each run still records the version it ran under."""
    from .workspaces import current
    return policy_for(current().values)
