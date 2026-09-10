"""Field assessment: builds resolver gate facts from verified field records.

Approval requires every REQUIRED field affirmatively verified — 'no failed
checks' is NOT 'all required checks passed'. Reconciliation is Decimal-exact
with the currency's own minor unit as the local bound; a tolerated residual
never rewrites the invoice amount.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field as dc_field
from decimal import Decimal

from .currencies import MINOR_UNITS
from .normalize import extract_amount, extract_currency, extract_date_iso
from .policy import ROUNDING_POLICY
from .rules import ResolverInput

REQUIRED_FIELDS = (
    "supplier_name", "invoice_number", "invoice_date",
    "subtotal_net", "tax_total", "invoice_gross_total",
)
# currency is required too, but resolves through document context as well as
# the field — handled separately in resolve_currency().
OPTIONAL_FIELDS = ("buyer_name", "due_date", "po_reference", "amount_due", "shipping_total")


@dataclass
class FieldRecord:
    field: str
    status: str  # selected | missing | ambiguous | unsupported
    raw_value: str | None
    read_method: str  # deterministic | llm_text | llm_vision
    evidence: dict
    checks: dict
    review_status: str = "not_reviewed"

    def self_verified(self) -> bool:
        """A scan reading confirmed by code without the reviewer: it normalises,
        and either an independent reading of the page agrees (source_match
        pass) or a hard cross-check holds (the amounts add up, the supplier is
        in the master, the order is on record). Never a model's own score."""
        return (self.read_method == "llm_vision" and self.status == "selected" and self.raw_value is not None
                and self.checks.get("normalization") == "pass"
                and (self.checks.get("independent_read") == "agree" or bool(self.checks.get("cross_check"))))

    def affirmatively_verified(self) -> bool:
        if self.status != "selected" or self.raw_value is None:
            return False
        if self.checks.get("normalization") == "fail":
            return False
        if self.review_status in ("attested", "corrected"):
            # recorded human evidence stands in for source verification
            return True
        if self.read_method == "llm_vision":
            return self.self_verified()  # else: scan evidence verifies through attestation
        return (
            self.checks.get("source_match") == "pass"
            and self.checks.get("role_check") in ("pass", "not_evaluated")
        )


@dataclass
class CurrencyResolution:
    code: str | None
    source: str  # "field" | "document_context" | "unresolved"
    evidence: dict = dc_field(default_factory=dict)


def resolve_currency(fields: dict[str, FieldRecord], blocks) -> CurrencyResolution:
    """Explicit code via the currency field first; else exactly one distinct
    ISO code across the whole document (e.g. table headers '[EUR]') resolves it
    with block evidence. Bare symbols, geography, supplier defaults, or the PO
    never establish it. None/conflict -> unresolved."""
    rec = fields.get("currency")
    if rec and rec.status == "selected" and rec.raw_value:
        code = extract_currency(rec.raw_value)
        if code:
            return CurrencyResolution(code, "field", rec.evidence)
    codes: dict[str, dict] = {}
    for b in blocks:
        c = extract_currency(b.text)
        if c and c not in codes:
            codes[c] = {"block_id": b.block_id, "page": b.page, "text": b.text[:80]}
    if len(codes) == 1:
        code, ev = next(iter(codes.items()))
        return CurrencyResolution(code, "document_context", ev)
    return CurrencyResolution(None, "unresolved")


def _dec(rec: FieldRecord | None) -> Decimal | None:
    if rec is None or rec.raw_value is None or rec.status != "selected":
        return None
    return extract_amount(rec.raw_value)


def reconcile(fields: dict[str, FieldRecord], currency: str | None) -> dict:
    """Charge-aware document reconciliation. Returns {'ok': bool|None, 'detail'}.
    Local bound: 1 minor unit of the invoice currency (fallback: 2-decimal).
    Shipping is zero ONLY when a complete stated structure reconciles without
    it; a stated shipping amount must be additional exactly once."""
    exp = MINOR_UNITS.get(currency or "", 2)
    unit = Decimal(1).scaleb(-exp)  # one minor unit
    bound = unit * ROUNDING_POLICY["reconciliation_local_bound_minor"]

    sub, tax, gross = _dec(fields.get("subtotal_net")), _dec(fields.get("tax_total")), _dec(fields.get("invoice_gross_total"))
    ship_rec = fields.get("shipping_total")
    ship = _dec(ship_rec)
    if None in (sub, tax, gross):
        return {"ok": None, "detail": "amount fields not evaluable"}

    if ship is not None:
        if ship < 0:
            return {"ok": False, "detail": "negative shipping is not a supported charge"}
        with_ship = abs((sub + tax + ship) - gross) <= bound
        without_ship = abs((sub + tax) - gross) <= bound
        if with_ship and not without_ship:
            return {"ok": True, "detail": f"{sub} + {tax} + {ship} = {gross} (shipping additional)"}
        if without_ship:
            # gross reconciles WITHOUT the stated charge: inclusion ambiguous
            return {"ok": False, "detail": "stated shipping is not clearly additional (gross reconciles without it)"}
        return {"ok": False, "detail": f"{sub} + {tax} + {ship} != {gross}"}

    ok = abs((sub + tax) - gross) <= bound
    return {"ok": ok, "detail": f"{sub} + {tax} {'=' if ok else '!='} {gross}"}


def assess(fields: dict[str, FieldRecord], any_scanned_page: bool,
           currency: CurrencyResolution) -> ResolverInput:
    gates = ResolverInput()

    gates.required_fields_ok = all(
        f in fields and fields[f].affirmatively_verified() for f in REQUIRED_FIELDS
    )

    gates.scan_gate = any_scanned_page and any(
        fields[f].read_method == "llm_vision" and fields[f].review_status not in ("attested", "corrected")
        and not fields[f].self_verified()
        for f in REQUIRED_FIELDS if f in fields
    )

    rec = reconcile(fields, currency.code)
    gates.arithmetic_ok = rec["ok"]

    due = _dec(fields.get("amount_due"))
    gross = _dec(fields.get("invoice_gross_total"))
    if due is not None and gross is not None and due != gross:
        gates.structure_supported = False  # prepayment/prior-balance adjustment

    inv_date = fields.get("invoice_date")
    if inv_date and inv_date.status == "selected" and inv_date.raw_value:
        gates.ambiguous_date = extract_date_iso(inv_date.raw_value) is None

    gates.ambiguous_currency = currency.code is None
    return gates
