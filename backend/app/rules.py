"""Deterministic decision core. No model output enters this module —
inputs are validated, typed facts; outputs are dispositions + reason codes
with the numbers that produced them.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from .policy import Policy


class Route(str, Enum):
    AUTO_APPROVE = "AUTO_APPROVE"
    APPROVE_WITH_EXCEPTION = "APPROVE_WITH_EXCEPTION"
    HOLD_REVIEW = "HOLD_REVIEW"
    REJECT = "REJECT"


class Code(str, Enum):
    VENDOR_UNKNOWN = "VENDOR_UNKNOWN"
    VENDOR_BLOCKED = "VENDOR_BLOCKED"
    PO_VENDOR_MISMATCH = "PO_VENDOR_MISMATCH"
    PO_CLOSED = "PO_CLOSED"
    NO_PO_MATCH = "NO_PO_MATCH"
    PO_FUZZY_CANDIDATE = "PO_FUZZY_CANDIDATE"
    PO_MULTIPLE_REFS = "PO_MULTIPLE_REFS"
    PO_BUDGET_EXCEEDED = "PO_BUDGET_EXCEEDED"
    VARIANCE_EXCEPTION = "VARIANCE_EXCEPTION"
    DUP_FILE_HASH = "DUP_FILE_HASH"
    DUP_INVOICE_NO = "DUP_INVOICE_NO"
    DUP_FINGERPRINT = "DUP_FINGERPRINT"
    CONTENT_CONFLICT = "CONTENT_CONFLICT"
    MATH_MISMATCH = "MATH_MISMATCH"
    MISSING_FIELD = "MISSING_FIELD"
    UNVERIFIED_FIELD = "UNVERIFIED_FIELD"
    AMBIGUOUS_CURRENCY = "AMBIGUOUS_CURRENCY"
    AMBIGUOUS_DATE = "AMBIGUOUS_DATE"
    CURRENCY_MISMATCH = "CURRENCY_MISMATCH"
    UNSUPPORTED_DOCUMENT_TYPE = "UNSUPPORTED_DOCUMENT_TYPE"
    UNSUPPORTED_AMOUNT_STRUCTURE = "UNSUPPORTED_AMOUNT_STRUCTURE"
    REVIEW_REQUIRED_SCAN = "REVIEW_REQUIRED_SCAN"
    REVIEW_APPROVED = "REVIEW_APPROVED"


@dataclass(frozen=True)
class BudgetResult:
    base_minor: int  # B
    consumed_minor: int  # A: approved consumption incl. opening
    invoice_minor: int  # I
    cumulative_minor: int  # C = A + I
    overage_minor: int  # D = max(0, C - B)
    t_primary_minor: int
    t_exception_minor: int
    currency: str = "USD"


def budget_check(base_minor: int, consumed_minor: int, invoice_minor: int,
                 policy: Policy, currency: str = "USD") -> BudgetResult:
    """Tolerance applies to CUMULATIVE OVERAGE above the PO base — never to
    invoice-vs-PO closeness. Partial billing below base is always in budget.
    Allowances resolve in the PO currency's own minor units."""
    cumulative = consumed_minor + invoice_minor
    overage = max(0, cumulative - base_minor)
    return BudgetResult(
        base_minor=base_minor,
        consumed_minor=consumed_minor,
        invoice_minor=invoice_minor,
        cumulative_minor=cumulative,
        overage_minor=overage,
        t_primary_minor=policy.t_primary_minor(base_minor, currency),
        t_exception_minor=policy.t_exception_minor(base_minor, currency),
        currency=currency,
    )


@dataclass
class ResolverInput:
    """Typed facts. Every gate is tri-state via Optional/bool where a missing
    prerequisite means the dependent rule is not evaluated, never passed."""

    # duplicates (facts established by identity layer, not heuristics)
    identical_document: bool = False  # L1: same bytes as an existing invoice's document
    duplicate_of_posted: bool = False  # L2: business key matches a posted invoice
    content_conflict: bool = False  # same business key, conflicting content
    fingerprint_candidate: bool = False  # L3

    # vendor / PO facts (None = unresolved)
    vendor_resolved: bool | None = None
    vendor_blocked: bool | None = None  # only meaningful when vendor_resolved
    po_confirmed: bool | None = None  # one confirmed PO for supplier+buyer
    po_closed: bool = False
    po_vendor_mismatch: bool = False
    fuzzy_po_only: bool = False
    multiple_po_refs: bool = False

    # evidence gates
    required_fields_ok: bool = False
    arithmetic_ok: bool | None = None  # None = not evaluable (missing amounts)
    structure_supported: bool = True
    scan_gate: bool = False  # any critical field from unattested scan evidence
    currency_mismatch: bool = False
    ambiguous_currency: bool = False
    ambiguous_date: bool = False
    document_type_supported: bool = True

    budget: BudgetResult | None = None
    codes: list[Code] = field(default_factory=list)


@dataclass(frozen=True)
class Decision:
    route: Route
    codes: tuple[Code, ...]
    budget: BudgetResult | None


def resolve(inp: ResolverInput, policy: Policy) -> Decision:
    """Precedence per plan v2.2. Returns route + every applicable reason code;
    first code is the primary reason shown in the UI."""
    codes: list[Code] = list(inp.codes)

    # L1 / L2 duplicates: handled by identity layer (link/block), surfaced here
    # as terminal outcomes for the *submission*, never touching the original.
    if inp.identical_document:
        return Decision(Route.REJECT, (Code.DUP_FILE_HASH,), inp.budget)
    if inp.duplicate_of_posted:
        return Decision(Route.REJECT, (Code.DUP_INVOICE_NO,), inp.budget)

    # Not an invoice at all (blank, a quote, a purchase order, a résumé...):
    # terminal for the submission, nothing to review, reviewer may override
    # by re-reading the document as an invoice.
    if not inp.document_type_supported:
        return Decision(Route.REJECT, (Code.UNSUPPORTED_DOCUMENT_TYPE,), inp.budget)

    # Hard reject requires a reliably identified vendor.
    if inp.vendor_resolved and inp.vendor_blocked:
        return Decision(Route.REJECT, (Code.VENDOR_BLOCKED,), inp.budget)

    # Everything below is HOLD territory: uncertainty or certain-but-fixable.
    holds: list[Code] = []
    if inp.content_conflict:
        holds.append(Code.CONTENT_CONFLICT)
    if not inp.structure_supported:
        holds.append(Code.UNSUPPORTED_AMOUNT_STRUCTURE)
    if inp.vendor_resolved is None or inp.vendor_resolved is False:
        holds.append(Code.VENDOR_UNKNOWN)
    if inp.po_vendor_mismatch:
        holds.append(Code.PO_VENDOR_MISMATCH)
    if inp.po_closed:
        holds.append(Code.PO_CLOSED)
    if inp.po_confirmed is None or inp.po_confirmed is False:
        holds.append(Code.NO_PO_MATCH)
    if inp.fuzzy_po_only:
        holds.append(Code.PO_FUZZY_CANDIDATE)
    if inp.multiple_po_refs:
        holds.append(Code.PO_MULTIPLE_REFS)
    if not inp.required_fields_ok:
        holds.append(Code.MISSING_FIELD)
    if inp.arithmetic_ok is False:
        holds.append(Code.MATH_MISMATCH)
    if inp.scan_gate and not policy.scan_auto_approve:
        holds.append(Code.REVIEW_REQUIRED_SCAN)
    if inp.currency_mismatch:
        holds.append(Code.CURRENCY_MISMATCH)
    if inp.ambiguous_currency:
        holds.append(Code.AMBIGUOUS_CURRENCY)
    if inp.ambiguous_date:
        holds.append(Code.AMBIGUOUS_DATE)
    if inp.fingerprint_candidate:
        holds.append(Code.DUP_FINGERPRINT)

    if holds:
        return Decision(Route.HOLD_REVIEW, tuple(holds + codes), inp.budget)

    # All non-budget gates pass; budget must have been evaluable.
    if inp.budget is None or inp.arithmetic_ok is not True:
        return Decision(Route.HOLD_REVIEW, (Code.UNVERIFIED_FIELD,), inp.budget)

    b = inp.budget
    if b.overage_minor <= b.t_primary_minor:
        return Decision(Route.AUTO_APPROVE, tuple(codes), b)
    if (
        policy.exception_enabled
        and b.overage_minor <= b.t_exception_minor
    ):
        # Sole purpose of the exception band: the allowlisted variance rule
        # is the ONLY failing gate (guaranteed above — holds list was empty).
        return Decision(Route.APPROVE_WITH_EXCEPTION, (Code.VARIANCE_EXCEPTION,), b)
    return Decision(Route.HOLD_REVIEW, (Code.PO_BUDGET_EXCEEDED,), b)


def explain(decision: Decision) -> str:
    """Deterministic template. Answers: what happened, why, what changed
    financially, next action. Overage + allowance shown on EVERY route,
    automatic approvals included."""
    b = decision.budget

    def usd(minor: int) -> str:
        from .currencies import MINOR_UNITS
        exp = MINOR_UNITS.get(b.currency, 2) if b else 2
        val = minor / (10 ** exp) if exp else minor
        code = b.currency if b else ""
        return f"{code} {val:,.{exp}f}"

    budget_line = ""
    if b is not None:
        budget_line = (
            f" Cumulative billing {usd(b.cumulative_minor)} against a "
            f"{usd(b.base_minor)} PO; overage {usd(b.overage_minor)}, "
            f"allowance {usd(b.t_primary_minor)}"
            f" (exception limit {usd(b.t_exception_minor)})."
        )

    if decision.route is Route.AUTO_APPROVE:
        return (
            "Approved automatically. All gates passed." + budget_line
            + " Amount added to the approved ledger. Next: none."
        )
    if decision.route is Route.APPROVE_WITH_EXCEPTION:
        return (
            "Approved with a logged exception."
            + budget_line
            + " Amount added to the approved ledger. Next: exception appears in the audit view."
        )
    if decision.route is Route.HOLD_REVIEW:
        primary = decision.codes[0].value if decision.codes else "REVIEW"
        return (
            f"Held for review ({primary})."
            + budget_line
            + " No amount was added to the approved ledger."
            + " Next: a reviewer resolves the listed reasons, or the PO/policy is amended."
        )
    primary = decision.codes[0].value if decision.codes else "REJECT"
    if Code.UNSUPPORTED_DOCUMENT_TYPE in decision.codes:
        return ("Rejected (UNSUPPORTED_DOCUMENT_TYPE). The document is not an invoice, so nothing was "
                "read or approved. Next: upload the invoice itself, or read this file as an invoice anyway.")
    return (
        f"Rejected ({primary})."
        + budget_line
        + " No amount was added to the approved ledger."
        + " Next: see the linked original invoice or contact the vendor."
    )
