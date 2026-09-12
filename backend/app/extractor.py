"""Gemini extraction under plan v2.2 contracts.

Models: gemini-3.5-flash-lite primary (text selections + scan transcription),
gemini-3.8-flash bounded repair. The model returns SELECTIONS or TRANSCRIPTIONS;
this module verifies and normalizes — it never trusts values.

Call budget: 3 logical calls (extract<=1, vision<=1, repair<=1),
2 retries across the entire run, 5 outbound attempts max, wall-time cap.
"""
from __future__ import annotations

import os
import random
import re
import threading
import time
from typing import Literal
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation

from pydantic import BaseModel

from .evidence import ExtractionRevision

PRIMARY_MODEL = "gemini-3.5-flash-lite"
REPAIR_MODEL = "gemini-3.8-flash"

FIELDS = [
    "supplier_name", "buyer_name", "invoice_number", "invoice_date", "due_date",
    "currency", "po_reference", "subtotal_net", "tax_total", "shipping_total",
    "invoice_gross_total", "amount_due",
]

ROLE_LABELS = {
    # label words that must appear in/near the source block for role_check
    "invoice_gross_total": ["total", "grand total", "invoice total", "amount payable", "gross"],
    "amount_due": ["amount due", "balance due", "due"],
    "subtotal_net": ["subtotal", "sub-total", "net"],
    "tax_total": ["tax", "vat", "gst", "sales tax"],
    "shipping_total": ["shipping", "freight", "delivery", "handling", "carriage"],
    "invoice_number": ["invoice", "inv", "#", "no"],
    "invoice_date": ["date"],
    "due_date": ["due"],
    "po_reference": ["po", "purchase order", "order"],
    "supplier_name": [],
    "buyer_name": ["bill to", "billed to", "customer", "sold to"],
    "currency": [],
}


FieldStatus = Literal["selected", "missing", "ambiguous", "unsupported"]


class Selection(BaseModel):
    field: str
    status: FieldStatus  # enum enforced in the response schema — the model
                         # cannot invent its own vocabulary ("extracted")
    source_block_id: str | None = None
    raw_value: str | None = None


class SelectionList(BaseModel):
    selections: list[Selection]


class Transcription(BaseModel):
    field: str
    status: FieldStatus
    raw_value: str | None = None
    page: int | None = None


class TranscriptionList(BaseModel):
    transcriptions: list[Transcription]


class PageText(BaseModel):
    lines: list[str]


@dataclass
class CallBudget:
    max_logical: int = 4          # extract | vision | verify (scan page text) | repair
    max_retries_total: int = 2
    max_outbound: int = 6
    wall_seconds: float = 120.0
    max_total_tokens: int = 100_000  # per-invoice spend cap (input+output)
    tokens_used: int = 0
    started: float = field(default_factory=time.monotonic)
    logical_used: dict = field(default_factory=lambda: {"extract": 0, "vision": 0, "verify": 0, "repair": 0})
    retries_used: int = 0
    outbound: int = 0
    attempts: list = field(default_factory=list)  # event records

    def check(self, kind: str) -> None:
        if self.logical_used[kind] >= 1:
            raise BudgetExceeded(f"logical call '{kind}' already used")
        if sum(self.logical_used.values()) >= self.max_logical:
            raise BudgetExceeded("logical call budget exhausted")
        if self.outbound >= self.max_outbound:
            raise BudgetExceeded("outbound attempt budget exhausted")
        if time.monotonic() - self.started > self.wall_seconds:
            raise BudgetExceeded("wall time exceeded")
        if self.tokens_used >= self.max_total_tokens:
            raise BudgetExceeded("token spend cap exhausted")


class BudgetExceeded(Exception):
    pass


# ---------------------------------------------------------------------------
# Concurrency and backoff.
#
# Several documents are read at once (intake.BatchRegistry), so the ceiling on
# outbound model calls belongs here, at the one place that makes them, rather
# than at each caller. The gate bounds calls in flight across every thread; the
# per-invoice CallBudget still bounds what one document may spend, so
# parallelism changes wall time and never cost.
#
# A refused call is not a document problem. Rate limits and "unavailable" are
# answers to try again after waiting, so those retries back off; anything else
# retries at once. A backoff that would outlast the invoice's wall-clock budget
# is not taken at all — holding the reviewer past their deadline to maybe get a
# reading is worse than telling them the reading failed.
# ---------------------------------------------------------------------------
DEFAULT_EXTRACT_CONCURRENCY = 3
RETRY_BASE_SECONDS = 2.0
RETRY_JITTER_SECONDS = 0.5
_RATE_LIMIT_CODES = {429, 500, 503}
_RATE_LIMIT_WORDS = ("resource_exhausted", "rate limit", "quota", "unavailable",
                     "too many requests", "overloaded")


def extract_concurrency() -> int:
    """How many documents may be read at once. Unset or unreadable falls back to
    the default; never fewer than one reader."""
    raw = os.environ.get("EXTRACT_CONCURRENCY")
    if raw is None:
        return DEFAULT_EXTRACT_CONCURRENCY
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return DEFAULT_EXTRACT_CONCURRENCY


_GATE: threading.BoundedSemaphore | None = None
_GATE_SIZE: int | None = None
_GATE_GUARD = threading.Lock()


def _gate() -> threading.BoundedSemaphore:
    """The shared ceiling on model calls in flight. Rebuilt when the configured
    size changes, so the setting can be changed without a restart."""
    global _GATE, _GATE_SIZE
    size = extract_concurrency()
    with _GATE_GUARD:
        if _GATE is None or _GATE_SIZE != size:
            _GATE, _GATE_SIZE = threading.BoundedSemaphore(size), size
        return _GATE


def _sleep(seconds: float) -> None:
    """Indirected so a test can observe a backoff without serving it."""
    time.sleep(seconds)


def _retry_after_waiting(e: Exception) -> bool:
    """Did the endpoint refuse this call for load, rather than reject it?"""
    code = getattr(e, "code", None) or getattr(e, "status_code", None)
    if code in _RATE_LIMIT_CODES:
        return True
    text = str(e).lower()
    return any(word in text for word in _RATE_LIMIT_WORDS)


_CLIENT = None


def _client():
    # One cached client: a temporary Client can be garbage-collected mid-request,
    # closing its underlying httpx client.
    global _CLIENT
    if _CLIENT is None:
        from google import genai
        _CLIENT = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    return _CLIENT


def _generate(budget: CallBudget, kind: str, model: str, contents, schema):
    """One logical call with run-level retry accounting. Every attempt is
    recorded; failures raise after budget is exhausted."""
    budget.check(kind)
    budget.logical_used[kind] += 1
    from google.genai import types

    last_err: Exception | None = None
    client = _client()   # resolved once per logical call, then retried against
    while True:
        budget.outbound += 1
        t0 = time.monotonic()
        try:
            with _gate():   # held only for the call itself, never across a backoff
                resp = client.models.generate_content(
                    model=model,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=schema,
                        temperature=0,
                    ),
                )
            usage = getattr(resp, "usage_metadata", None)
            budget.tokens_used += (getattr(usage, "prompt_token_count", 0) or 0) + \
                                  (getattr(usage, "candidates_token_count", 0) or 0)
            budget.attempts.append({
                "kind": kind, "model": model, "ok": True,
                "seconds": round(time.monotonic() - t0, 2),
                "input_tokens": getattr(usage, "prompt_token_count", None),
                "output_tokens": getattr(usage, "candidates_token_count", None),
            })
            return schema.model_validate_json(resp.text)
        except Exception as e:  # noqa: BLE001 — every failure is recorded, then rebudgeted
            budget.attempts.append({
                "kind": kind, "model": model, "ok": False, "error": type(e).__name__,
                "seconds": round(time.monotonic() - t0, 2),
            })
            last_err = e
            if budget.retries_used >= budget.max_retries_total or budget.outbound >= budget.max_outbound:
                raise BudgetExceeded(f"attempts exhausted: {e}") from last_err
            if _retry_after_waiting(e):
                wait = RETRY_BASE_SECONDS * (2 ** budget.retries_used) + random.uniform(0, RETRY_JITTER_SECONDS)
                remaining = budget.wall_seconds - (time.monotonic() - budget.started)
                if wait >= remaining:
                    raise BudgetExceeded(
                        f"the endpoint asked us to wait {wait:.1f}s, longer than this invoice has left"
                    ) from last_err
                budget.attempts[-1]["backoff_seconds"] = round(wait, 2)
                _sleep(wait)
            budget.retries_used += 1


EXTRACT_PROMPT = """You are selecting source text for invoice fields. You will
see numbered text blocks from one invoice PDF. For each requested field, return
the block id that states it and the exact raw token copied verbatim from that
block. Do NOT compute, reformat, or infer values. If a field is not stated,
return status "missing". If two blocks plausibly state it, return status
"ambiguous". Never guess.

Fields: {fields}
Allowed status values: selected, missing, ambiguous, unsupported.

Blocks:
{blocks}
"""


def extract_native(rev: ExtractionRevision, budget: CallBudget, repair: bool = False) -> list[Selection]:
    blocks_text = "\n".join(f"[{b.block_id}] {b.text}" for b in rev.blocks)
    prompt = EXTRACT_PROMPT.format(fields=", ".join(FIELDS), blocks=blocks_text)
    kind = "repair" if repair else "extract"
    model = REPAIR_MODEL if repair else PRIMARY_MODEL
    result = _generate(budget, kind, model, prompt, SelectionList)
    return result.selections


SCAN_PROMPT = """You are transcribing invoice fields from a scanned page image.
For each requested field, transcribe the exact characters as printed. Do NOT
compute or infer. Missing fields: status "missing". Unclear: status "ambiguous".

Fields: {fields}
"""


PAGE_TEXT_PROMPT = """Transcribe every line of text printed on this scanned page, exactly as
printed, one entry per line, top to bottom. Do not summarise, compute, correct
or reorder anything. Keep numbers, punctuation and spacing as they appear."""


def transcribe_page(png_bytes: bytes, page: int, budget: CallBudget) -> str:
    """Second, independent reading of the whole page. Code compares the field
    transcriptions against it: a value that both readings contain is confirmed
    without the reviewer; a value only one reading produced is not."""
    from google.genai import types
    contents = [types.Part.from_bytes(data=png_bytes, mime_type="image/png"), PAGE_TEXT_PROMPT]
    result = _generate(budget, "verify", PRIMARY_MODEL, contents, PageText)
    return "\n".join(result.lines)


def extract_scan(png_bytes: bytes, page: int, budget: CallBudget) -> list[Transcription]:
    from google.genai import types
    contents = [
        types.Part.from_bytes(data=png_bytes, mime_type="image/png"),
        SCAN_PROMPT.format(fields=", ".join(FIELDS)),
    ]
    result = _generate(budget, "vision", PRIMARY_MODEL, contents, TranscriptionList)
    for t in result.transcriptions:
        t.page = t.page or page
    return result.transcriptions


# ---------- verification (code, not model) ----------

_AMOUNT_FIELDS = {"subtotal_net", "tax_total", "invoice_gross_total", "amount_due"}


def normalize_amount(raw: str) -> Decimal | None:
    s = raw.strip().replace("$", "").replace("USD", "").strip()
    s = s.replace(",", "")  # v1 fixtures are US-format; ambiguous separators HOLD upstream
    try:
        d = Decimal(s)
    except InvalidOperation:
        return None
    if not d.is_finite():
        return None
    return d.quantize(Decimal("0.01"))


def verify_selection(sel: Selection, rev: ExtractionRevision) -> dict:
    """Returns the checks dict for the stored field record. source_match and
    role_check are code-verified; the model's opinion never sets them."""
    checks = {"source_match": "not_evaluated", "role_check": "not_evaluated",
              "normalization": "not_evaluated", "ambiguity": "none"}
    if sel.status != "selected":
        checks["ambiguity"] = sel.status  # missing/ambiguous/unsupported: valid outcomes, nothing to verify
        return checks
    checks["source_match"] = "fail"  # selected claims must prove themselves
    if not sel.source_block_id or sel.raw_value is None:
        return checks
    block = rev.block(sel.source_block_id)
    if block is None or sel.raw_value not in block.text:
        return checks
    checks["source_match"] = "pass"
    labels = ROLE_LABELS.get(sel.field, [])
    if not labels:
        checks["role_check"] = "pass"  # no label requirement declared
    else:
        # label may sit in the same cell, the nearest cell to the LEFT on the
        # same line, or the nearest cell directly ABOVE (column layouts split
        # label and value into separate evidence blocks)
        context = [block.text.lower()]
        left = [b for b in rev.blocks
                if b.page == block.page and b.x1 <= block.x0 + 1
                and b.top < block.bottom and b.bottom > block.top]
        if left:
            context.append(max(left, key=lambda b: b.x1).text.lower())
        above = [b for b in rev.blocks
                 if b.page == block.page and b.bottom <= block.top + 1
                 and b.x0 < block.x1 and b.x1 > block.x0]
        if above:
            context.append(max(above, key=lambda b: b.bottom).text.lower())
        checks["role_check"] = "pass" if any(l in c for c in context for l in labels) else "fail"
    from .normalize import normalize_field
    checks["normalization"] = "pass" if normalize_field(sel.field, sel.raw_value) is not None else "fail"
    return checks


def _collapse(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().casefold()


def agrees_with_page(field: str, raw_value: str, page_text: str) -> bool:
    """Does an independent transcription of the page contain this value? Text
    fields: verbatim (whitespace and case insensitive). Amounts and dates: the
    same normalised value anywhere on the page (so "1 436,78" and "1436,78"
    agree). Deterministic string/number comparison — no model judgement."""
    from .normalize import extract_amount, extract_date_iso, _NUM_TOKEN, _join_space_groups
    if not page_text or not raw_value:
        return False
    if _collapse(raw_value) in _collapse(page_text):
        return True
    if field in _AMOUNT_FIELDS or field in ("shipping_total",):
        want = extract_amount(raw_value)
        if want is None:
            return False
        joined = _join_space_groups(page_text)
        return any(extract_amount(tok) == want for tok in _NUM_TOKEN.findall(joined))
    if field in ("invoice_date", "due_date"):
        want = extract_date_iso(raw_value)
        return want is not None and any(extract_date_iso(line) == want for line in page_text.splitlines())
    return False


def verify_transcription(t: Transcription, page_text: str | None = None) -> dict:
    """Scan evidence. source_match is 'pass' only when an INDEPENDENT reading of
    the page (transcribe_page) contains the same value — two readings agreeing
    is the code-checkable stand-in for text evidence. Otherwise it stays
    not_applicable and the reviewer confirms the value."""
    checks = {"source_match": "not_applicable", "role_check": "not_applicable",
              "normalization": "not_evaluated", "ambiguity": "none"}
    if t.status != "selected" or t.raw_value is None:
        checks["ambiguity"] = t.status
        return checks
    from .normalize import normalize_field
    checks["normalization"] = "pass" if normalize_field(t.field, t.raw_value) is not None else "fail"
    if page_text is not None:
        agree = agrees_with_page(t.field, t.raw_value, page_text)
        checks["independent_read"] = "agree" if agree else "disagree"
        if agree and checks["normalization"] == "pass":
            checks["source_match"] = "pass"
    return checks
