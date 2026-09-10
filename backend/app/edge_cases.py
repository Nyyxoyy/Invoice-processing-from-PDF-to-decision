"""Catalogue of faulty-document edge cases the product handles.

Served at /api/edge-cases and rendered on the "Edge cases" page. Kept in code,
next to the limits it quotes, so the page describes what the pipeline actually
does. ``status`` is one of:
  handled     - detected deterministically and routed as described
  limitation  - known, documented, not (yet) detected; behaviour described
Each handled case names the automated test that exercises it.
"""
from __future__ import annotations

import json
from pathlib import Path

from .evidence import GARBLED_ALNUM_RATIO, SCAN_TEXT_THRESHOLD
from .doctype import MIN_BLANK_DRAWINGS

EVIDENCE_DIR = Path(__file__).resolve().parents[2] / "evidence" / "edge-cases"
PROBE_DIR = EVIDENCE_DIR / "fixtures"
RUNS_DIR = EVIDENCE_DIR / "runs"
PROBE_RESULTS = EVIDENCE_DIR / "results.json"


def probe_results() -> dict:
    """Results of the last `tools/edge_case_probe.py` run: what each case
    actually did when its fixture was uploaded to the real application. Absent
    file -> no claims made."""
    try:
        return json.loads(PROBE_RESULTS.read_text())
    except (OSError, ValueError):
        return {}


def _inside(directory: Path, name: str) -> Path | None:
    """Resolve one file by name inside `directory`, refusing anything else."""
    if "/" in name or "\\" in name or name.startswith("."):
        return None
    candidate = (directory / name).resolve()
    if candidate.parent != directory.resolve() or not candidate.is_file():
        return None
    return candidate


def fixture_path(name: str) -> Path | None:
    return _inside(PROBE_DIR, name)


def saved_result(name: str) -> dict | None:
    """The full result the application recorded for one probe upload: decision,
    codes, explanation, document-type verdict, fields and activity."""
    path = _inside(RUNS_DIR, name)
    if path is None:
        return None
    try:
        return json.loads(path.read_text())
    except ValueError:
        return None


def _limits() -> dict:
    from .extractor import CallBudget
    from .main import MAX_UPLOAD_BYTES
    from .pipeline import MAX_PAGES
    b = CallBudget()
    return {
        "max_upload_mb": MAX_UPLOAD_BYTES // (1024 * 1024),
        "max_pages": MAX_PAGES,
        "scan_text_threshold_chars": SCAN_TEXT_THRESHOLD,
        "garbled_alnum_ratio": GARBLED_ALNUM_RATIO,
        "blank_page_min_drawings": MIN_BLANK_DRAWINGS,
        "model_calls_per_document": b.max_logical,
        "model_retries_per_document": b.max_retries_total,
        "model_wall_seconds": int(b.wall_seconds),
        "model_token_cap": b.max_total_tokens,
    }


def catalogue(include_probe: bool = True) -> dict:
    L = _limits()
    groups = [
        {
            "id": "intake",
            "title": "1 · Before the file is stored",
            "summary": "Rejected at upload. Nothing is saved, no run is created.",
            "cases": [
                {
                    "id": "wrong-extension",
                    "title": "Not a .pdf file (image, Word, spreadsheet, e-mail)",
                    "detection": "Browser checks the file name before sending. Server checks the first bytes for the %PDF signature, so a renamed .docx or .png is refused as well.",
                    "outcome": "Refused with “not a PDF”. No run, no record.",
                    "next_step": "Export or print the invoice to PDF and upload that.",
                    "status": "handled",
                    "test": "test_upload_rejects_non_pdf_bytes",
                },
                {
                    "id": "empty-file",
                    "title": "Empty file (0 bytes)",
                    "detection": "Browser refuses a zero-size file; the server’s PDF-signature check refuses it too.",
                    "outcome": "Refused before processing.",
                    "next_step": "Re-download or re-export the invoice; the file did not save correctly.",
                    "status": "handled",
                    "test": "test_upload_rejects_non_pdf_bytes",
                },
                {
                    "id": "too-large",
                    "title": f"File larger than {L['max_upload_mb']} MB",
                    "detection": "Size check in the browser and again on the server.",
                    "outcome": "Refused with “file too large”.",
                    "next_step": "Compress the PDF or ask the supplier for a smaller copy.",
                    "status": "handled",
                    "test": "test_upload_rejects_oversize",
                },
                {
                    "id": "already-processing",
                    "title": "Second upload while one is still processing",
                    "detection": "One bounded worker; the page tracks the live run.",
                    "outcome": "Upload is queued behind the live run; the page shows the run in progress.",
                    "next_step": "Wait for the current result, then upload.",
                    "status": "handled",
                    "test": None,
                },
            ],
        },
        {
            "id": "parse",
            "title": "2 · The PDF cannot be opened or rendered",
            "summary": "Stored, then marked “Couldn’t process” with the exact reason. Retry and replacement are offered. No review form.",
            "cases": [
                {
                    "id": "corrupt",
                    "title": "Corrupt or truncated PDF",
                    "detection": "The parser raises while opening the file.",
                    "outcome": "Run fails with parse_error and the parser’s error type.",
                    "next_step": "“The PDF could not be opened.” Export a new copy or ask the supplier for a readable file.",
                    "status": "handled",
                    "test": "test_corrupt_pdf_fails_explicitly",
                },
                {
                    "id": "encrypted",
                    "title": "Password-protected PDF",
                    "detection": "The document reports that it needs a password before anything can be read.",
                    "outcome": "Run fails with “encrypted: password required”. The password is never asked for or stored.",
                    "next_step": "Ask the supplier for an unlocked copy, or remove the password and upload again.",
                    "status": "handled",
                    "test": "test_encrypted_pdf_fails_with_reason",
                },
                {
                    "id": "zero-pages",
                    "title": "PDF with no pages",
                    "detection": "Page count is zero after opening.",
                    "outcome": "Run fails with “no_pages”. No model call.",
                    "next_step": "The export produced an empty document; export again.",
                    "status": "handled",
                    "test": "test_zero_page_pdf_fails",
                },
                {
                    "id": "too-many-pages",
                    "title": f"More than {L['max_pages']} pages",
                    "detection": "Page count after opening.",
                    "outcome": "Run fails with “page_limit”. No model call.",
                    "next_step": f"Upload the invoice itself ({L['max_pages']} pages or fewer), without appendices or terms.",
                    "status": "handled",
                    "test": "test_page_limit_fails",
                },
                {
                    "id": "render-error",
                    "title": "Scanned page that cannot be rasterised",
                    "detection": "Rendering the page to an image raises.",
                    "outcome": "Run fails with “render_error”.",
                    "next_step": "Re-scan or re-export the page.",
                    "status": "handled",
                    "test": None,
                },
                {
                    "id": "interrupted",
                    "title": "Server restarted mid-reading",
                    "detection": "On start-up every run still marked running is closed as “interrupted”.",
                    "outcome": "Nothing was approved; the attempt is kept in history.",
                    "next_step": "“Try reading again” starts a new attempt on the same stored file.",
                    "status": "handled",
                    "test": "test_startup_recovery_marks_interrupted",
                },
            ],
        },
        {
            "id": "doctype",
            "title": "3 · The file opens, but it is not an invoice",
            "summary": "Decided by code on the text layer and page structure, before any model call. Result: Rejected · UNSUPPORTED_DOCUMENT_TYPE. No fields to fill in. A reviewer can override with “Read as an invoice anyway”.",
            "cases": [
                {
                    "id": "blank",
                    "title": "Blank pages (empty export, failed scan)",
                    "detection": f"Every page has no text, no images and fewer than {L['blank_page_min_drawings']} vector strokes.",
                    "outcome": "Rejected as a blank document. No model call.",
                    "next_step": "Check the export or scan; upload the invoice itself.",
                    "status": "handled",
                    "test": "test_blank_pdf_rejected_without_model_call",
                },
                {
                    "id": "junk-text",
                    "title": "Unrelated text document (résumé, contract, article, random text)",
                    "detection": "None of the invoice signals are present: the word “invoice” (in 20+ languages), monetary amounts, a total/amount-due line, a currency or tax line.",
                    "outcome": "Rejected as “not an invoice”, with the list of signals that were missing. No model call.",
                    "next_step": "Upload the invoice. If this really is one, “Read as an invoice anyway”.",
                    "status": "handled",
                    "test": "test_junk_text_pdf_rejected_without_model_call",
                },
                {
                    "id": "purchase-order",
                    "title": "Purchase order",
                    "detection": "Calls itself a purchase order and never uses the word invoice.",
                    "outcome": "Rejected, named as a purchase order.",
                    "next_step": "Orders are created under Purchase orders, not uploaded as invoices.",
                    "status": "handled",
                    "test": "test_other_financial_documents_rejected_by_type",
                },
                {
                    "id": "quote",
                    "title": "Quote, estimate or pro forma invoice",
                    "detection": "Quote/estimate wording without invoice wording; “pro forma” in any form.",
                    "outcome": "Rejected, named as a quote or pro forma. A pro forma is not payable even though it says “invoice”.",
                    "next_step": "Wait for the final invoice.",
                    "status": "handled",
                    "test": "test_other_financial_documents_rejected_by_type",
                },
                {
                    "id": "credit-note",
                    "title": "Credit note / credit memo",
                    "detection": "Credit-note wording in any supported language, even alongside the word invoice.",
                    "outcome": "Rejected, named as a credit note. Negative amounts never reach the ledger.",
                    "next_step": "Credits are handled outside this workflow.",
                    "status": "handled",
                    "test": "test_other_financial_documents_rejected_by_type",
                },
                {
                    "id": "statement-delivery-remittance-receipt",
                    "title": "Statement of account, delivery note, packing slip, remittance advice, receipt",
                    "detection": "Their title wording without invoice wording.",
                    "outcome": "Rejected, named by type.",
                    "next_step": "Upload the invoice these documents accompany.",
                    "status": "handled",
                    "test": "test_other_financial_documents_rejected_by_type",
                },
                {
                    "id": "bundle",
                    "title": "Several invoices in one PDF",
                    "detection": "Two or more different invoice numbers after an invoice-number label, across two or more pages.",
                    "outcome": "Rejected as a bundle, listing the numbers found.",
                    "next_step": "Split the file and upload one invoice at a time.",
                    "status": "handled",
                    "test": "test_bundle_of_invoices_rejected",
                },
                {
                    "id": "scan-nothing-found",
                    "title": "Scanned image that is not an invoice (photo, letter, drawing)",
                    "detection": "No text layer to judge, so the reading itself is the evidence: the independent transcription of the whole page is run through the same classifier the text path uses, and the shape of what was read must be invoice-shaped (an amount plus a supplier or invoice number, or two amounts). One stray field on an otherwise blank reading is not enough.",
                    "outcome": "Rejected as “not an invoice” after the reading; no review form and no fields to correct.",
                    "next_step": "Upload the invoice. If it is one, “Read as an invoice anyway” sends it to the review desk.",
                    "status": "handled",
                    "test": "test_scan_with_no_invoice_fields_rejected",
                },
                {
                    "id": "override",
                    "title": "False alarm: a real invoice rejected as “not an invoice”",
                    "detection": "Reviewer judgement.",
                    "outcome": "“Read as an invoice anyway” starts a new attempt that skips the type gate. The override is recorded on the run.",
                    "next_step": "The invoice then follows the normal path: extraction, checks, review where needed.",
                    "status": "handled",
                    "test": "test_read_as_invoice_override",
                },
                {
                    "id": "non-english",
                    "title": "Invoice in another language",
                    "detection": "Invoice wording is matched in 20+ languages, including scripts written without spaces (Chinese, Japanese, Korean), where the keywords are matched without word boundaries. Amounts, totals and tax lines count as structural evidence even when the wording is unknown.",
                    "outcome": "Passes the gate; extraction proceeds.",
                    "next_step": "None. If the gate is ever wrong, “Read as an invoice anyway” overrides it.",
                    "status": "handled",
                    "test": "test_foreign_language_invoice_passes_gate",
                },
            ],
        },
        {
            "id": "text-layer",
            "title": "4 · The text layer is present but unusable",
            "summary": "Pages are reclassified so the reading uses the page image instead of junk text.",
            "cases": [
                {
                    "id": "garbled",
                    "title": "Garbled text layer (symbol soup, “(cid:…)” runs, broken font encoding)",
                    "detection": f"Letters and digits make up less than {int(L['garbled_alnum_ratio'] * 100)}% of the visible characters, or “(cid:” appears repeatedly.",
                    "outcome": "The page is treated as scanned: no text blocks, the image is read instead. Recorded as garbled_pages on the run.",
                    "next_step": "Scanned-page rules apply: code-confirmed values pass, the rest are confirmed by the reviewer.",
                    "status": "handled",
                    "test": "test_garbled_text_layer_treated_as_scan",
                },
                {
                    "id": "sparse-text",
                    "title": "Image page with a few characters of text (a stamp, a page number)",
                    "detection": f"Fewer than {L['scan_text_threshold_chars']} characters of text on the page.",
                    "outcome": "Treated as a scanned page and read from the image.",
                    "next_step": "Scanned-page rules apply.",
                    "status": "handled",
                    "test": "test_scan_fields_confirmed_by_code_need_no_attestation",
                },
                {
                    "id": "hidden-text",
                    "title": "Hidden or white text, instructions to the model inside the PDF",
                    "detection": "Not detected as such. The model may only select text that exists in the evidence blocks; every selected value is checked against its source block and normalised by code, and money is decided by code alone.",
                    "outcome": "Injected text cannot create a value that is not on the page, and cannot approve anything.",
                    "next_step": "None.",
                    "status": "limitation",
                    "test": "test_hallucinated_value_fails_source_match",
                },
                {
                    "id": "first-scan-only",
                    "title": "Mixed document where the invoice is on a later image-only page",
                    "detection": "Only the first scanned page is read from its image.",
                    "outcome": "Fields on later scanned pages are missed; the run holds for review.",
                    "next_step": "Upload the invoice page(s) alone.",
                    "status": "limitation",
                    "test": None,
                },
            ],
        },
        {
            "id": "extraction",
            "title": "5 · It is an invoice, but the reading fails or is incomplete",
            "summary": "Held for review with the exact gaps, or marked “Couldn’t process” when no reading came back. Never approved.",
            "cases": [
                {
                    "id": "budget",
                    "title": "Model unavailable, times out or returns unparseable output",
                    "detection": f"Per-document budget: {L['model_calls_per_document']} logical calls, {L['model_retries_per_document']} retries, {L['model_wall_seconds']} s wall time, {L['model_token_cap']:,} tokens.",
                    "outcome": "Budget exhausted: held with no fields, shown as “We couldn’t finish reading this invoice”.",
                    "next_step": "“Try reading again” or upload a clearer copy.",
                    "status": "handled",
                    "test": "test_budget_exhausted_holds_without_posting",
                },
                {
                    "id": "value-not-in-source",
                    "title": "Model returns a value that is not in the block it cites",
                    "detection": "Code checks the raw value is a substring of the cited block and that a role label sits nearby.",
                    "outcome": "The field fails source_match and does not count as verified; the invoice holds.",
                    "next_step": "Reviewer confirms or corrects the field against the document.",
                    "status": "handled",
                    "test": "test_hallucinated_value_fails_source_match",
                },
                {
                    "id": "missing-fields",
                    "title": "Required field missing or ambiguous on a genuine invoice",
                    "detection": "Model reports missing/ambiguous; code never fills in.",
                    "outcome": "Held with MISSING_FIELD; only the affected fields are asked for.",
                    "next_step": "Reviewer enters the value from the document, then checks again.",
                    "status": "handled",
                    "test": "test_unknown_vendor_holds_without_identity",
                },
                {
                    "id": "ambiguous-values",
                    "title": "Ambiguous date (03.04.2021), separator (1.234), currency symbol ($)",
                    "detection": "Deterministic parsers return no value when more than one reading is legal.",
                    "outcome": "Held; the reviewer is shown each legal reading and picks one.",
                    "next_step": "Pick the reading that matches the document.",
                    "status": "handled",
                    "test": "test_numeric_dates_deterministic_disambiguation",
                },
                {
                    "id": "math",
                    "title": "Amounts that do not add up, prepayment or prior-balance structures",
                    "detection": "Decimal-exact reconciliation in the invoice currency; amount due ≠ total is an unsupported structure.",
                    "outcome": "Held with MATH_MISMATCH or UNSUPPORTED_AMOUNT_STRUCTURE.",
                    "next_step": "Reviewer corrects the reading or rejects the invoice.",
                    "status": "handled",
                    "test": "test_math_mismatch_holds",
                },
            ],
        },
        {
            "id": "identity",
            "title": "6 · Duplicates and identity",
            "summary": "Same document or same invoice never posts twice.",
            "cases": [
                {
                    "id": "same-bytes",
                    "title": "Same file uploaded again (any file name)",
                    "detection": "SHA-256 of the bytes matches a stored document.",
                    "outcome": "Rejected as DUP_FILE_HASH with a link to the earlier result. Applies to junk files too.",
                    "next_step": "Open the earlier result.",
                    "status": "handled",
                    "test": "test_l1_duplicate_bytes_rejects_original_untouched",
                },
                {
                    "id": "same-invoice",
                    "title": "Same supplier + invoice number already approved",
                    "detection": "Business-key match against posted invoices.",
                    "outcome": "Rejected as DUP_INVOICE_NO; nothing posted.",
                    "next_step": "Open the earlier invoice.",
                    "status": "handled",
                    "test": "test_duplicate_after_approval_original_untouched",
                },
                {
                    "id": "fingerprint",
                    "title": "Same supplier, amount and date under a different number",
                    "detection": "Fingerprint match within the policy window.",
                    "outcome": "Held as a possible duplicate.",
                    "next_step": "Reviewer confirms it is a separate invoice, with a reason, or rejects.",
                    "status": "handled",
                    "test": "test_l3_same_day_same_amount_different_number_holds",
                },
            ],
        },
    ]
    result = {"limits": L, "groups": groups}
    if not include_probe:
        return result
    probe = probe_results()
    by_id = {c["id"]: c for c in probe.get("cases") or []}
    for group in groups:
        for case in group["cases"]:
            case["probe"] = by_id.get(case["id"])
    result["probe"] = {"generated_at": probe.get("generated_at"), "model": probe.get("model"),
                       "cases_run": len(by_id)}
    return result
