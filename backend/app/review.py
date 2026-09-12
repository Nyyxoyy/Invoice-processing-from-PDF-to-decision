"""Reviewer workflow.

Corrections append immutable field revisions — the prior interpretation is
always preserved. Approval is NOT an override: it is a full reevaluation of the
latest revision against fresh vendor/PO/ledger state, with the decision
recorded as a new review run (decision_mode='reviewer'). Gates the reviewer
cannot legitimately clear (duplicates, stale budget) still decide the outcome.
"""
from __future__ import annotations

import json
import sqlite3
import uuid

from . import ledger
from .db import alias_list
from .ledger import CommitResult, commit_decision
from .normalize import (readings, unusable_reason,
                        extract_amount, extract_currency, extract_date_iso,
                        extract_invoice_number, extract_name, normalize_field,
                        quantize_minor)
from .policy import Policy
from .rules import ResolverInput
from .validate import FieldRecord, assess, CurrencyResolution


FIELD_EXPECTED = {
    "invoice_date": "YYYY-MM-DD, e.g. 2021-12-16",
    "due_date": "YYYY-MM-DD, e.g. 2022-01-15",
    "currency": "an ISO currency code, e.g. EUR or USD",
    "subtotal_net": "a number, e.g. 2553.91",
    "tax_total": "a number, e.g. 255.39",
    "shipping_total": "a number, e.g. 50.00",
    "invoice_gross_total": "a number, e.g. 2809.30",
    "amount_due": "a number, e.g. 2809.30",
    "po_reference": "a purchase order id, e.g. PO-2001",
    "invoice_number": "the bare invoice number, e.g. 1213",
    "supplier_name": "a vendor from the vendor master, exactly as listed",
    "buyer_name": "the billed-to company name",
}

REQUIRED_FOR_APPROVAL = {"supplier_name", "invoice_number", "invoice_date", "currency",
                         "subtotal_net", "tax_total", "invoice_gross_total", "po_reference"}


def field_diagnosis(name: str, rec) -> dict | None:
    """Why this field blocks approval, what format is accepted, and — when the
    normalizer can already derive it — a suggested corrected value."""
    if name not in REQUIRED_FOR_APPROVAL:
        return None
    if rec.review_status in ("corrected", "attested") and rec.checks.get("normalization") != "fail":
        return None
    expected = FIELD_EXPECTED.get(name, "")
    normalized = normalize_field(name, rec.raw_value) if rec.raw_value else None
    suggestion = str(normalized) if normalized is not None else None

    if rec.status != "selected" or rec.raw_value is None:
        return {"why": "Not stated on the document (or not found). Enter it if you can see it on the pages above; if it genuinely isn't there, this may be a reason to reject.",
                "expected": expected, "suggestion": None}
    checks = rec.checks or {}
    if checks.get("normalization") == "fail":
        return {"why": unusable_reason(name, rec.raw_value) or f'"{rec.raw_value}" could not be converted to a usable value.',
                "expected": expected, "suggestion": suggestion}
    if rec.read_method == "llm_vision":
        if rec.self_verified():
            return None   # confirmed by an independent reading or a hard cross-check
        return {"why": "Read from a scanned image — no text to verify against. Check it on the page above, then attest it below.",
                "expected": expected, "suggestion": None}
    if checks.get("source_match") == "fail":
        return {"why": "This value could not be found in the document text — it may have been misread.",
                "expected": expected, "suggestion": suggestion}
    if checks.get("role_check") == "fail":
        return {"why": f"A value was found, but nothing on the document labels it as the {name.replace('_', ' ')} — confirm it is the right one.",
                "expected": expected,
                "suggestion": suggestion if suggestion and suggestion != rec.raw_value else (rec.raw_value if suggestion else None)}
    return None


# ---------------------------------------------------------------------------
# Unified diagnosis: ONE pass from the decision codes to (a) checklist items
# with fix targets and (b) per-field problems. The banner checklist and the
# review panel both render from this, so they cannot disagree.
# ---------------------------------------------------------------------------

_NOT_FIXABLE_BY_EDIT = {
    "DUP_FILE_HASH": "Exact same file was already processed. Nothing to edit — open the original run instead.",
    "DUP_INVOICE_NO": "This invoice number already posted. Duplicates are final — nothing to edit.",
    "DUP_FINGERPRINT": "Same supplier, amount and date as an existing invoice. Compare with the original; approve only if genuinely separate, otherwise reject.",
    "CONTENT_CONFLICT": "Same invoice number as a posted invoice but a different amount. Establish which version is right before anything posts.",
    "PO_BUDGET_EXCEEDED": "Approving would exceed the PO budget. Verify the amount, or amend the PO — then approve.",
    "VENDOR_BLOCKED": "Supplier is blocked. No edit can make this payable — reject.",
    "UNSUPPORTED_DOCUMENT_TYPE": "Not a standard invoice. Handle outside this workflow — reject here.",
    "VARIANCE_EXCEPTION": "Small overage inside the authorized band — informational, logged for audit.",
}


def _latest_event(conn, run_id: str, event_type: str) -> dict | None:
    row = conn.execute(
        "SELECT payload FROM run_events WHERE run_id=? AND event_type=? ORDER BY seq DESC LIMIT 1",
        (run_id, event_type)).fetchone()
    return json.loads(row["payload"]) if row else None


def _vendor_names(conn) -> list[tuple[str, str]]:
    out = []
    for row in conn.execute("SELECT supplier_id, name, aliases FROM vendors WHERE status='approved'"):
        out.append((row["name"], row["name"]))
        for a in alias_list(row["aliases"]):
            out.append((a, row["name"]))
    return out


def diagnose_run(conn, run_id: str, fields: dict[str, FieldRecord], context: dict) -> dict:
    """Returns {"items": [...checklist...], "field_problems": {field: {...}}}.
    Every decision code becomes exactly one checklist item, and every code
    that a reviewer can fix by editing points at the field(s) to edit."""
    import difflib
    from .pipeline import resolve_vendor
    from .normalize import extract_po_refs

    decision = _latest_event(conn, run_id, "decision") or {}
    gates = _latest_event(conn, run_id, "gates") or {}
    codes: list[str] = list(decision.get("codes") or [])
    items: list[dict] = []
    field_problems: dict[str, dict] = {}

    def add_field(name: str, why: str, code: str, suggestion: str | None = None):
        fp = field_problems.setdefault(name, {"why": [], "codes": [], "expected": FIELD_EXPECTED.get(name, ""), "suggestion": None})
        fp["why"].append(why)
        fp["codes"].append(code)
        if suggestion and not fp["suggestion"]:
            fp["suggestion"] = suggestion

    def rec(name):
        return fields.get(name)

    def raw(name):
        r = rec(name)
        return r.raw_value if r and r.status == "selected" else None

    supplier_raw = raw("supplier_name")
    vendor = resolve_vendor(conn, extract_name(supplier_raw) if supplier_raw else None)
    po_refs_doc: list[str] = list(context.get("po_references") or [])
    po_raw = raw("po_reference")
    # current currency: a corrected field wins over the original document context
    cur_rec = rec("currency")
    currency_code = None
    if cur_rec and cur_rec.status == "selected" and cur_rec.raw_value:
        currency_code = extract_currency(cur_rec.raw_value)
    if currency_code is None:
        currency_code = (context.get("currency") or {}).get("code")

    # PO as it stands now: the (possibly corrected) reference, checked against
    # the PO table for the resolved vendor
    po_now = None
    po_ok = False
    if po_raw:
        refs = extract_po_refs(po_raw)
        po_now = refs[0] if len(refs) == 1 else None
        if po_now and vendor is not None:
            row = conn.execute("SELECT status, currency, supplier_id FROM pos WHERE po_id=?", (po_now,)).fetchone()
            po_ok = bool(row and row["supplier_id"] == vendor["supplier_id"] and row["status"] == "open"
                         and (currency_code is None or row["currency"] == currency_code))
    po_corrected = bool(rec("po_reference") and rec("po_reference").review_status == "corrected")

    def still_open(code: str) -> bool:
        """Re-check the code against CURRENT state (corrections, onboarding,
        new POs). Anything we cannot re-derive here stays open until the
        pipeline re-evaluates."""
        if code == "VENDOR_UNKNOWN":
            return vendor is None
        if code == "AMBIGUOUS_CURRENCY":
            return currency_code is None
        if code == "AMBIGUOUS_DATE":
            d = rec("invoice_date")
            return not (d and d.raw_value and extract_date_iso(d.raw_value))
        if code in ("NO_PO_MATCH", "PO_CLOSED", "PO_VENDOR_MISMATCH", "PO_FUZZY_CANDIDATE", "CURRENCY_MISMATCH"):
            return not po_ok
        if code == "PO_MULTIPLE_REFS":
            return not (po_corrected and po_ok)   # reviewer picked one → resolved
        if code == "REVIEW_REQUIRED_SCAN":
            return any(r.read_method == "llm_vision" and r.status == "selected" and r.review_status not in ("attested", "corrected")
                       and not r.self_verified() for r in fields.values())
        if code == "DUP_FINGERPRINT":
            return not context.get("duplicate_confirmed")
        if code in ("MISSING_FIELD", "UNVERIFIED_FIELD"):
            return any(field_diagnosis(n, rec(n)) if rec(n) else True for n in REQUIRED_FOR_APPROVAL
                       if n not in ("po_reference", "currency"))  # those two have their own codes
        if code == "MATH_MISMATCH":
            from .validate import reconcile
            return reconcile(fields, currency_code).get("ok") is not True
        return True

    def finish_field_problems():
        """Every field problem gets: why the current reading is unusable (if it
        is) and the deterministic suggestions a reviewer may pick from — each
        with the fact it rests on. The reviewer confirms; the code never
        guesses."""
        for name, fp in field_problems.items():
            r = rec(name)
            raw_value = r.raw_value if r else None
            fp["unusable"] = unusable_reason(name, raw_value) if r and r.status == "selected" else None
            sugg: list[dict] = []
            def add(value, reason):
                if value and all(s["value"] != value for s in sugg) and value != (raw_value or "").strip():
                    sugg.append({"value": str(value), "reason": reason})
            if fp.get("suggestion"):
                add(fp["suggestion"], "as read on the document" if name != "supplier_name" else "closest approved supplier")
            if name == "currency":
                ctx = context.get("currency") or {}
                if ctx.get("code") and ctx.get("source") == "document_context":
                    add(ctx["code"], "stated elsewhere on the document")
                if po_now:
                    row = conn.execute("SELECT currency FROM pos WHERE po_id=?", (po_now,)).fetchone()
                    if row:
                        add(row["currency"], f"purchase order {po_now} is in {row['currency']}")
                if vendor is not None:
                    cur = {r2["currency"] for r2 in conn.execute(
                        "SELECT currency FROM pos WHERE supplier_id=? AND status='open'", (vendor["supplier_id"],))}
                    if len(cur) == 1:
                        add(next(iter(cur)), "the supplier’s open purchase orders are in this currency")
            for s in readings(name, raw_value, currency_code):
                add(s["value"], s["reason"])
            fp["suggestions"] = sugg
            if not fp.get("suggestion") and sugg:
                fp["suggestion"] = sugg[0]["value"]

    for code in codes:
        item = {"code": code, "label": code, "action": "", "target": None, "fields": [], "status": "open"}
        if not still_open(code):
            item["status"] = "resolved"
            item["label"] = {"VENDOR_UNKNOWN": "Supplier now in vendor master", "AMBIGUOUS_CURRENCY": "Currency set",
                             "AMBIGUOUS_DATE": "Date confirmed", "NO_PO_MATCH": "Purchase order selected",
                             "PO_MULTIPLE_REFS": "Purchase order selected", "REVIEW_REQUIRED_SCAN": "Scan fields attested",
                             "MISSING_FIELD": "Required fields completed", "UNVERIFIED_FIELD": "Fields confirmed",
                             "MATH_MISMATCH": "Amounts now reconcile",
                             "DUP_FINGERPRINT": "Confirmed as a separate invoice"}.get(code, code)
            item["action"] = "Resolved in this review — press Approve to re-evaluate and confirm."
            items.append(item)
            continue

        if code == "VENDOR_UNKNOWN":
            names = _vendor_names(conn)
            close = difflib.get_close_matches((supplier_raw or "").lower(), [n.lower() for n, _ in names], n=1, cutoff=0.75)
            canonical = next((c for n, c in names if n.lower() == close[0]), None) if close else None
            why = (f'"{supplier_raw}" is not in the vendor master.' if supplier_raw else "No supplier name was read.")
            if canonical:
                why += f' Closest approved vendor: "{canonical}".'
            add_field("supplier_name", why, code, suggestion=canonical)
            item.update(label="Supplier not in vendor master",
                        action=(f'Correct supplier_name to "{canonical}" if this is a misread of that vendor.' if canonical
                                else "Correct supplier_name to an approved vendor if this is a misread (see Vendors tab).")
                        + " If the supplier is genuinely unknown, Reject — unknown suppliers cannot be paid.",
                        target={"kind": "field", "field": "supplier_name"}, fields=["supplier_name"])

        elif code == "PO_MULTIPLE_REFS":
            why = f"The document mentions several purchase orders: {', '.join(po_refs_doc)}. Only one can be matched."
            add_field("po_reference", why, code)
            item.update(label="Document mentions several POs",
                        action=f"Set po_reference to the single correct PO ({', '.join(po_refs_doc)}), or pick one from the candidates.",
                        target={"kind": "field", "field": "po_reference"}, fields=["po_reference"])

        elif code == "NO_PO_MATCH":
            if po_raw:
                known = conn.execute("SELECT po_id, supplier_id, status FROM pos WHERE po_id=?",
                                     (po_now or po_raw,)).fetchone()
                if known is None:
                    why = f'"{po_raw}" is not a purchase order in this workspace.'
                elif vendor is None:
                    why = f'"{po_raw}" exists, but the supplier could not be resolved so it cannot be confirmed.'
                else:
                    why = f'"{po_raw}" could not be confirmed for this supplier.'
            else:
                why = "No purchase order reference was found on the document."
            if vendor is None:
                why += " PO candidates appear once the supplier is resolved."
            add_field("po_reference", why, code)
            item.update(label="No purchase order confirmed",
                        action=("Pick the right PO from the candidates on the right." if vendor is not None
                                else "Resolve the supplier first (item above), then pick a PO from the candidates."),
                        target={"kind": "po" if vendor is not None else "field", "field": "po_reference"}, fields=["po_reference"])

        elif code in ("PO_CLOSED", "PO_VENDOR_MISMATCH", "PO_FUZZY_CANDIDATE", "CURRENCY_MISMATCH"):
            why = {
                "PO_CLOSED": f'"{po_raw}" is closed — it cannot take new invoices.',
                "PO_VENDOR_MISMATCH": f'"{po_raw}" belongs to a different supplier.',
                "PO_FUZZY_CANDIDATE": "The PO match is only a guess, not an explicit reference.",
                "CURRENCY_MISMATCH": f'The invoice currency ({currency_code}) differs from the PO currency.',
            }[code]
            add_field("po_reference", why, code)
            item.update(label={"PO_CLOSED": "Referenced PO is closed", "PO_VENDOR_MISMATCH": "PO belongs to a different supplier",
                               "PO_FUZZY_CANDIDATE": "PO match is a guess", "CURRENCY_MISMATCH": "Invoice and PO currencies differ"}[code],
                        action="Pick a valid PO for this supplier (and currency) from the candidates.",
                        target={"kind": "po", "field": "po_reference"}, fields=["po_reference"])

        elif code == "AMBIGUOUS_CURRENCY":
            cur_raw = raw("currency")
            why = (f'"{cur_raw}" does not contain a recognizable currency code.' if cur_raw
                   else "No currency code (USD, EUR, ...) appears anywhere on the document. A bare symbol like $ is not enough — it is shared by several currencies.")
            add_field("currency", why, code)
            item.update(label="Currency not clearly stated",
                        action="Set currency to the ISO code the invoice is in (e.g. USD, EUR). Check the amounts on the page to be sure.",
                        target={"kind": "field", "field": "currency"}, fields=["currency"])

        elif code == "AMBIGUOUS_DATE":
            d_raw = raw("invoice_date") or ""
            import re as _re
            m = _re.search(r"(\d{1,2})[./-](\d{1,2})[./-](\d{4})", d_raw)
            both = ""
            if m:
                a, b, y = m.groups()
                both = f" It could be {y}-{int(b):02d}-{int(a):02d} (day-first) or {y}-{int(a):02d}-{int(b):02d} (month-first)."
            add_field("invoice_date", f'"{d_raw}" reads two ways.{both}', code)
            item.update(label="Date reads two ways",
                        action="Confirm which reading is right from the document and correct invoice_date to YYYY-MM-DD.",
                        target={"kind": "field", "field": "invoice_date"}, fields=["invoice_date"])

        elif code == "MATH_MISMATCH":
            detail = gates.get("reconciliation") or "the stated amounts do not reconcile"
            for f in ("subtotal_net", "tax_total", "shipping_total", "invoice_gross_total"):
                if rec(f):
                    add_field(f, f"Amounts do not add up: {detail}.", code)
            item.update(label="Amounts on the document do not add up",
                        action=f"Check subtotal, tax, shipping and total against the page ({detail}) and correct the wrong one.",
                        target={"kind": "field", "field": "invoice_gross_total"},
                        fields=["subtotal_net", "tax_total", "shipping_total", "invoice_gross_total"])

        elif code == "UNSUPPORTED_AMOUNT_STRUCTURE":
            add_field("amount_due", "Amount due differs from the invoice total — a prepayment or adjustment this workflow does not auto-approve.", code)
            item.update(label="Contains a prepayment or adjustment",
                        action="Verify manually. If the gross total is what should post, this still needs a human decision — approve only if policy allows, else reject.",
                        target={"kind": "field", "field": "amount_due"}, fields=["amount_due"])

        elif code == "REVIEW_REQUIRED_SCAN":
            scan_fields = [n for n, r in fields.items() if r.read_method == "llm_vision" and r.status == "selected"
                           and r.review_status not in ("attested", "corrected") and not r.self_verified()]
            for n in scan_fields:
                add_field(n, "Read from a scanned image — verify it against the page, then attest.", code)
            item.update(label="Values read from a scanned image",
                        action=f"Check {', '.join(scan_fields) or 'the scan-read fields'} against the page image, then tick and Attest.",
                        target={"kind": "attest"}, fields=scan_fields)

        elif code in ("MISSING_FIELD", "UNVERIFIED_FIELD"):
            bad = []
            for n in sorted(REQUIRED_FOR_APPROVAL):
                r = rec(n)
                diag = field_diagnosis(n, r) if r else {"why": "Not found on the document.", "expected": FIELD_EXPECTED.get(n, ""), "suggestion": None}
                if diag:
                    add_field(n, diag["why"], code, suggestion=diag.get("suggestion"))
                    bad.append(n)
            item.update(label=("Required fields missing or unverified: " + ", ".join(bad)) if bad else "A required field is missing or unverified",
                        action="Fill or confirm each flagged field below (a suggestion chip appears where the value can be derived).",
                        target={"kind": "problems"}, fields=bad)

        elif code in _NOT_FIXABLE_BY_EDIT:
            item.update(label=code.replace("_", " ").capitalize(), action=_NOT_FIXABLE_BY_EDIT[code], target=None)

        else:
            item.update(action="Review below.")

        items.append(item)

    # collapse per-field why lists into text, de-duplicated, keep codes
    for name, fp in field_problems.items():
        seen = []
        for w in fp["why"]:
            if w not in seen:
                seen.append(w)
        fp["why"] = " ".join(seen)
        fp["codes"] = sorted(set(fp["codes"]))
        if fp["suggestion"] is None:
            r = rec(name)
            norm = normalize_field(name, r.raw_value) if r and r.raw_value else None
            if norm is not None and str(norm) != (r.raw_value or "") and name != "supplier_name":
                fp["suggestion"] = str(norm)
    open_codes = [i["code"] for i in items if i["status"] == "open"]
    finish_field_problems()
    return {"codes": codes, "open_codes": open_codes, "items": items, "field_problems": field_problems,
            "vendor_resolved": vendor is not None}


# ---------------------------------------------------------------------------
# Master-data actions (procurement's job in real AP). Exposed in the demo so a
# hold on an unknown supplier / missing PO can be resolved end to end. Each
# action is recorded on the run's audit trail when a run_id is given.
# ---------------------------------------------------------------------------

def _slug(name: str) -> str:
    import re as _re
    s = _re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return "sup-" + (s[:40] or "vendor")


def onboard_vendor(conn, name: str, country: str | None, actor: str, run_id: str | None = None) -> dict:
    name = " ".join((name or "").split())
    if len(name) < 2:
        raise ReviewError(422, "vendor name too short")
    from .pipeline import resolve_vendor
    if resolve_vendor(conn, name) is not None:
        raise ReviewError(409, f'"{name}" is already in the vendor master')
    supplier_id = _slug(name)
    if conn.execute("SELECT 1 FROM vendors WHERE supplier_id=?", (supplier_id,)).fetchone():
        supplier_id += "-" + uuid.uuid4().hex[:4]
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            "INSERT INTO vendors (supplier_id, name, status, country, aliases) VALUES (?, ?, 'approved', ?, ?)",
            (supplier_id, name, (country or "").upper() or None, json.dumps([name.lower()])))
        if run_id:
            ledger._emit(conn, run_id, "MASTER", "vendor_onboarded",
                         {"supplier_id": supplier_id, "name": name, "actor": actor})
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return {"supplier_id": supplier_id, "name": name, "status": "approved"}


def vendor_aliases(row) -> list[str]:
    """Other names this supplier is known by (subsidiaries, brands, trading
    names), excluding its own legal name."""
    return [a for a in alias_list(row["aliases"]) if a != row["name"].lower()]


def update_vendor(conn, supplier_id: str, *, name: str | None = None, country: str | None = None,
                  status: str | None = None, aliases: list[str] | None = None,
                  add_aliases: list[str] | None = None, actor: str = "procurement@demo",
                  run_id: str | None = None) -> dict:
    """Edit a supplier. A rename keeps the old name as an alias so invoices that
    print the old name still resolve; status may be toggled approved/blocked.
    `aliases` replaces the list of other names, `add_aliases` extends it — the
    way a subsidiary or trading name ("White Group") is tied to the approved
    parent, so invoices printing that name resolve to it from then on."""
    row = conn.execute("SELECT * FROM vendors WHERE supplier_id=?", (supplier_id,)).fetchone()
    if row is None:
        raise ReviewError(404, "unknown supplier")
    new_name = " ".join((name or row["name"]).split())
    if len(new_name) < 2:
        raise ReviewError(422, "supplier name too short")
    if status is not None and status not in ("approved", "blocked"):
        raise ReviewError(422, "status must be approved or blocked")
    from .pipeline import resolve_vendor
    clash = resolve_vendor(conn, new_name)
    if clash is not None and clash["supplier_id"] != supplier_id:
        raise ReviewError(409, f'"{new_name}" already belongs to another supplier')
    current = alias_list(row["aliases"])
    if aliases is not None:
        wanted = []
        for a in aliases:
            a = " ".join((a or "").split()).lower()
            if len(a) >= 2 and a not in wanted:
                wanted.append(a)
        current = wanted
    added = []
    for a in add_aliases or []:
        a = " ".join((a or "").split()).lower()
        if len(a) < 2:
            raise ReviewError(422, "a supplier name must have at least 2 characters")
        if a not in current:
            current.append(a); added.append(a)
    for a in current:
        other = resolve_vendor(conn, a)
        if other is not None and other["supplier_id"] != supplier_id:
            raise ReviewError(409, f'"{a}" already belongs to {other["name"]}')
    if new_name.lower() != row["name"].lower() and row["name"].lower() not in current:
        current.append(row["name"].lower())
    if new_name.lower() not in current:
        current.append(new_name.lower())
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            "UPDATE vendors SET name=?, country=?, status=?, aliases=? WHERE supplier_id=?",
            (new_name,
             ((country if country is not None else row["country"]) or "").upper() or None,
             status or row["status"], json.dumps(current), supplier_id))
        if added and run_id:
            ledger._emit(conn, run_id, "MASTER", "vendor_alias_added",
                         {"supplier_id": supplier_id, "name": new_name, "aliases": added, "actor": actor})
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    out = conn.execute("SELECT * FROM vendors WHERE supplier_id=?", (supplier_id,)).fetchone()
    return {"supplier_id": out["supplier_id"], "name": out["name"], "status": out["status"],
            "country": out["country"], "aliases": vendor_aliases(out)}


def delete_vendor(conn, supplier_id: str) -> dict:
    """Remove a supplier that nothing references. Suppliers with purchase
    orders or invoices are protected (history must stay coherent) — block them
    instead, which stops any future approval."""
    row = conn.execute("SELECT 1 FROM vendors WHERE supplier_id=?", (supplier_id,)).fetchone()
    if row is None:
        raise ReviewError(404, "unknown supplier")
    n_pos = conn.execute("SELECT COUNT(*) c FROM pos WHERE supplier_id=?", (supplier_id,)).fetchone()["c"]
    n_inv = conn.execute("SELECT COUNT(*) c FROM invoices WHERE supplier_id=?", (supplier_id,)).fetchone()["c"]
    if n_pos or n_inv:
        parts = []
        if n_pos:
            parts.append(f"{n_pos} purchase order{'s' if n_pos != 1 else ''}")
        if n_inv:
            parts.append(f"{n_inv} invoice{'s' if n_inv != 1 else ''}")
        raise ReviewError(409, f"This supplier has {' and '.join(parts)} on record and cannot be deleted. "
                               "Block the supplier instead to stop future approvals.")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DELETE FROM vendors WHERE supplier_id=?", (supplier_id,))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return {"ok": True, "deleted": supplier_id}


def update_po(conn, po_id: str, *, amount: str | None = None, status: str | None = None,
              actor: str = "admin@demo") -> dict:
    """Amend a purchase order. The authorized amount can change but never below
    what has already been approved against it; status toggles open/closed."""
    from decimal import Decimal, InvalidOperation
    from .normalize import quantize_minor
    row = conn.execute("SELECT * FROM pos WHERE po_id=?", (po_id,)).fetchone()
    if row is None:
        raise ReviewError(404, "unknown purchase order")
    if status is not None and status not in ("open", "closed"):
        raise ReviewError(422, "status must be open or closed")
    consumed = conn.execute(
        "SELECT COALESCE(SUM(CASE kind WHEN 'reversal' THEN -amount_minor ELSE amount_minor END), 0) c "
        "FROM ledger_events WHERE po_id=?", (po_id,)).fetchone()["c"]
    new_minor = row["amount_minor"]
    if amount is not None and str(amount).strip() != "":
        try:
            new_minor = quantize_minor(Decimal(str(amount).replace(",", "")), row["currency"])
        except InvalidOperation:
            new_minor = None
        if new_minor is None or new_minor <= 0:
            raise ReviewError(422, f"amount must be a positive number with at most the {row['currency']} minor-unit precision")
        if new_minor < consumed:
            raise ReviewError(409, f"amount cannot be lower than what is already approved against this order "
                                   f"({row['currency']} {consumed / 100:,.2f})")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("UPDATE pos SET amount_minor=?, status=? WHERE po_id=?",
                     (new_minor, status or row["status"], po_id))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    out = conn.execute("SELECT po_id, supplier_id, currency, amount_minor, status FROM pos WHERE po_id=?",
                       (po_id,)).fetchone()
    return {**dict(out), "consumed_minor": int(consumed)}


def delete_po(conn, po_id: str) -> dict:
    """Remove a purchase order that has no ledger history. Orders with
    approved billing are protected — close them instead."""
    row = conn.execute("SELECT 1 FROM pos WHERE po_id=?", (po_id,)).fetchone()
    if row is None:
        raise ReviewError(404, "unknown purchase order")
    n = conn.execute("SELECT COUNT(*) c FROM ledger_events WHERE po_id=?", (po_id,)).fetchone()["c"]
    if n:
        raise ReviewError(409, "This purchase order has approved billing recorded against it and cannot be deleted. "
                               "Close it instead to stop further invoices.")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DELETE FROM pos WHERE po_id=?", (po_id,))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return {"ok": True, "deleted": po_id}


PROCUREMENT_CODES = {
    "VENDOR_UNKNOWN": "Onboard the supplier (or confirm it is a misread of an approved supplier).",
    "VENDOR_BLOCKED": "Supplier is blocked — decide whether it should be approved again.",
    "NO_PO_MATCH": "Raise or identify the purchase order this invoice bills against.",
    "PO_CLOSED": "The referenced purchase order is closed — reopen it or raise a new one.",
    "PO_BUDGET_EXCEEDED": "Approving would exceed the authorized amount — amend the purchase order or confirm the invoice is wrong.",
    "CURRENCY_MISMATCH": "The invoice currency differs from the purchase order — raise an order in the invoice currency.",
}


PROCUREMENT_KIND = {"VENDOR_UNKNOWN": "onboard_supplier", "VENDOR_BLOCKED": "unblock_supplier",
                    "NO_PO_MATCH": "raise_po", "PO_CLOSED": "raise_po", "CURRENCY_MISMATCH": "raise_po",
                    "PO_VENDOR_MISMATCH": "raise_po", "PO_BUDGET_EXCEEDED": "amend_po"}


def procurement_asks(conn, fields: dict, context: dict, diag: dict) -> list[dict]:
    """What procurement still owes on this invoice, derived from the open
    blockers and CURRENT master data. Once the supplier is approved and an
    order the reviewer can select exists, nothing is owed — the rest is the
    reviewer's. Shared by the queue, the review view and the admin inbox so
    they cannot disagree."""
    cur_rec = fields.get("currency")
    currency = (extract_currency(cur_rec.raw_value) if cur_rec and cur_rec.raw_value else None) \
        or (context.get("currency") or {}).get("code")
    selectable = [po for po in po_candidates(conn, fields) if not currency or po["currency"] == currency]
    asks = []
    for code in diag["open_codes"]:
        if code not in PROCUREMENT_CODES:
            continue
        if code == "NO_PO_MATCH":
            if not diag["vendor_resolved"]:
                continue  # onboarding comes first; the PO ask appears after
            if selectable:
                continue  # an open order exists — the reviewer just has to select it
        if code == "PO_BUDGET_EXCEEDED":
            from .normalize import extract_po_refs
            po_rec = fields.get("po_reference")
            refs = extract_po_refs(po_rec.raw_value) if po_rec and po_rec.raw_value else []
            gross_rec = fields.get("invoice_gross_total")
            gross = extract_amount(gross_rec.raw_value) if gross_rec and gross_rec.raw_value else None
            if len(refs) == 1 and gross is not None and currency:
                po = conn.execute("SELECT * FROM pos WHERE po_id=?", (refs[0],)).fetchone()
                gm = quantize_minor(gross, currency)
                if po and gm is not None and po["currency"] == currency \
                        and po["amount_minor"] - ledger.consumed_minor(conn, po["po_id"]) >= gm:
                    continue  # the order was amended; the reviewer re-checks
        asks.append({"code": code, "kind": PROCUREMENT_KIND.get(code, "other"), "text": PROCUREMENT_CODES[code]})
    return asks


def invoices_by_po(conn) -> dict[str, list[dict]]:
    """Every invoice that belongs to each purchase order: posted ones from the
    ledger (authoritative), plus current held/rejected runs whose latest
    reading references the order. Each entry links to its run."""
    from .normalize import extract_po_refs
    out: dict[str, list[dict]] = {}
    seen_runs: set[str] = set()
    for r in conn.execute(
        "SELECT le.po_id, le.run_id, i.invoice_no_raw AS invoice_no, i.gross_minor, i.currency, r.disposition, r.created_at, "
        "v.name AS supplier_name FROM ledger_events le JOIN invoices i ON i.invoice_id = le.invoice_id "
        "JOIN runs r ON r.run_id = le.run_id JOIN vendors v ON v.supplier_id = i.supplier_id "
        "WHERE le.kind = 'posting' ORDER BY le.created_at DESC").fetchall():
        out.setdefault(r["po_id"], []).append({
            "run_id": r["run_id"], "invoice_no": r["invoice_no"], "supplier_name": r["supplier_name"],
            "amount_minor": r["gross_minor"], "currency": r["currency"], "disposition": "approved",
            "created_at": r["created_at"], "posted": True})
        seen_runs.add(r["run_id"])
    known = {row["po_id"] for row in conn.execute("SELECT po_id FROM pos")}
    for r in conn.execute(
        "SELECT r.run_id, r.disposition, r.created_at, "
        "(SELECT fields_json FROM field_revisions f WHERE f.run_id = r.run_id ORDER BY seq DESC LIMIT 1) AS fields_json "
        "FROM runs r WHERE r.disposition IN ('held', 'rejected') AND r.run_id NOT IN "
        "(SELECT parent_run_id FROM runs WHERE parent_run_id IS NOT NULL) ORDER BY r.created_at DESC").fetchall():
        if r["run_id"] in seen_runs or not r["fields_json"]:
            continue
        fields = json.loads(r["fields_json"])
        raw_po = (fields.get("po_reference") or {}).get("raw_value") or ""
        refs = [raw_po.strip()] if raw_po.strip() in known else extract_po_refs(raw_po)
        if len(refs) != 1 or refs[0] not in known:
            continue
        from .normalize import display_values
        shown = display_values({n: (rec or {}).get("raw_value") for n, rec in fields.items()})
        out.setdefault(refs[0], []).append({
            "run_id": r["run_id"], "invoice_no": shown.get("invoice_number"),
            "supplier_name": shown.get("supplier_name"),
            "amount_raw": shown.get("invoice_gross_total"), "disposition": r["disposition"],
            "created_at": r["created_at"], "posted": False})
    return out


def procurement_queue(conn) -> list[dict]:
    """Held invoices whose open blockers need a procurement action. Derived from
    the live diagnosis of each current (non-superseded) held run."""
    rows = conn.execute(
        "SELECT r.run_id, d.filename FROM runs r JOIN documents d USING (document_id) "
        "WHERE r.disposition='held' AND r.run_id NOT IN "
        "(SELECT parent_run_id FROM runs WHERE parent_run_id IS NOT NULL) "
        "ORDER BY r.created_at DESC").fetchall()
    out = []
    for r in rows:
        try:
            seq, fields, context = load_latest(conn, r["run_id"])
        except ReviewError:
            continue
        diag = diagnose_run(conn, r["run_id"], fields, context)
        asks = procurement_asks(conn, fields, context, diag)
        if asks:
            sup = fields.get("supplier_name")
            out.append({"run_id": r["run_id"], "filename": r["filename"],
                        "supplier_name": sup.raw_value if sup else None,
                        "po_reference": (fields.get("po_reference").raw_value if fields.get("po_reference") else None),
                        "asks": asks})
    return out


def create_po(conn, po_id: str, supplier_id: str, currency: str, amount: str, actor: str,
              run_id: str | None = None) -> dict:
    from decimal import Decimal, InvalidOperation
    from .currencies import is_supported
    from .normalize import quantize_minor
    po_id = (po_id or "").strip()
    if not po_id:
        raise ReviewError(422, "PO id required")
    if conn.execute("SELECT 1 FROM pos WHERE po_id=?", (po_id,)).fetchone():
        raise ReviewError(409, f"{po_id} already exists")
    if conn.execute("SELECT 1 FROM vendors WHERE supplier_id=?", (supplier_id,)).fetchone() is None:
        raise ReviewError(404, "unknown supplier")
    currency = (currency or "").upper()
    if not is_supported(currency):
        raise ReviewError(422, f"unsupported currency code: {currency!r}")
    try:
        minor = quantize_minor(Decimal(str(amount).replace(",", "")), currency)
    except InvalidOperation:
        minor = None
    if minor is None or minor <= 0:
        raise ReviewError(422, f"amount must be a positive number with at most the {currency} minor-unit precision")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("INSERT INTO pos (po_id, supplier_id, currency, amount_minor, status) VALUES (?, ?, ?, ?, 'open')",
                     (po_id, supplier_id, currency, minor))
        if run_id:
            ledger._emit(conn, run_id, "MASTER", "po_created",
                         {"po_id": po_id, "supplier_id": supplier_id, "currency": currency,
                          "amount_minor": minor, "actor": actor})
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return {"po_id": po_id, "supplier_id": supplier_id, "currency": currency, "amount_minor": minor, "status": "open"}


class ReviewError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def save_revision(conn, run_id: str, source: str, actor: str | None,
                  fields: dict[str, FieldRecord], context: dict) -> int:
    seq = conn.execute(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM field_revisions WHERE run_id=?",
        (run_id,)).fetchone()["s"]
    conn.execute(
        "INSERT INTO field_revisions (revision_id, run_id, seq, source, actor, fields_json, context_json) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (_uid("rev"), run_id, seq, source, actor,
         json.dumps({f: vars(r) for f, r in fields.items()}), json.dumps(context)))
    return seq


def load_latest(conn, run_id: str) -> tuple[int, dict[str, FieldRecord], dict]:
    row = conn.execute(
        "SELECT seq, fields_json, context_json FROM field_revisions "
        "WHERE run_id=? ORDER BY seq DESC LIMIT 1", (run_id,)).fetchone()
    if row is None:
        raise ReviewError(404, "run has no field revisions (nothing reviewable)")
    fields = {f: FieldRecord(**v) for f, v in json.loads(row["fields_json"]).items()}
    return row["seq"], fields, json.loads(row["context_json"])


# Rejections caused only by the state of the supplier register: procurement can
# change that state (approve the supplier again, or onboard it), after which the
# same invoice deserves a fresh decision. Every other rejection is final.
RECHECKABLE_REJECT_CODES = {"VENDOR_BLOCKED", "VENDOR_UNKNOWN"}


def _rejected_only_for_supplier_state(conn, run_id: str) -> bool:
    """A rejection whose only cause is the supplier being blocked, or absent
    from the register, can legitimately be re-checked once procurement has
    approved or onboarded that supplier."""
    dec = _latest_event(conn, run_id, "decision") or {}
    codes = set(dec.get("codes") or [])
    return bool(codes) and codes <= RECHECKABLE_REJECT_CODES


def _reviewable_run(conn, run_id: str) -> sqlite3.Row:
    run = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
    if run is None:
        raise ReviewError(404, "no such run")
    if run["disposition"] == "held":
        return run
    if run["disposition"] == "rejected" and _rejected_only_for_supplier_state(conn, run_id):
        return run
    raise ReviewError(409, f"run is not held (disposition={run['disposition']}) — only held runs are reviewable")


TICKET_KINDS = {
    "unblock_supplier": "Approve a blocked supplier again",
    "onboard_supplier": "Onboard a new supplier and raise its purchase order",
    "raise_po": "Raise a purchase order",
    "amend_po": "Amend a purchase order budget",
    "other": "Other procurement request",
}


STANDALONE_KINDS = {"onboard_supplier": "Onboard a new supplier", "raise_po": "Raise a purchase order for a supplier"}


def open_standalone_request(conn, kind: str, note: str, requested_by: str,
                            subject: str | None = None, supplier_id: str | None = None,
                            amount: str | None = None, currency: str | None = None) -> dict:
    """A request raised from the Requests page, not from an invoice: onboard a
    named supplier, or raise an order for an existing supplier. Fulfilment is
    derived the same way (the record decides), so it closes itself too."""
    from .pipeline import resolve_vendor
    if kind not in STANDALONE_KINDS:
        raise ReviewError(422, "a standalone request can onboard a supplier or raise a purchase order")
    subject = " ".join((subject or "").split())
    if kind == "onboard_supplier":
        if len(subject) < 2:
            raise ReviewError(422, "Give the supplier's name.")
        v = resolve_vendor(conn, subject)
        if v is not None and v["status"] == "approved":
            raise ReviewError(409, f"Nothing to request: {v['name']} is already an approved supplier.")
        supplier_id = None
        dup = conn.execute("SELECT * FROM tickets WHERE run_id IS NULL AND kind='onboard_supplier' AND status='open' "
                           "AND lower(subject)=lower(?)", (subject,)).fetchone()
    if kind == "raise_po":
        v = conn.execute("SELECT * FROM vendors WHERE supplier_id=?", (supplier_id or "",)).fetchone()
        if v is None:
            raise ReviewError(422, "Choose the supplier the order is for.")
        subject = v["name"]
        dup = conn.execute("SELECT * FROM tickets WHERE run_id IS NULL AND kind='raise_po' AND status='open' "
                           "AND supplier_id=?", (supplier_id,)).fetchone()
    # a supplier without an order is useless to the reviewer: every request names the order it needs
    from .currencies import is_supported
    currency = (currency or "").strip().upper()
    if not is_supported(currency):
        raise ReviewError(422, "Give the order currency as a code, for example USD or EUR.")
    dec = extract_amount(amount or "")
    amount_minor = quantize_minor(dec, currency) if dec is not None else None
    if not amount_minor or amount_minor <= 0:
        raise ReviewError(422, "Give the amount the order should authorize, for example 12000.00.")
        dup = conn.execute("SELECT * FROM tickets WHERE run_id IS NULL AND kind='raise_po' AND status='open' "
                           "AND supplier_id=?", (supplier_id,)).fetchone()
    if dup:
        return {**dict(dup), "existing": True}
    known = json.dumps([r["po_id"] for r in conn.execute(
        "SELECT po_id FROM pos WHERE supplier_id=? AND status='open'", (supplier_id or "",))]) if supplier_id else "[]"
    ticket_id = _uid("tk")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            "INSERT INTO tickets (ticket_id, run_id, kind, note, requested_by, supplier_id, known_pos, subject, amount_minor, currency) "
            "VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
            (ticket_id, kind, (note or "").strip(), requested_by, supplier_id, known, subject, amount_minor, currency))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return {**dict(conn.execute("SELECT * FROM tickets WHERE ticket_id=?", (ticket_id,)).fetchone()), "existing": False}


def _standalone_fulfilled(conn, row: dict) -> tuple[bool, str | None]:
    from .pipeline import resolve_vendor
    if row["kind"] == "onboard_supplier":
        v = resolve_vendor(conn, row.get("subject") or "")
        if v is None or v["status"] != "approved":
            return False, None
        want, cur = row.get("amount_minor") or 0, row.get("currency")
        orders = conn.execute("SELECT po_id, amount_minor, currency FROM pos WHERE supplier_id=? AND status='open'",
                              (v["supplier_id"],)).fetchall()
        good = [r for r in orders if (not cur or r["currency"] == cur) and r["amount_minor"] >= want]
        if good:
            return True, f"{v['name']} is an approved supplier and order {good[0]['po_id']} ({_fmt_money(good[0]['amount_minor'], good[0]['currency'])}) is available."
        return False, f"{v['name']} is approved. Add an order of at least {_fmt_money(want, cur)} to finish the request."
    if row["kind"] == "raise_po":
        known = set(json.loads(row.get("known_pos") or "[]"))
        want, cur = row.get("amount_minor") or 0, row.get("currency")
        new = [r for r in conn.execute(
            "SELECT po_id, amount_minor, currency FROM pos WHERE supplier_id=? AND status='open'", (row.get("supplier_id"),))
            if r["po_id"] not in known]
        good = [r for r in new if (not cur or r["currency"] == cur) and r["amount_minor"] >= want]
        if good:
            r = good[0]
            return True, f"Order {r['po_id']} ({_fmt_money(r['amount_minor'], r['currency'])}) is available for {row.get('subject') or 'the supplier'}."
        if new:
            r = new[0]
            return False, f"{r['po_id']} was added, but the request asked for {_fmt_money(want, cur)}; {_fmt_money(r['amount_minor'], r['currency'])} does not cover it."
        return False, None
    return False, None


def open_ticket(conn, run_id: str, kind: str, note: str, requested_by: str) -> dict:
    """Reviewer asks procurement for something they cannot do themselves.
    One open ticket per invoice and kind; a repeat returns the existing one."""
    if kind not in TICKET_KINDS:
        raise ReviewError(422, f"unknown request kind: {kind}")
    run = conn.execute("SELECT run_id FROM runs WHERE run_id=?", (run_id,)).fetchone()
    if run is None:
        raise ReviewError(404, "no such run")
    existing = conn.execute(
        "SELECT * FROM tickets WHERE run_id=? AND kind=? AND status='open'", (run_id, kind)).fetchone()
    if existing:
        return {**dict(existing), "existing": True}
    supplier_id, known_pos = None, "[]"
    try:
        _, fields, _ctx = load_latest(conn, latest_run_in_lineage(conn, run_id))
        from .pipeline import resolve_vendor
        sup = fields.get("supplier_name")
        v = resolve_vendor(conn, extract_name(sup.raw_value) if sup and sup.raw_value else None)
        if kind == "unblock_supplier" and v is not None:
            supplier_id = v["supplier_id"]           # the request is about THIS supplier
        known_pos = json.dumps([c["po_id"] for c in po_candidates(conn, fields)])  # already there → not an answer
    except ReviewError:
        pass
    already, fact = ticket_fulfilled(conn, {"kind": kind, "run_id": run_id, "supplier_id": supplier_id, "known_pos": known_pos})
    if already:
        raise ReviewError(409, f"Nothing to request: {fact}")
    ticket_id = _uid("tk")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            "INSERT INTO tickets (ticket_id, run_id, kind, note, requested_by, supplier_id, known_pos) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (ticket_id, run_id, kind, (note or "").strip(), requested_by, supplier_id, known_pos))
        ledger._emit(conn, run_id, "REQUEST", "ticket_opened",
                     {"ticket_id": ticket_id, "kind": kind, "note": (note or "").strip(), "actor": requested_by})
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return {**dict(conn.execute("SELECT * FROM tickets WHERE ticket_id=?", (ticket_id,)).fetchone()), "existing": False}


def _fmt_money(minor: int, code: str) -> str:
    from .currencies import MINOR_UNITS
    exp = MINOR_UNITS.get(code, 2)
    return f"{code} {minor / (10 ** exp):,.{exp}f}"


def latest_run_in_lineage(conn, run_id: str) -> str:
    """The newest run descending from `run_id` (Check again creates children)
    that has a field revision — the run the reviewer is actually working on."""
    rows = conn.execute(
        "WITH RECURSIVE lineage(run_id, rid) AS ("
        "  SELECT run_id, rowid FROM runs WHERE run_id=? "
        "  UNION ALL SELECT r.run_id, r.rowid FROM runs r JOIN lineage l ON r.parent_run_id = l.run_id) "
        "SELECT run_id FROM lineage ORDER BY rid DESC", (run_id,)).fetchall()
    for r in rows:
        if conn.execute("SELECT 1 FROM field_revisions WHERE run_id=? LIMIT 1", (r["run_id"],)).fetchone():
            return r["run_id"]
    return run_id


def ticket_fulfilled(conn, row) -> tuple[bool, str | None]:
    """Does CURRENT master data already satisfy this request? Derived, never
    stored: the supplier record, the order table and the ledger are the facts,
    read against the newest run of the invoice (the reviewer keeps working on
    Check-again runs, not on the run the request was opened on).
    Returns (fulfilled, one-sentence fact). 'other' requests are never derived."""
    row = dict(row)
    kind = row["kind"]
    if not row.get("run_id"):
        return _standalone_fulfilled(conn, row)
    run_id = latest_run_in_lineage(conn, row["run_id"])
    known = set(json.loads(row.get("known_pos") or "[]"))   # orders that existed when the request was made
    pinned = row.get("supplier_id")
    try:
        _, fields, context = load_latest(conn, run_id)
    except ReviewError:
        return False, None
    from .pipeline import resolve_vendor
    sup = fields.get("supplier_name")
    vendor = resolve_vendor(conn, extract_name(sup.raw_value) if sup and sup.raw_value else None)
    cur_rec = fields.get("currency")
    currency = (extract_currency(cur_rec.raw_value) if cur_rec and cur_rec.raw_value else None) \
        or (context.get("currency") or {}).get("code")
    def order_available(new_only: bool) -> tuple[bool, str | None]:
        """The reviewer can select an order. `new_only`: only orders that did
        not exist when the request was made count — a "none of these is right"
        request is not answered by the orders that were already there."""
        diag = diagnose_run(conn, run_id, fields, context)
        po_codes = {"NO_PO_MATCH", "PO_CLOSED", "CURRENCY_MISMATCH", "PO_VENDOR_MISMATCH"}
        if (po_codes & set(diag["codes"])) and not (po_codes & set(diag["open_codes"])):
            return True, "the invoice's purchase order checks out"
        cands = [c for c in po_candidates(conn, fields) if not currency or c["currency"] == currency]
        if new_only:
            cands = [c for c in cands if c["po_id"] not in known]
        if cands:
            return True, f"an open order is available for the reviewer to select ({', '.join(c['po_id'] for c in cands)})"
        return False, None

    if kind == "onboard_supplier":
        # a new supplier has no orders: the request is done only when the
        # reviewer can also select one — otherwise they would have to ask again
        if vendor is None or vendor["status"] != "approved":
            return False, None
        ok, po_fact = order_available(new_only=False)
        if ok:
            return True, f"{vendor['name']} is an approved supplier and {po_fact}."
        return False, f"{vendor['name']} is approved. Add its purchase order to finish the request."
    if kind == "unblock_supplier":
        if pinned:
            v = conn.execute("SELECT * FROM vendors WHERE supplier_id=?", (pinned,)).fetchone()
            if v is not None and v["status"] != "blocked":
                return True, f"{v['name']} is approved again."
            if vendor is not None and vendor["supplier_id"] != pinned and vendor["status"] == "approved":
                return True, f"The invoice now names {vendor['name']}, an approved supplier."
            return False, None
        if vendor is not None and vendor["status"] != "blocked":
            return True, f"{vendor['name']} is approved again."
        return False, None
    if kind == "raise_po":
        ok, po_fact = order_available(new_only=True)
        return (True, po_fact[0].upper() + po_fact[1:] + ".") if ok else (False, None)
    if kind == "amend_po":
        from .normalize import extract_po_refs
        po_rec = fields.get("po_reference")
        refs = extract_po_refs(po_rec.raw_value) if po_rec and po_rec.raw_value else []
        gross_rec = fields.get("invoice_gross_total")
        gross = extract_amount(gross_rec.raw_value) if gross_rec and gross_rec.raw_value else None
        if len(refs) == 1 and gross is not None and currency:
            po = conn.execute("SELECT * FROM pos WHERE po_id=?", (refs[0],)).fetchone()
            gross_minor = quantize_minor(gross, currency)
            if po and gross_minor is not None and po["currency"] == currency:
                room = po["amount_minor"] - ledger.consumed_minor(conn, po["po_id"])
                if room >= gross_minor:
                    return True, f"{po['po_id']} now has {_fmt_money(room, currency)} available for this {_fmt_money(gross_minor, currency)} invoice."
        return False, None
    return False, None


_NEXT_STEP = {"onboard_supplier": "Select it and check the invoice again.",
              "raise_po": "Select it and check the invoice again.",
              "unblock_supplier": "Check the invoice again.",
              "amend_po": "Check the invoice again."}


def settle_requests(conn, actor: str) -> list[dict]:
    """Close every open request the record now fulfils. Called after each
    master-data change (and at startup): a request is done when the supplier
    and order tables say so, not when someone remembers to press a button.
    The resolution note is the derived fact plus the reviewer's next step."""
    if conn.in_transaction:
        raise RuntimeError("settle_requests must run between transactions (take the worker lock first)")
    settled = []
    for row in conn.execute("SELECT * FROM tickets WHERE status='open' AND kind != 'other'").fetchall():
        fulfilled, fact = ticket_fulfilled(conn, row)
        if not fulfilled:
            continue
        current = latest_run_in_lineage(conn, row["run_id"]) if row["run_id"] else None
        note = f"{fact} {_NEXT_STEP.get(row['kind'], '')}".strip()
        if fact and "checks out" in fact:
            note = f"{fact} Check the invoice again."
        if not row["run_id"]:
            note = f"{fact} Done by procurement."
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(
                "UPDATE tickets SET status='resolved', resolved_by=?, resolution_note=?, resolved_at=datetime('now') "
                "WHERE ticket_id=? AND status='open'", (actor, note, row["ticket_id"]))
            payload = {"ticket_id": row["ticket_id"], "kind": row["kind"], "note": note, "actor": actor,
                       "fulfilled": True, "fact": fact, "auto": True}
            if row["run_id"]:
                ledger._emit(conn, row["run_id"], "REQUEST", "ticket_resolved", payload)
                if current != row["run_id"]:   # the reviewer is on a Check-again run: show it there too
                    ledger._emit(conn, current, "REQUEST", "ticket_resolved", payload)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        settled.append(dict(conn.execute("SELECT * FROM tickets WHERE ticket_id=?", (row["ticket_id"],)).fetchone()))
    return settled


def close_requests_for_final_invoice(conn, run_id: str, actor: str, disposition: str) -> list[dict]:
    """The reviewer ended the invoice (approved or rejected): open requests on
    any run of that invoice are moot. Closed as declined — nothing was done for
    them — with a note that says why, and audited on the request's own run."""
    doc = conn.execute("SELECT document_id FROM runs WHERE run_id=?", (run_id,)).fetchone()
    if doc is None:
        return []
    decider = "Invoice AI" if actor == "invoice-ai" else "the reviewer"
    note = f"Closed automatically: the invoice was {disposition} by {decider}, so nothing more is needed."
    closed = []
    rows = conn.execute(
        "SELECT t.* FROM tickets t JOIN runs r USING (run_id) WHERE t.status='open' AND r.document_id=?",
        (doc["document_id"],)).fetchall()
    for row in rows:
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(
                "UPDATE tickets SET status='declined', resolved_by=?, resolution_note=?, resolved_at=datetime('now') "
                "WHERE ticket_id=? AND status='open'", (actor, note, row["ticket_id"]))
            ledger._emit(conn, row["run_id"], "REQUEST", "ticket_declined",
                         {"ticket_id": row["ticket_id"], "kind": row["kind"], "note": note, "actor": actor, "auto": True})
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        closed.append(dict(conn.execute("SELECT * FROM tickets WHERE ticket_id=?", (row["ticket_id"],)).fetchone()))
    return closed


def resolve_ticket(conn, ticket_id: str, outcome: str, note: str, resolved_by: str) -> dict:
    if outcome not in ("resolved", "declined"):
        raise ReviewError(422, "outcome must be resolved or declined")
    row = conn.execute("SELECT * FROM tickets WHERE ticket_id=?", (ticket_id,)).fetchone()
    if row is None:
        raise ReviewError(404, "no such request")
    if row["status"] != "open":
        raise ReviewError(409, f"request already {row['status']}")
    fulfilled, fact = ticket_fulfilled(conn, row)
    latest = conn.execute("SELECT disposition FROM runs WHERE run_id=?",
                          (latest_run_in_lineage(conn, row["run_id"]),)).fetchone() if row["run_id"] else None
    invoice_final = latest is not None and latest["disposition"] in ("approved", "rejected") \
        and not (latest["disposition"] == "rejected" and _rejected_only_for_supplier_state(conn, latest_run_in_lineage(conn, row["run_id"])))
    if invoice_final:
        fulfilled = outcome == "resolved"   # nothing derivable matters any more; the admin's word closes it
    if outcome == "declined" and fulfilled:
        # the record already says yes; a "no" would contradict it
        raise ReviewError(409, f"This request is already fulfilled: {fact} Complete it instead of declining. "
                               "If it should not have been done, undo it on the Suppliers or Purchase orders page first.")
    if outcome == "resolved" and not fulfilled and row["kind"] != "other":
        # the record does not show it done; the reviewer would only have to ask again
        raise ReviewError(409, (f"Not finished yet: {fact} " if fact else "The record does not show this request done yet. ")
                               + "Make the update first, or decline with a reason.")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            "UPDATE tickets SET status=?, resolved_by=?, resolution_note=?, resolved_at=datetime('now') WHERE ticket_id=?",
            (outcome, resolved_by, (note or "").strip(), ticket_id))
        if row["run_id"]:
            ledger._emit(conn, row["run_id"], "REQUEST", "ticket_" + outcome,
                         {"ticket_id": ticket_id, "kind": row["kind"], "note": (note or "").strip(), "actor": resolved_by,
                          "fulfilled": fulfilled, "fact": fact})
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return dict(conn.execute("SELECT * FROM tickets WHERE ticket_id=?", (ticket_id,)).fetchone())


def list_tickets(conn, status: str = "open", run_id: str | None = None,
                 document_id: str | None = None) -> list[dict]:
    """Newest first. `document_id` returns the requests across every run of one
    invoice (a Check again starts a new run; the requests must follow it)."""
    where, args = [], []
    if status != "all":
        where.append("t.status=?"); args.append(status)
    if run_id:
        where.append("t.run_id=?"); args.append(run_id)
    if document_id:
        where.append("r.document_id=?"); args.append(document_id)
    sql = ("SELECT t.*, d.filename, r.document_id, "
           "(SELECT fields_json FROM field_revisions f WHERE f.run_id=t.run_id ORDER BY seq DESC LIMIT 1) AS fields_json "
           "FROM tickets t LEFT JOIN runs r ON r.run_id = t.run_id LEFT JOIN documents d ON d.document_id = r.document_id "
           + ("WHERE " + " AND ".join(where) if where else "") + " ORDER BY t.created_at DESC")
    out = []
    for row in conn.execute(sql, args).fetchall():
        item = dict(row)
        fields = json.loads(item.pop("fields_json") or "{}")
        item["supplier_name"] = (fields.get("supplier_name") or {}).get("raw_value") or item.get("subject")
        item["po_reference"] = (fields.get("po_reference") or {}).get("raw_value")
        item["standalone"] = item.get("run_id") is None
        item["kind_label"] = (STANDALONE_KINDS if item["standalone"] else TICKET_KINDS).get(item["kind"], item["kind"])
        if item["status"] == "open":
            try:
                item["fulfilled"], item["fact"] = ticket_fulfilled(conn, row)
            except Exception as e:  # derivation failure is reported, never fatal for the list
                item["fulfilled"], item["fact"] = None, f"Could not check this request: {type(e).__name__}"
        out.append(item)
    return out


def _check_version(seq: int, expected_seq: int) -> None:
    if seq != expected_seq:
        raise ReviewError(409, f"stale view: revision is {seq}, you saw {expected_seq} — reload")


def correct_field(conn, run_id: str, field: str, value: str, actor: str,
                  expected_seq: int) -> int:
    """Reviewer supplies a value for one field. Prior revision preserved;
    normalization re-checked; source/role checks become not_applicable —
    recorded human evidence stands in for them."""
    _reviewable_run(conn, run_id)
    seq, fields, context = load_latest(conn, run_id)
    _check_version(seq, expected_seq)
    normalized = normalize_field(field, value)
    if normalized is None:
        expected = FIELD_EXPECTED.get(field, 'a value shown on the invoice')
        raise ReviewError(422, f'{unusable_reason(field, value) or "That value could not be read."} '
                               f'Enter {expected}. Your saved value has not changed.')
    prior = fields.get(field)
    fields[field] = FieldRecord(
        field=field, status="selected", raw_value=value,
        read_method=prior.read_method if prior else "reviewer",
        evidence={"corrected_from": prior.raw_value if prior else None, "actor": actor},
        checks={"source_match": "not_applicable", "role_check": "not_applicable",
                "normalization": "pass" if normalized is not None else "fail",
                "ambiguity": "none"},
        review_status="corrected")
    return save_revision(conn, run_id, "reviewer", actor, fields, context)


def confirm_not_duplicate(conn, run_id: str, actor: str, note: str, expected_seq: int) -> int:
    """Reviewer attests that a same-supplier/amount/date match is a genuinely
    separate invoice. Recorded in the revision context and on the audit
    trail; the fingerprint gate honours it on re-evaluation. Exact duplicates
    (same file, same invoice number) are unaffected — those stay final."""
    _reviewable_run(conn, run_id)
    seq, fields, context = load_latest(conn, run_id)
    _check_version(seq, expected_seq)
    note = " ".join((note or "").split())
    if len(note) < 5:
        raise ReviewError(422, "Say why this is a separate invoice (at least a few words) — it goes on the audit trail.")
    context["duplicate_confirmed"] = {"actor": actor, "note": note}
    new_seq = save_revision(conn, run_id, "reviewer", actor, fields, context)
    ledger._emit(conn, run_id, "REVIEW", "duplicate_confirmed_distinct", {"actor": actor, "note": note})
    return new_seq


def attest_fields(conn, run_id: str, field_names: list[str], actor: str,
                  expected_seq: int) -> int:
    """Reviewer confirms scan-transcribed readings against the displayed page."""
    _reviewable_run(conn, run_id)
    seq, fields, context = load_latest(conn, run_id)
    _check_version(seq, expected_seq)
    for name in field_names:
        rec = fields.get(name)
        if rec is None or rec.status != "selected":
            raise ReviewError(422, f"field {name} has no reading to attest")
        reason = unusable_reason(name, rec.raw_value)
        if reason:
            raise ReviewError(422, f"{name.replace('_', ' ')} cannot be confirmed as read. {reason} "
                                   "Type the value (or use a suggestion) and save it instead.")
        rec.review_status = "attested"
        rec.evidence = {**rec.evidence, "attested_by": actor}
    return save_revision(conn, run_id, "reviewer", actor, fields, context)


def _finalize_review_run(conn, run_id: str, gates: ResolverInput,
                         policy: Policy) -> CommitResult:
    from .pipeline import _finalize_no_identity
    return _finalize_no_identity(conn, run_id, gates, policy)


def _new_review_run(conn, original, actor: str, idem: str | None) -> str:
    run_id = _uid("run")
    conn.execute(
        "INSERT INTO runs (run_id, document_id, run_status, kind, parent_run_id, actor, idempotency_key) "
        "VALUES (?, ?, 'running', 'review', ?, ?, ?)",
        (run_id, original["document_id"], original["run_id"], actor, idem))
    return run_id


def _reevaluate(conn, run_id: str, actor: str, idempotency_key: str,
               policy: Policy) -> CommitResult | dict:
    """Reviewer 'approve': reevaluate the latest revision against CURRENT
    policy, master data, and fresh ledger state. May create the invoice's
    first posting, once. Not a bypass: failing gates still hold/reject."""
    original = _reviewable_run(conn, run_id)
    existing = conn.execute("SELECT run_id FROM runs WHERE idempotency_key=?",
                            (idempotency_key,)).fetchone()
    if existing:
        row = conn.execute("SELECT run_id, disposition, decision_mode FROM runs WHERE run_id=?",
                           (existing["run_id"],)).fetchone()
        return {"idempotent_replay": True, **dict(row)}

    seq, fields, context = load_latest(conn, run_id)
    review_run = _new_review_run(conn, original, actor, idempotency_key)
    # carry the revision forward so the review run is itself auditable
    save_revision(conn, review_run, "reviewer", actor, fields, context)

    # currency: corrected field wins; else the original document resolution
    cur_rec = fields.get("currency")
    code = None
    if cur_rec and cur_rec.status == "selected":
        code = extract_currency(cur_rec.raw_value)
    if code is None:
        code = (context.get("currency") or {}).get("code")
    currency = CurrencyResolution(code, "reviewer" if cur_rec and cur_rec.review_status == "corrected" else
                                  (context.get("currency") or {}).get("source", "unresolved"))

    gates = assess(fields, context.get("any_scanned", False), currency)

    from .pipeline import resolve_vendor, _vendor_absent
    supplier = fields.get("supplier_name")
    supplier_name = extract_name(supplier.raw_value) if supplier and supplier.raw_value else None
    vendor = resolve_vendor(conn, supplier_name)
    if vendor is None:
        # same tri-state as the first reading: only a verified name that does
        # not match the register may be rejected outright
        gates.vendor_resolved = _vendor_absent(supplier, supplier_name)
        return _finalize_review_run(conn, review_run, gates, policy)
    gates.vendor_resolved = True
    gates.vendor_blocked = vendor["status"] == "blocked"

    inv_no_rec = fields.get("invoice_number")
    inv_no = extract_invoice_number(inv_no_rec.raw_value) if inv_no_rec and inv_no_rec.raw_value else None
    # PO: same deterministic reference extraction as the pipeline, so an
    # uncorrected field that still carries its label ("PO Reference: PO-1001")
    # resolves exactly as it did on first reading. If the field names no
    # order and the reviewer has not touched it, fall back to the single
    # reference the document-wide scan found.
    from .normalize import extract_po_refs
    po_rec = fields.get("po_reference")
    po_raw = po_rec.raw_value if po_rec and po_rec.status == "selected" and po_rec.raw_value else None
    refs = extract_po_refs(po_raw) if po_raw else []
    if po_raw and conn.execute("SELECT 1 FROM pos WHERE po_id=?", (po_raw.strip(),)).fetchone():
        refs = [po_raw.strip()]  # a picked or typed order id matches exactly, whatever its format
    if not refs and not (po_rec and po_rec.review_status == "corrected"):
        refs = list(context.get("po_references") or [])
    if len(refs) > 1:
        gates.multiple_po_refs = True
    po_id = refs[0] if len(refs) == 1 else None
    gates.po_confirmed = True if po_id else (False if not refs else None)
    gross_rec = fields.get("invoice_gross_total")
    gross_dec = extract_amount(gross_rec.raw_value) if gross_rec and gross_rec.raw_value else None
    gross_minor = quantize_minor(gross_dec, code) if (gross_dec is not None and code) else None
    date_rec = fields.get("invoice_date")
    date_iso = extract_date_iso(date_rec.raw_value) if date_rec and date_rec.raw_value else None

    if not inv_no or code is None or gross_minor is None or po_id is None:
        return _finalize_review_run(conn, review_run, gates, policy)

    from .pipeline import WORKSPACE, BUYER
    out = commit_decision(
        conn, run_id=review_run, workspace=WORKSPACE, buyer=BUYER,
        supplier_id=vendor["supplier_id"], invoice_no_raw=inv_no,
        invoice_minor=gross_minor, currency=code, po_id=po_id,
        gates=gates, policy=policy, invoice_date_iso=date_iso,
        decision_mode="reviewer",
        fingerprint_cleared_by=(context.get("duplicate_confirmed") or {}).get("actor"))
    route = out.decision.route.value
    codes = {c.value for c in out.decision.codes}
    if route in ("AUTO_APPROVE", "APPROVE_WITH_EXCEPTION"):
        close_requests_for_final_invoice(conn, review_run, actor, "approved")
    elif route == "REJECT" and not codes <= RECHECKABLE_REJECT_CODES:
        # a blocked/unknown-supplier rejection stays reviewable; the onboarding
        # or unblock request it depends on must survive
        close_requests_for_final_invoice(conn, review_run, actor, "rejected")
    return out


def reject(conn, run_id: str, actor: str, reason: str, idempotency_key: str) -> dict:
    original = _reviewable_run(conn, run_id)
    existing = conn.execute("SELECT run_id FROM runs WHERE idempotency_key=?",
                            (idempotency_key,)).fetchone()
    if existing:
        return {"idempotent_replay": True, "run_id": existing["run_id"]}
    try:
        _, fields, context = load_latest(conn, run_id)
    except ReviewError as e:
        if e.status != 404:
            raise
        fields, context = {}, {}
    review_run = _new_review_run(conn, original, actor, idempotency_key)
    conn.execute("BEGIN IMMEDIATE")
    try:
        if fields:
            save_revision(conn, review_run, "reviewer", actor, fields, context)
        conn.execute(
            "UPDATE runs SET run_status='completed', disposition='rejected', decision_mode='reviewer', "
            "finished_at=datetime('now') WHERE run_id=?", (review_run,))
        ledger._emit(conn, review_run, "DECIDE", "decision",
                     {"route": "REJECT", "codes": ["REVIEWER_REJECTED"],
                      "explanation": f"Rejected by {actor}: {reason}. No amount was added to the approved ledger.",
                      "posted": False})
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    close_requests_for_final_invoice(conn, review_run, actor, "rejected")
    return {"run_id": review_run, "disposition": "rejected"}


def invoice_gross_minor(fields: dict, context: dict) -> tuple[int | None, str | None]:
    """The invoice total in minor units with its currency, as the reviewer has
    them now (corrections win over the document reading). (None, code) when the
    total is unusable."""
    cur_rec = fields.get("currency")
    currency = (extract_currency(cur_rec.raw_value) if cur_rec and cur_rec.raw_value else None) \
        or (context.get("currency") or {}).get("code")
    gross_rec = fields.get("invoice_gross_total")
    gross = extract_amount(gross_rec.raw_value) if gross_rec and gross_rec.raw_value else None
    if gross is None or not currency:
        return None, currency
    return quantize_minor(gross, currency), currency


def budget_forecast(conn, po_row, gross_minor: int | None, currency: str | None, policy) -> dict:
    """What the budget rule WILL say if this invoice is approved against this
    order — the same arithmetic commit_decision runs, computed early so the
    reviewer sees "not enough budget" while choosing, not after Check again."""
    from .rules import budget_check
    remaining = po_row["amount_minor"] - ledger.consumed_minor(conn, po_row["po_id"])
    out = {"po_id": po_row["po_id"], "currency": po_row["currency"], "remaining_minor": remaining,
           "status": None, "short_minor": 0}
    if gross_minor is None or currency != po_row["currency"] or po_row["status"] != "open":
        return out
    b = budget_check(po_row["amount_minor"], ledger.consumed_minor(conn, po_row["po_id"]), gross_minor, policy, po_row["currency"])
    if b.overage_minor <= b.t_primary_minor:
        out["status"] = "ok"
    elif b.overage_minor <= b.t_exception_minor:
        out["status"] = "exception"
    else:
        out["status"] = "exceeded"
        out["short_minor"] = b.overage_minor - b.t_exception_minor
    return out


def po_candidates(conn, fields: dict[str, FieldRecord]) -> list[dict]:
    """Deterministic candidate retrieval for missing/ambiguous PO: filter by
    resolved vendor + currency + open status. Candidates, never proof."""
    from .pipeline import resolve_vendor
    supplier = fields.get("supplier_name")
    vendor = resolve_vendor(conn, extract_name(supplier.raw_value) if supplier and supplier.raw_value else None)
    if vendor is None:
        return []
    rows = conn.execute(
        "SELECT po_id, currency, amount_minor, status FROM pos WHERE supplier_id=? AND status='open'",
        (vendor["supplier_id"],)).fetchall()
    return [dict(r) for r in rows]


def reevaluate(conn, run_id: str, actor: str, idempotency_key: str, policy: Policy):
    result = _reevaluate(conn, run_id, actor, idempotency_key, policy)
    if isinstance(result, dict):
        return result
    from .automation import reject_low_confidence_non_invoice
    return reject_low_confidence_non_invoice(conn, result.run_id, policy) or result
