"""Document-type gate: is this PDF an invoice at all?

Runs BEFORE any model call, on the pdfplumber text layer and page structure
only. Deterministic, explainable, cheap. Its job is to stop junk (a résumé, a
contract, a blank scan, a purchase order, a quote...) from reaching the
review desk as an "invoice with every field missing".

Two verdict classes:
  * ``invoice_like`` True  -> the pipeline continues to extraction.
  * ``invoice_like`` False -> terminal REJECT with UNSUPPORTED_DOCUMENT_TYPE,
    zero model calls, zero financial effect, and a reviewer override ("read
    it as an invoice anyway") for the false negatives a keyword gate will
    occasionally produce.

Scanned pages carry no text, so for them only the structural checks (blank
page) apply here. Their type is settled after extraction, in
``after_extraction``: the independent transcription of the page is classified
like any other text, and what was read must be invoice-shaped.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict

from .currencies import MINOR_UNITS

# ---- vocabulary --------------------------------------------------------------
# multilingual, deliberately broad: a missed word costs one model call and a
# reviewer click; a false "not an invoice" costs the override click.
INVOICE_WORDS = re.compile(
    r"\b(?:invoice|tax invoice|rechnung|facture|factura|fattura|faktura|faktur|factuur|"
    r"nota fiscal|fatura|faktúra|számla|invois|hóa đơn|"
    r"счет|счёт|фактура|"
    r"فاتورة|חשבונית|"
    r"invois|hoa don)\b|"
    r"(?:発票|請求書|请求书|发票|發票|인보이스|세금계산서|فاتورة|חשבונית|"
    r"हóa đơn)",
    re.IGNORECASE)
# Scripts without spaces (Chinese, Japanese, Korean) need their words matched
# WITHOUT \b: every character is a word character, so a keyword inside a longer
# run ("消費税額") has no boundary to find. Each vocabulary is therefore a
# boundary-guarded group for spaced scripts plus a bare group for the rest.
TOTAL_WORDS = re.compile(
    r"\b(?:total|grand total|amount due|balance due|amount payable|total due|net payable|"
    r"gesamt(?:betrag|summe)?|summe|montant|total ttc|total ht|importe|totale|totaal|"
    r"итого)\b|(?:合計|総計|总计|總計|合计|합계|총액)", re.IGNORECASE)
TAX_WORDS = re.compile(
    r"\b(?:tax|vat|gst|hst|pst|sales tax|tva|iva|mwst|ust|btw|moms|imposto|ndc|ндс)\b"
    r"|(?:消費税|消费税|增值税|加值稅|부가세|세액)", re.IGNORECASE)
BILLING_WORDS = re.compile(
    r"\b(?:bill to|billed to|invoice to|sold to|ship to|remit to|remittance|payment terms|"
    r"due date|payable to|iban|swift|bic|account number|sort code|routing|"
    r"purchase order|po number|po no|order no|tax id|vat no|vat reg|gstin|abn|ein|"
    r"rechnungsnummer|rechnungsdatum|zahlungsbedingungen|fällig|"
    r"date d'échéance|conditions de paiement|fecha de vencimiento|forma de pago)\b",
    re.IGNORECASE)
AMOUNT = re.compile(r"(?<![\w.])\d{1,3}(?:[ ,.  ]\d{3})*[.,]\d{2}(?![\d%])")
# Monetary evidence must cover currencies with no minor unit: a yen or won
# invoice prints "13,200", never "13,200.00", so a decimals-only rule would
# refuse a genuine invoice. Three shapes count, in falling order of certainty:
# a decimal amount, a number beside a currency mark, a grouped integer.
_CURRENCY_NEAR_NUMBER = re.compile(
    "(?:[$\u20ac\u00a3\u20b9\u00a5\u20a9\u20ba\u20aa\u0e3f\u20ab]|\\b[A-Z]{3}\\b)\\s*\\d[\\d,.\u00a0\u202f ]*"
    "|\\d[\\d,.\u00a0\u202f ]*\\s*(?:[$\u20ac\u00a3\u20b9\u00a5\u20a9\u20ba\u20aa\u0e3f\u20ab\u5186\u5143\u5713]|\\b[A-Z]{3}\\b)")
_GROUPED_INTEGER = re.compile("(?<![\\w.,])\\d{1,3}(?:[,.\u00a0\u202f ]\\d{3})+(?![\\d.,%])")


def money_hits(text: str) -> dict:
    """How many of each monetary shape the text contains."""
    return {
        "decimal": len(AMOUNT.findall(text)),
        "currency_adjacent": len(_CURRENCY_NEAR_NUMBER.findall(text)),
        "grouped_integer": len(_GROUPED_INTEGER.findall(text)),
    }


CURRENCY_SYMBOL = re.compile(r"[$€£₹¥₩₺₪฿₫]")
_CODE_TOKEN = re.compile(r"\b([A-Z]{3})\b")
DATE = re.compile(
    r"\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b|\b\d{1,2}[-./]\d{1,2}[-./]\d{2,4}\b|"
    r"\b\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}\b|\b[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\b")
# The keyword needs its own word boundary, or "INV" matches inside "INVOICE"
# and captures the rest of the word; and an invoice number carries a digit, so
# a following word ("INVOICE contact", "Rechnung Datum") is never an id.
INVOICE_NUMBER = re.compile(
    r"\b(?:invoice|inv|rechnung|facture|factura|fattura|faktura)\b\s*(?:no\.?|nr\.?|nº|number|#|n°)?\s*[:.#]?\s*"
    r"([A-Z0-9][A-Z0-9\-/]{2,})", re.IGNORECASE)


def invoice_numbers(text: str) -> set[str]:
    """Invoice numbers stated after an invoice-number label. A candidate must
    contain a digit, which is what separates an id from the next word."""
    return {m.group(1).upper() for m in INVOICE_NUMBER.finditer(text or "")
            if any(ch.isdigit() for ch in m.group(1))}

# Document types that look financial but are NOT payable invoices. Checked in
# order; the first match wins. A pattern may require the absence of invoice
# wording (so a "Purchase Order" printed on an invoice as a reference does not
# reclassify it).
OTHER_TYPES: list[tuple[str, re.Pattern, bool, str]] = [
    # kind, title pattern, needs_absence_of_invoice_word, human label
    ("credit_note", re.compile(r"\b(?:credit note|credit memo|credit invoice|gutschrift|avoir|nota de crédito|nota di credito|abono)\b", re.I), False, "credit note"),
    ("proforma", re.compile(r"\b(?:pro[\s-]?forma)\b", re.I), False, "pro forma invoice"),
    ("purchase_order", re.compile(r"\b(?:purchase order|bestellung|bon de commande|orden de compra|ordine d'acquisto)\b", re.I), True, "purchase order"),
    ("quote", re.compile(r"\b(?:quotation|quote|estimate|angebot|devis|presupuesto|preventivo|offerte)\b", re.I), True, "quote or estimate"),
    ("statement", re.compile(r"\b(?:statement of account|account statement|kontoauszug|relevé de compte|estado de cuenta)\b", re.I), True, "statement of account"),
    ("delivery_note", re.compile(r"\b(?:delivery note|packing (?:slip|list)|lieferschein|bon de livraison|albarán|bolla)\b", re.I), True, "delivery note or packing slip"),
    ("remittance", re.compile(r"\b(?:remittance advice|payment advice|zahlungsavis|avis de paiement)\b", re.I), True, "remittance advice"),
    ("receipt", re.compile(r"\b(?:receipt|quittung|reçu|recibo|ricevuta|kassenbon|kwitantie)\b", re.I), True, "receipt"),
]

MIN_BLANK_DRAWINGS = 20  # vector strokes below which an imageless, textless page is blank


@dataclass
class DocTypeVerdict:
    kind: str                       # invoice | blank | not_invoice | bundle | <OTHER_TYPES kind>
    invoice_like: bool
    label: str                      # reviewer-facing name of what was found
    reasons: list[str] = field(default_factory=list)
    signals: dict = field(default_factory=dict)
    forced: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def _signals(text: str) -> dict:
    codes = {c for c in _CODE_TOKEN.findall(text) if c in MINOR_UNITS}
    numbers = invoice_numbers(text)
    money = money_hits(text)
    return {
        "invoice_words": len(INVOICE_WORDS.findall(text)),
        "total_words": len(TOTAL_WORDS.findall(text)),
        "tax_words": len(TAX_WORDS.findall(text)),
        "billing_words": len(BILLING_WORDS.findall(text)),
        "amounts": money["decimal"],
        "amounts_any": max(money.values()),
        "monetary": money,
        "currency_marks": len(CURRENCY_SYMBOL.findall(text)) + len(codes),
        "dates": len(DATE.findall(text)),
        "invoice_numbers": sorted(numbers),
        "chars": len(text),
    }


def page_structure(pdf_path: str) -> list[dict]:
    """Per page: text length, image count, vector drawing count. Used to tell
    a blank page (nothing at all) from a scanned page (an image, no text)."""
    import fitz
    out = []
    doc = fitz.open(pdf_path)
    try:
        for page in doc:
            try:
                drawings = len(page.get_drawings())
            except Exception:  # noqa: BLE001 — a malformed content stream is not a blank page
                drawings = MIN_BLANK_DRAWINGS
            out.append({
                "text_chars": len((page.get_text() or "").strip()),
                "images": len(page.get_images(full=True)),
                "drawings": drawings,
            })
    finally:
        doc.close()
    return out


def _bundle_numbers(page_texts: list[str] | None, all_numbers: set[str], pages: int) -> list[str] | None:
    """Two invoices in one file, evidenced by two DIFFERENT invoice numbers on
    two different pages. One invoice that repeats its own number on every page
    is not a bundle, and neither is a single page however many labels it
    carries."""
    if len(all_numbers) < 2:
        return None
    if page_texts:
        per_page = [invoice_numbers(t) for t in page_texts]
        for i, a in enumerate(per_page):
            for b in per_page[i + 1:]:
                if a and b and not (a & b):
                    return sorted(a | b)
        return None
    return sorted(all_numbers) if pages >= 2 else None


def classify_text(text: str, pages: int = 1, page_texts: list[str] | None = None) -> DocTypeVerdict:
    """Classify from the text layer alone (unit-testable). Empty text is
    'no judgement': returns invoice_like True with kind 'unknown' so the
    scan path can decide with its own evidence."""
    text = text or ""
    if len(text.strip()) < 20:
        return DocTypeVerdict("unknown", True, "no text layer",
                              ["The PDF has no readable text; the scanned-page reading decides."])
    sig = _signals(text)
    has_invoice_word = sig["invoice_words"] > 0

    for kind, pattern, needs_absence, label in OTHER_TYPES:
        if pattern.search(text) and (not needs_absence or not has_invoice_word):
            sig["matched_title"] = pattern.search(text).group(0)
            return DocTypeVerdict(kind, False, label, [
                f"The document calls itself a {label} (“{sig['matched_title']}”).",
                "Only supplier invoices are decided here. A " + label + " is not payable against a purchase order.",
            ], sig)

    bundle = _bundle_numbers(page_texts, set(sig["invoice_numbers"]), pages)
    if bundle:
        sig["bundle_numbers"] = bundle
        return DocTypeVerdict("bundle", False, "several invoices in one file", [
            f"{len(bundle)} different invoice numbers were found on different pages: "
            + ", ".join(bundle[:4]) + ".",
            "Each invoice is decided on its own. Split the file and upload one invoice at a time.",
        ], sig)

    strong = has_invoice_word and sig["amounts_any"] >= 1
    structural = (sig["total_words"] >= 1 and sig["amounts_any"] >= 2
                  and (sig["currency_marks"] >= 1 or sig["tax_words"] >= 1))
    if strong or structural:
        return DocTypeVerdict("invoice", True, "invoice", ["Invoice wording and monetary amounts are present."], sig)

    missing = []
    if not has_invoice_word:
        missing.append("the word “invoice” (in any supported language)")
    if sig["amounts_any"] == 0:
        missing.append("monetary amounts")
    elif sig["amounts_any"] < 2:
        missing.append("more than one monetary amount")
    if sig["total_words"] == 0:
        missing.append("a total or amount due")
    if sig["currency_marks"] == 0 and sig["tax_words"] == 0:
        missing.append("a currency or tax line")
    return DocTypeVerdict("not_invoice", False, "not an invoice", [
        "None of the things every invoice carries were found: " + ", ".join(missing) + ".",
        "Nothing was sent to the reading model and nothing needs filling in.",
    ], sig)


def classify_document(pdf_path: str, blocks_text: str, pages: int, page_kinds: tuple[str, ...],
                      page_texts: list[str] | None = None) -> DocTypeVerdict:
    """Full pre-extraction verdict: structure first (blank pages), then text."""
    structure = page_structure(pdf_path)
    blank_pages = [i + 1 for i, s in enumerate(structure)
                   if s["text_chars"] == 0 and s["images"] == 0 and s["drawings"] < MIN_BLANK_DRAWINGS]
    if structure and len(blank_pages) == len(structure):
        return DocTypeVerdict("blank", False, "blank document", [
            f"All {len(structure)} page(s) are empty: no text, no images, no drawings.",
            "There is nothing to read. Check the export or scan and upload the invoice itself.",
        ], {"blank_pages": blank_pages, "pages": len(structure)})

    verdict = classify_text(blocks_text, pages, page_texts)
    verdict.signals["blank_pages"] = blank_pages
    verdict.signals["page_kinds"] = list(page_kinds)
    if verdict.kind == "unknown" and "scanned" in page_kinds:
        verdict.reasons = ["Image-only pages: the type is decided from what the vision reading finds."]
    return verdict


SCAN_AMOUNT_FIELDS = ("subtotal_net", "tax_total", "invoice_gross_total", "amount_due")
SCAN_IDENTITY_FIELDS = ("supplier_name", "invoice_number")


def _selected(fields: dict, names) -> list[str]:
    return [f for f in names
            if f in fields and fields[f].status == "selected" and fields[f].raw_value]


def after_extraction(fields: dict, any_scanned: bool, page_text: str | None = None) -> DocTypeVerdict | None:
    """Post-extraction type gate for image-only documents, which have no text
    layer for the pre-extraction gate to judge.

    Two independent pieces of evidence, either of which can refuse the
    document:

    * the independent transcription of the whole page, run through the same
      classifier the text path uses — a letter, a photo or a delivery note
      reads as what it is;
    * the shape of what was read — an invoice states an amount AND identifies
      itself (supplier or invoice number), or states at least two amounts. One
      stray field on an otherwise blank reading is not an invoice, and must not
      open a review form asking for the rest.

    Text documents were already judged on their text; for them an empty reading
    is a real invoice the model could not read, and the reviewer fills it in.
    """
    if not any_scanned:
        return None
    amounts = _selected(fields, SCAN_AMOUNT_FIELDS)
    identity = _selected(fields, SCAN_IDENTITY_FIELDS)
    shape_ok = bool(amounts and identity) or len(amounts) >= 2

    if page_text:
        verdict = classify_text(page_text)
        if not verdict.invoice_like:
            verdict.signals["scan"] = True
            verdict.signals["fields_found"] = amounts + identity
            verdict.reasons = [
                f"The page was read twice and reads as {verdict.label}."
            ] + verdict.reasons[1:] + [
                "If this is an invoice, use “Read as an invoice anyway” to send it to the review desk.",
            ]
            return verdict
    if shape_ok:
        return None
    found = amounts + identity
    return DocTypeVerdict("not_invoice", False, "not an invoice", [
        "The scanned page was read, and it does not state what an invoice states: "
        + (f"only {', '.join(f.replace('_', ' ') for f in found)} could be read, with no "
           "amount and identity together." if found else
           "none of the supplier, invoice number or amounts could be read."),
        "Nothing is asked of you, because there is nothing to correct on a document of this kind.",
        "If this is an invoice, use “Read as an invoice anyway” to send it to the review desk.",
    ], {"scan": True, "fields_found": found})
