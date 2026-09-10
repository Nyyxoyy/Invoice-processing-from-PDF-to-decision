"""Deterministic value extraction from selected source text.

The model selects WHERE a field is stated; these versioned extractors pull the
typed value out of that text. Zero or multiple plausible values in one
selection = ambiguous = None (never a guess). Separator conventions are parsed
only where unambiguous; a potentially scale-changing ambiguity returns None.
"""
from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

from .currencies import MINOR_UNITS, UNAMBIGUOUS_NAMES

NORMALIZER_VERSION = "norm-v2"

_NUM_TOKEN = re.compile(r"\d[\d.,]*\d|\d")
# "1 436,78" / "1 234 567,89": a single (thin, no-break or plain) space between a
# digit and a group of exactly three digits is a thousands separator, as in
# French, German, Swiss and ISO 31-0 formatting. Joined before tokenising so
# the leading group is not mistaken for a separate number.
_SPACE_GROUP = re.compile("(?<=\\d)[ \u00a0\u202f\u2009](?=\\d{3}(?!\\d))")


def _join_space_groups(text: str) -> str:
    return _SPACE_GROUP.sub("", text)
_ISO_DATE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
_PO_REF = re.compile(r"\b([A-Z0-9]*PO-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\b")  # hyphenated ids (PO-SH-1, PO-1001-2026) are one reference
_INVOICE_LABEL = re.compile(
    r"^.*?(?:invoice\s*(?:no\.?|number|#)?|inv\.?\s*(?:no\.?|#)?)\s*[:.]?\s*", re.IGNORECASE)
_CODE_TOKEN = re.compile(r"\b([A-Z]{3})\b")


def _parse_number(token: str) -> Decimal | None:
    """Parse one numeric token under unambiguous separator conventions.
    Ambiguous forms ('1.234', '1,234' with no other evidence) return None —
    matching arithmetic alone cannot resolve a consistent scale error."""
    s = token.replace(" ", "").replace(" ", "")
    has_dot, has_comma = "." in s, "," in s
    try:
        if has_dot and has_comma:
            # last separator is the decimal mark
            if s.rfind(".") > s.rfind(","):
                s = s.replace(",", "")
            else:
                s = s.replace(".", "").replace(",", ".")
        elif has_dot or has_comma:
            sep = "." if has_dot else ","
            parts = s.split(sep)
            if len(parts) == 2 and len(parts[1]) != 3:
                # exactly one separator, non-3 fractional length: decimal mark
                s = s.replace(",", ".")
            elif all(len(p) == 3 for p in parts[1:]) and len(parts[0]) <= 3 and len(parts) > 1 and len(parts[1]) == 3 and (len(parts) > 2 or len(parts[0]) < 4):
                # pure grouping only when a single separator + 3-digit group
                # would be ambiguous -> handled below
                if len(parts) == 2:
                    return None  # '1.234' / '1,234': grouping or decimal? ambiguous
                s = s.replace(sep, "")
            else:
                return None
        d = Decimal(s)
    except InvalidOperation:
        return None
    return d if d.is_finite() else None


def extract_amount(text: str | None) -> Decimal | None:
    if not text:
        return None
    text = _join_space_groups(text)
    # candidates adjacent to a currency mark first; else bare decimal tokens
    marked = re.findall(r"(?:\$|€|£|\b[A-Z]{3}\b)\s*(\d[\d.,]*\d|\d)", text)
    tokens = marked or [t for t in _NUM_TOKEN.findall(text)
                        if not re.search(re.escape(t) + r"\s*%", text)]
    parsed = [d for t in tokens if (d := _parse_number(t)) is not None]
    # drop integers that are grouping fragments of a larger candidate set
    if len(parsed) != 1:
        # retry excluding integer-only tokens (e.g. quantities) when exactly
        # one decimal-bearing candidate exists
        decimals = [d for d in parsed if d != d.to_integral_value()]
        if len(decimals) == 1:
            return decimals[0]
        return None
    return parsed[0]


def quantize_minor(d: Decimal, currency: str) -> int | None:
    """Decimal -> integer minor units for the currency. A fractional part finer
    than the currency's precision is a surfaced error, never silently rounded."""
    exp = MINOR_UNITS.get(currency)
    if exp is None:
        return None
    scaled = d * (Decimal(10) ** exp)
    if scaled != scaled.to_integral_value():
        return None
    return int(scaled)


_MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"])}
_MONTH_NAME_DATE = re.compile(
    r"\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b|\b(\d{1,2})\.?\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b")
_NUM_DMY = re.compile(r"\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b")
_NUM_YMD = re.compile(r"\b(\d{4})[./-](\d{1,2})[./-](\d{1,2})\b")


def _valid(y: int, mo: int, d: int) -> str | None:
    import calendar
    if 1 <= mo <= 12 and 1 <= d <= calendar.monthrange(y, mo)[1]:
        return f"{y:04d}-{mo:02d}-{d:02d}"
    return None


def extract_date_iso(text: str | None) -> str | None:
    """Deterministic date parsing — a value survives only when exactly ONE
    reading is legal:
    - ISO (2021-12-16) and year-first numeric (2021.12.16): month always second
    - month names ('October 12, 2021', '12 Oct 2021'): no positional ambiguity
    - numeric day-first/month-first (16.12.2021): resolved ONLY when one part
      exceeds 12 (so it can only be the day) or both parts are equal.
      03.04.2021 stays ambiguous — both readings are legal dates, and guessing
      a locale silently flips day and month.
    Multiple distinct dates in one selection: ambiguous."""
    if not text:
        return None
    hits: set[str] = set()
    for y, a, b in _NUM_YMD.findall(text):
        iso = _valid(int(y), int(a), int(b))
        if iso:
            hits.add(iso)
    for a, b, y in _NUM_DMY.findall(text):
        a, b, y = int(a), int(b), int(y)
        as_dmy, as_mdy = _valid(y, b, a), _valid(y, a, b)
        if as_dmy and as_mdy:
            if as_dmy == as_mdy:          # 05.05.2021 — same date either way
                hits.add(as_dmy)
            else:
                return None               # genuinely ambiguous — never guess
        elif as_dmy or as_mdy:            # one reading legal (a>12 or b>12)
            hits.add(as_dmy or as_mdy)
    for g in _MONTH_NAME_DATE.findall(text):
        name, day, year = (g[0], g[1], g[2]) if g[0] else (g[4], g[3], g[5])
        month = next((v for k, v in _MONTHS.items() if k.startswith(name.lower())), None)
        if month:
            iso = _valid(int(year), month, int(day))
            if iso:
                hits.add(iso)
    return hits.pop() if len(hits) == 1 else None


def extract_po_refs(text: str | None) -> list[str]:
    """All distinct PO-shaped references in the text, order preserved.
    Requires the literal 'PO-' stem — product codes (BPXPN-...) don't match."""
    if not text:
        return []
    seen: list[str] = []
    for m in _PO_REF.findall(text):
        if m not in seen:
            seen.append(m)
    return seen


def extract_po_ref(text: str | None) -> str | None:
    refs = extract_po_refs(text)
    return refs[0] if len(refs) == 1 else None


def extract_currency(text: str | None) -> str | None:
    """Explicit ISO code or unambiguous currency name only. A bare symbol
    ('$') never establishes currency — USD/CAD/AUD all use it."""
    if not text:
        return None
    codes = {c for c in _CODE_TOKEN.findall(text) if c in MINOR_UNITS}
    if len(codes) == 1:
        return next(iter(codes))
    if codes:
        return None  # conflicting explicit codes
    low = text.lower()
    names = {code for name, code in UNAMBIGUOUS_NAMES.items() if name in low}
    return next(iter(names)) if len(names) == 1 else None


def extract_invoice_number(text: str | None) -> str | None:
    if not text:
        return None
    stripped = _INVOICE_LABEL.sub("", text.strip())
    value = stripped.split()[0] if stripped.split() else None
    return value or None


def extract_name(text: str | None) -> str | None:
    if not text:
        return None
    s = re.sub(r"^\s*(?:bill(?:ed)?\s*to|sold\s*to|customer|supplier|vendor|from)\s*[:.]?\s*",
               "", text.strip(), flags=re.IGNORECASE)
    return s or None


EXTRACTORS = {
    "subtotal_net": extract_amount,
    "tax_total": extract_amount,
    "shipping_total": extract_amount,
    "invoice_gross_total": extract_amount,
    "amount_due": extract_amount,
    "invoice_date": extract_date_iso,
    "due_date": extract_date_iso,
    "po_reference": extract_po_ref,
    "currency": extract_currency,
    "invoice_number": extract_invoice_number,
    "supplier_name": extract_name,
    "buyer_name": extract_name,
}


def normalize_field(field: str, raw: str | None):
    fn = EXTRACTORS.get(field)
    return fn(raw) if fn else (raw.strip() if raw else None)


# ---------------------------------------------------------------------------
# Explaining a refusal. The extractors above return None whenever a value has
# no single legal reading. These helpers say why, in reviewer language, and
# enumerate the legal readings so the reviewer can pick one — the code never
# picks for them.
# ---------------------------------------------------------------------------
_SYMBOL_CODES = {"€": ["EUR"], "£": ["GBP"], "₹": ["INR"], "¥": ["JPY", "CNY"], "₩": ["KRW"], "₺": ["TRY"],
                 "$": ["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "MXN"]}
_AMOUNT_FIELDS = {"subtotal_net", "tax_total", "shipping_total", "invoice_gross_total", "amount_due"}
_DATE_FIELDS = {"invoice_date", "due_date"}


def _month_day(iso: str) -> str:
    import calendar
    y, m, d = (int(x) for x in iso.split("-"))
    return f"{d} {calendar.month_name[m]} {y}"


def unusable_reason(field: str, raw: str | None) -> str | None:
    """Why `raw` cannot be used as the value of `field`; None when it can."""
    if normalize_field(field, raw) is not None:
        return None
    text = (raw or "").strip()
    if not text:
        return "Nothing was read for this field."
    q = f"“{text}”"
    if field == "currency":
        codes = sorted({c for c in _CODE_TOKEN.findall(text) if c in MINOR_UNITS})
        if len(codes) > 1:
            return f"{q} names more than one currency ({', '.join(codes)}). Pick the one the total is in."
        sym = next((s for s in _SYMBOL_CODES if s in text), None)
        if sym == "$":
            return f"{q} is a symbol, not a code — USD, CAD, AUD and others all use it."
        if sym:
            return f"{q} is a symbol, not a code."
        return f"{q} is not a currency code."
    if field in _DATE_FIELDS:
        dmy = _NUM_DMY.findall(text)
        for a, b, y in dmy:
            a, b, y = int(a), int(b), int(y)
            as_dmy, as_mdy = _valid(y, b, a), _valid(y, a, b)
            if as_dmy and as_mdy and as_dmy != as_mdy:
                return f"{q} reads as {_month_day(as_dmy)} or {_month_day(as_mdy)} — both are valid dates."
        found = len(_NUM_YMD.findall(text)) + len(dmy) + len(_MONTH_NAME_DATE.findall(text))
        if found > 1:
            return f"{q} contains more than one date."
        return f"{q} contains no recognisable date."
    if field in _AMOUNT_FIELDS:
        text = _join_space_groups(text)
        tokens = [x for x in _NUM_TOKEN.findall(text) if not re.search(re.escape(x) + r"\s*%", text)]
        parsed = [d for x in tokens if (d := _parse_number(x)) is not None]
        if len(tokens) == 1 and not parsed:
            return f"{q} could be {tokens[0].replace(',', '').replace('.', '')} or a decimal — the separator is ambiguous."
        if len(parsed) > 1:
            return f"{q} contains several numbers ({', '.join(str(d) for d in parsed[:3])}). Enter only the amount."
        return f"{q} contains no number."
    if field == "po_reference":
        return f"{q} contains no purchase order reference (PO-…)."
    if field == "invoice_number":
        return f"{q} has no invoice number after the label."
    return f"{q} could not be read as a {field.replace('_', ' ')}."


def readings(field: str, raw: str | None, currency: str | None = None) -> list[dict]:
    """Legal readings of an unusable raw value, each with the assumption that
    makes it legal. Empty when the value has a single reading (nothing to pick)
    or none at all."""
    text = (raw or "").strip()
    if not text or normalize_field(field, raw) is not None:
        return []
    out: list[dict] = []
    if field == "currency":
        sym = next((s for s in _SYMBOL_CODES if s in text), None)
        if sym == "$":
            for c in _SYMBOL_CODES[sym][:3]:   # the common dollars; the reviewer picks from the invoice
                out.append({"value": c, "reason": "one of the currencies that use the $ symbol"})
        elif sym:
            for c in _SYMBOL_CODES[sym]:
                out.append({"value": c, "reason": f"the {sym} symbol"})
        return out
    if field in _DATE_FIELDS:
        for a, b, y in _NUM_DMY.findall(text):
            a, b, y = int(a), int(b), int(y)
            as_dmy, as_mdy = _valid(y, b, a), _valid(y, a, b)
            if as_dmy and as_mdy and as_dmy != as_mdy:
                out.append({"value": as_dmy, "reason": f"if the day comes first ({_month_day(as_dmy)})"})
                out.append({"value": as_mdy, "reason": f"if the month comes first ({_month_day(as_mdy)})"})
        return out
    if field in _AMOUNT_FIELDS:
        text = _join_space_groups(text)
        tokens = [x for x in _NUM_TOKEN.findall(text) if not re.search(re.escape(x) + r"\s*%", text)]
        parsed = [d for x in tokens if (d := _parse_number(x)) is not None]
        if len(tokens) == 1 and not parsed:
            digits = tokens[0].replace(",", "").replace(".", "")
            exp = MINOR_UNITS.get(currency or "", 2)
            grouped = f"{Decimal(digits):.{exp}f}" if exp else digits
            out.append({"value": grouped, "reason": "if the separator groups thousands"})
            head, tail = re.split(r"[.,]", tokens[0])
            if exp and len(tail) <= exp:
                out.append({"value": f"{Decimal(head + '.' + tail):.{exp}f}", "reason": "if it is a decimal point"})
            elif exp and len(tail) == 3 and exp == 3:
                out.append({"value": f"{head}.{tail}0", "reason": "if it is a decimal point"})
        else:
            for d in parsed[:3]:
                out.append({"value": str(d), "reason": "one of the numbers in the reading"})
        return out
    return out


def display_values(raw: dict, currency_code: str | None = None) -> dict:
    """Clean, label-free values for lists and headers, derived by the same
    extractors that drive the decision: 'Currency: USD Total: $4,968.00' shows
    as 'USD 4,968.00'. Anything that does not normalise falls back to the raw
    text with a leading 'Label:' stripped."""
    from .currencies import MINOR_UNITS
    def strip_label(s):
        return re.sub(r"^[A-Za-z][A-Za-z .]{1,30}:\s*", "", (s or "").strip()) or None
    out: dict = {}
    code = extract_currency(raw.get("currency") or "") or currency_code
    out["currency"] = code
    for name in ("supplier_name", "buyer_name"):
        out[name] = extract_name(raw.get(name) or "") or strip_label(raw.get(name))
    out["invoice_number"] = extract_invoice_number(raw.get("invoice_number") or "") or strip_label(raw.get("invoice_number"))
    for name in ("invoice_date", "due_date"):
        out[name] = extract_date_iso(raw.get(name) or "") or strip_label(raw.get(name))
    out["po_reference"] = extract_po_ref(raw.get("po_reference") or "") or strip_label(raw.get("po_reference"))
    for name in ("subtotal_net", "tax_total", "shipping_total", "invoice_gross_total", "amount_due"):
        amount = extract_amount(raw.get(name) or "")
        if amount is not None:
            exp = MINOR_UNITS.get(code or "", 2)
            out[name] = f"{code + ' ' if code else ''}{amount:,.{exp}f}"
        else:
            out[name] = strip_label(raw.get(name))
    return out
