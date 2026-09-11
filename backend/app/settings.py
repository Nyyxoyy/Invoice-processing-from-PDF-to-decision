"""Runtime workspace settings that procurement can change without a redeploy.

These are *policy switches*, not per-run data: they live in a small JSON file
next to the database (same place `connectors.py` keeps the watched-folder
choice) so a workspace reset — which clears invoices — never silently reverts a
decision procurement made about how the AI should behave.

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
_state: dict = {"path": None, "values": dict(DEFAULTS)}


def _coerce(raw: dict) -> dict:
    values = dict(DEFAULTS)
    action = raw.get("unknown_supplier_action")
    if action in UNKNOWN_SUPPLIER_ACTIONS:
        values["unknown_supplier_action"] = action
    return values


def init(data_dir: str) -> dict:
    """Bind the settings file and load it. Malformed or absent file -> defaults."""
    path = Path(data_dir) / SETTINGS_FILE
    try:
        saved = json.loads(path.read_text())
    except (OSError, ValueError):
        saved = {}
    with _guard:
        _state["path"] = path
        _state["values"] = _coerce(saved if isinstance(saved, dict) else {})
        return dict(_state["values"])


def get() -> dict:
    with _guard:
        return dict(_state["values"])


def update(changes: dict) -> dict:
    """Apply and persist. Unknown keys and invalid values are rejected loudly —
    a silently ignored setting is worse than an error."""
    action = changes.get("unknown_supplier_action")
    if action is not None and action not in UNKNOWN_SUPPLIER_ACTIONS:
        raise ValueError(f"unknown_supplier_action must be one of {', '.join(UNKNOWN_SUPPLIER_ACTIONS)}")
    with _guard:
        values = dict(_state["values"])
        if action is not None:
            values["unknown_supplier_action"] = action
        _state["values"] = values
        path = _state["path"]
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(values, indent=1))
        return dict(values)


def current_policy() -> Policy:
    """DEFAULT_POLICY with the workspace switches applied. Every decision path
    resolves the policy through here, so a change takes effect on the next run
    without a restart — and each run still records the version it ran under."""
    return replace(DEFAULT_POLICY, unknown_vendor_action=get()["unknown_supplier_action"])
