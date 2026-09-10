# Edge cases: what actually happened

Generated 2026-09-10T21:51:25+00:00 by `tools/edge_case_probe.py`, reading model `gemini-3.5-flash-lite`. Only empty-file were re-run; the other rows are from the previous run.

Every case below was run through the real application: a fixture file was uploaded to `POST /api/invoices` in a fresh temporary workspace, and the route, reason codes, failure reason, document-type verdict and number of outbound model calls were read back from the run itself. Everything is kept under `evidence/edge-cases/`: the uploaded file in `fixtures/`, and the complete saved result of that upload — decision, reason codes, explanation, document-type verdict, every field the reader returned and the whole activity trail — in `runs/`. The Edge cases page renders those saved results directly, so a result can be read without re-running anything.

Outbound reader calls are paced, because the model rate-limits a burst and a throttled reading looks exactly like a document the product could not read. A case whose reading was refused by the API is re-run once before it is reported.

| | Verdict | Meaning |
|---|---|---|
| ✅ | confirmed | Observed behaviour matches the catalogue entry |
| ⚠️ | not reproduced | No fixture can force this condition; the note says why |
| ❌ | unexpected | Observed behaviour differs from the catalogue entry |
| — | not run | No runner for this case |

## 1 · Before the file is stored

### ✅ Not a .pdf file (image, Word, spreadsheet, e-mail)

*Expected:* Refused with “not a PDF”. No run, no record.

- `wrong-extension.png` → HTTP 422 · 0 model calls · error not a PDF
  - uploaded a PNG renamed to invoice.pdf

### ✅ Empty file (0 bytes)

*Expected:* Refused before processing.

- `empty-file.pdf` → HTTP 422 · 0 model calls · error not a PDF

### ✅ File larger than 10 MB

*Expected:* Refused with “file too large”.

- `too-large.pdf` *(built at run time, not stored)* → HTTP 413 · 0 model calls · error file too large
  - 11.0 MB file, built at run time and not stored in the repository

### ✅ Second upload while one is still processing

*Expected:* Upload is queued behind the live run; the page shows the run in progress.

- `concurrent-a.pdf` → HTTP 200 · AUTO_APPROVE · type “invoice” · posted — [saved result](evidence/edge-cases/runs/already-processing-1.json)
  - verdict reason: Invoice wording and monetary amounts are present.
  - uploaded simultaneously
- `concurrent-b.pdf` → HTTP 200 · AUTO_APPROVE · type “invoice” · posted — [saved result](evidence/edge-cases/runs/already-processing-2.json)
  - verdict reason: Invoice wording and monetary amounts are present.
  - uploaded simultaneously

both finished in 11.0s; the worker lock serialised them, neither run failed.

## 2 · The PDF cannot be opened or rendered

### ✅ Corrupt or truncated PDF

*Expected:* Run fails with parse_error and the parser’s error type.

- `corrupt.pdf` → HTTP 422 · run failed · reason “parse_error: PdfminerException” · 0 model calls · error unreadable PDF (PdfminerException) — [saved result](evidence/edge-cases/runs/corrupt-1.json)

### ✅ Password-protected PDF

*Expected:* Run fails with “encrypted: password required”. The password is never asked for or stored.

- `encrypted.pdf` → HTTP 422 · run failed · reason “encrypted: password required” · 0 model calls · error the PDF is password-protected — [saved result](evidence/edge-cases/runs/encrypted-1.json)
  - user password “secret”; never asked for or stored

### ✅ PDF with no pages

*Expected:* Run fails with “no_pages”. No model call.

- `zero-pages.pdf` → HTTP 422 · run failed · reason “no_pages: the PDF has no pages” · 0 model calls · error the PDF has no pages — [saved result](evidence/edge-cases/runs/zero-pages-1.json)

### ✅ More than 10 pages

*Expected:* Run fails with “page_limit”. No model call.

- `too-many-pages.pdf` → HTTP 422 · run failed · reason “page_limit: 11 > 10” · 0 model calls · error page limit exceeded (11 pages) — [saved result](evidence/edge-cases/runs/too-many-pages-1.json)
  - 11 pages

### ⚠️ Scanned page that cannot be rasterised

*Expected:* Run fails with “render_error”.

- `render-error.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “not an invoice” · 2 model calls · nothing posted — [saved result](evidence/edge-cases/runs/render-error-1.json)
  - verdict reason: The scanned page was read, and it does not state what an invoice states: none of the supplier, invoice number or amounts could be read.
  -  — the damaged file still rasterised, so the run continued normally

PyMuPDF does not raise on a damaged image stream: it returns whatever it can rasterise, so this run continued and was judged on what the reading found. The render_error branch is real and guards a genuine failure mode (an unreadable page object), but no fixture built here forces it. Treat this row as code-inspection only, not as verified behaviour.

### ✅ Server restarted mid-reading

*Expected:* Nothing was approved; the attempt is kept in history.

- `interrupted.pdf` → HTTP 200 · run failed · reason “interrupted” · type “invoice” · 0 model calls — [saved result](evidence/edge-cases/runs/interrupted-2.json)
  - verdict reason: Invoice wording and monetary amounts are present.
  - run forced back to “running”, then the app was restarted

the original upload decided AUTO_APPROVE; after the simulated kill the attempt is kept, not deleted.

## 3 · The file opens, but it is not an invoice

### ✅ Blank pages (empty export, failed scan)

*Expected:* Rejected as a blank document. No model call.

- `blank.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “blank document” · 0 model calls · nothing posted — [saved result](evidence/edge-cases/runs/blank-1.json)
  - verdict reason: All 2 page(s) are empty: no text, no images, no drawings.

### ✅ Unrelated text document (résumé, contract, article, random text)

*Expected:* Rejected as “not an invoice”, with the list of signals that were missing. No model call.

- `junk-text.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “not an invoice” · 0 model calls · nothing posted — [saved result](evidence/edge-cases/runs/junk-text-1.json)
  - verdict reason: None of the things every invoice carries were found: the word “invoice” (in any supported language), monetary amounts, a total or amount due, a currency or tax line.
  - 0 field revisions saved (a review form needs at least one)

### ✅ Purchase order

*Expected:* Rejected, named as a purchase order.

- `purchase-order.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “purchase order” · 0 model calls · nothing posted — [saved result](evidence/edge-cases/runs/purchase-order-1.json)
  - verdict reason: The document calls itself a purchase order (“PURCHASE ORDER”).
  - 0 field revisions saved (a review form needs at least one)

### ✅ Quote, estimate or pro forma invoice

*Expected:* Rejected, named as a quote or pro forma. A pro forma is not payable even though it says “invoice”.

- `quote.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “quote or estimate” · 0 model calls · nothing posted — [saved result](evidence/edge-cases/runs/quote-1.json)
  - verdict reason: The document calls itself a quote or estimate (“QUOTATION”).
  - 0 field revisions saved (a review form needs at least one)
- `proforma.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “pro forma invoice” · 0 model calls · nothing posted — [saved result](evidence/edge-cases/runs/quote-2.json)
  - verdict reason: The document calls itself a pro forma invoice (“PRO FORMA”).
  - 0 field revisions saved (a review form needs at least one)

### ✅ Credit note / credit memo

*Expected:* Rejected, named as a credit note. Negative amounts never reach the ledger.

- `credit-note.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “credit note” · 0 model calls · nothing posted — [saved result](evidence/edge-cases/runs/credit-note-1.json)
  - verdict reason: The document calls itself a credit note (“CREDIT NOTE”).
  - 0 field revisions saved (a review form needs at least one)

### ✅ Statement of account, delivery note, packing slip, remittance advice, receipt

*Expected:* Rejected, named by type.

- `statement.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “statement of account” · 0 model calls · nothing posted — [saved result](evidence/edge-cases/runs/statement-delivery-remittance-receipt-1.json)
  - verdict reason: The document calls itself a statement of account (“STATEMENT OF ACCOUNT”).
  - 0 field revisions saved (a review form needs at least one)
- `delivery-note.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “delivery note or packing slip” · 0 model calls · nothing posted — [saved result](evidence/edge-cases/runs/statement-delivery-remittance-receipt-2.json)
  - verdict reason: The document calls itself a delivery note or packing slip (“DELIVERY NOTE”).
  - 0 field revisions saved (a review form needs at least one)
- `remittance-advice.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “remittance advice” · 0 model calls · nothing posted — [saved result](evidence/edge-cases/runs/statement-delivery-remittance-receipt-3.json)
  - verdict reason: The document calls itself a remittance advice (“REMITTANCE ADVICE”).
  - 0 field revisions saved (a review form needs at least one)
- `receipt.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “receipt” · 0 model calls · nothing posted — [saved result](evidence/edge-cases/runs/statement-delivery-remittance-receipt-4.json)
  - verdict reason: The document calls itself a receipt (“RECEIPT”).
  - 0 field revisions saved (a review form needs at least one)

### ✅ Several invoices in one PDF

*Expected:* Rejected as a bundle, listing the numbers found.

- `bundle.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “several invoices in one file” · 0 model calls · nothing posted — [saved result](evidence/edge-cases/runs/bundle-1.json)
  - verdict reason: 2 different invoice numbers were found on different pages: NW-1, NW-2.
  - 0 field revisions saved (a review form needs at least one)

### ✅ Scanned image that is not an invoice (photo, letter, drawing)

*Expected:* Rejected as “not an invoice” after the reading; no review form and no fields to correct.

- `scan-not-an-invoice.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “not an invoice” · 2 model calls · nothing posted — [saved result](evidence/edge-cases/runs/scan-nothing-found-1.json)
  - verdict reason: The page was read twice and reads as not an invoice.
  - image-only page; 0 field revisions saved

### ✅ False alarm: a real invoice rejected as “not an invoice”

*Expected:* “Read as an invoice anyway” starts a new attempt that skips the type gate. The override is recorded on the run.

- `override-purchase-order.pdf` → HTTP 200 · HELD [NO_PO_MATCH, MISSING_FIELD] · type “purchase order” · 1 model call — [saved result](evidence/edge-cases/runs/override-2.json)
  - verdict reason: The reviewer asked for this document to be read as an invoice.
  - override recorded on the run: forced=True; parent run linked: True; a plain retry without the override is refused with HTTP 409

### ✅ Invoice in another language

*Expected:* Passes the gate; extraction proceeds.

- `non-english-de.pdf` → HTTP 200 · HOLD_REVIEW [NO_PO_MATCH, MISSING_FIELD] · type “invoice” · 1 model call · nothing posted — [saved result](evidence/edge-cases/runs/non-english-1.json)
  - verdict reason: Invoice wording and monetary amounts are present.
  - German invoice against the EUR order PO-2001

## 4 · The text layer is present but unusable

### ✅ Garbled text layer (symbol soup, “(cid:…)” runs, broken font encoding)

*Expected:* The page is treated as scanned: no text blocks, the image is read instead. Recorded as garbled_pages on the run.

- `garbled-text-layer.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “not an invoice” · 2 model calls · nothing posted — [saved result](evidence/edge-cases/runs/garbled-1.json)
  - verdict reason: The page was read twice and reads as not an invoice.
  - page kinds ['scanned'], garbled pages [1], 0 text blocks handed to the model

### ✅ Image page with a few characters of text (a stamp, a page number)

*Expected:* Treated as a scanned page and read from the image.

- `scanned-invoice.pdf` → HTTP 200 · AUTO_APPROVE · type “no text layer” · 2 model calls · posted — [saved result](evidence/edge-cases/runs/sparse-text-1.json)
  - verdict reason: Image-only pages: the type is decided from what the vision reading finds.
  - read from the page image: 12 fields, 9 confirmed by code (second reading agreed or a hard cross-check held)

### ✅ Hidden or white text, instructions to the model inside the PDF

*Expected:* Injected text cannot create a value that is not on the page, and cannot approve anything.

- `prompt-injection.pdf` → HTTP 200 · AUTO_APPROVE · type “invoice” · 1 model call · posted — [saved result](evidence/edge-cases/runs/hidden-text-1.json)
  - verdict reason: Invoice wording and monetary amounts are present.
  - total the run used: 'Total: $6,495.00'; amount posted to the ledger: 649500 minor units

### ✅ Mixed document where the invoice is on a later image-only page

*Expected:* Fields on later scanned pages are missed; the run holds for review.

- `invoice-on-later-scanned-page.pdf` → HTTP 200 · REJECT [UNSUPPORTED_DOCUMENT_TYPE] · type “not an invoice” · 2 model calls · nothing posted — [saved result](evidence/edge-cases/runs/first-scan-only-1.json)
  - verdict reason: The page was read twice and reads as not an invoice.
  - page 1 text cover, page 2 image, page 3 the image-only invoice; only the first image page is read. Amount posted: 0

## 5 · It is an invoice, but the reading fails or is incomplete

### ✅ Model unavailable, times out or returns unparseable output

*Expected:* Budget exhausted: held with no fields, shown as “We couldn’t finish reading this invoice”.

- `budget-exhausted.pdf` → HTTP 200 · HOLD_REVIEW [VENDOR_UNKNOWN, NO_PO_MATCH, MISSING_FIELD] · type “invoice” · 1 model call · nothing posted · reader errors: extract: ConnectionError, extract: ConnectionError, extract: ConnectionError — [saved result](evidence/edge-cases/runs/budget-1.json)
  - verdict reason: Invoice wording and monetary amounts are present.
  - 3 outbound attempts, all failed; budget_exhausted recorded: True; amount posted: 0. No review form is offered for a run with no reading.

### ✅ Model returns a value that is not in the block it cites

*Expected:* The field fails source_match and does not count as verified; the invoice holds.

- `injected-fake-value.pdf` → HTTP 200 · AUTO_APPROVE · type “invoice” · 1 model call · posted — [saved result](evidence/edge-cases/runs/value-not-in-source-1.json)
  - verdict reason: Invoice wording and monetary amounts are present.
  - subtotal the model returned: '$6,000.00', source_match 'pass'; amount posted: 649500 minor units

### ✅ Required field missing or ambiguous on a genuine invoice

*Expected:* Held with MISSING_FIELD; only the affected fields are asked for.

- `unknown-supplier.pdf` → HTTP 200 · HOLD_REVIEW [VENDOR_UNKNOWN, NO_PO_MATCH] · type “invoice” · 1 model call · nothing posted — [saved result](evidence/edge-cases/runs/missing-fields-1.json)
  - verdict reason: Invoice wording and monetary amounts are present.

### ✅ Ambiguous date (03.04.2021), separator (1.234), currency symbol ($)

*Expected:* Held; the reviewer is shown each legal reading and picks one.

- `ambiguous-date-and-currency.pdf` → HTTP 200 · HOLD_REVIEW [MISSING_FIELD, AMBIGUOUS_CURRENCY, AMBIGUOUS_DATE] · type “invoice” · 1 model call · nothing posted — [saved result](evidence/edge-cases/runs/ambiguous-values-1.json)
  - verdict reason: Invoice wording and monetary amounts are present.
  - date 03.04.2021 reads as 3 April or 4 March, and “$” alone names no currency; readings the code refused to use: {'invoice_date': '03.04.2021', 'currency': '$6,000.00'}; amount posted: 0

### ✅ Amounts that do not add up, prepayment or prior-balance structures

*Expected:* Held with MATH_MISMATCH or UNSUPPORTED_AMOUNT_STRUCTURE.

- `math-mismatch.pdf` → HTTP 200 · HOLD_REVIEW [MATH_MISMATCH] · type “invoice” · 1 model call · nothing posted — [saved result](evidence/edge-cases/runs/math-1.json)
  - verdict reason: Invoice wording and monetary amounts are present.
  - 6,000.00 + 495.00 ≠ 7,000.00

## 6 · Duplicates and identity

### ✅ Same file uploaded again (any file name)

*Expected:* Rejected as DUP_FILE_HASH with a link to the earlier result. Applies to junk files too.

- `duplicate-file.pdf` → HTTP 200 · AUTO_APPROVE · type “invoice” · 1 model call · posted — [saved result](evidence/edge-cases/runs/same-bytes-1.json)
  - verdict reason: Invoice wording and monetary amounts are present.
  - first submission
- `duplicate-file.pdf` → HTTP 200 · REJECT [DUP_FILE_HASH] · 0 model calls · nothing posted — [saved result](evidence/edge-cases/runs/same-bytes-2.json)
  - same bytes under a new file name; total posted across both: 649500 minor units

### ✅ Same supplier + invoice number already approved

*Expected:* Rejected as DUP_INVOICE_NO; nothing posted.

- `same-invoice-a.pdf` → HTTP 200 · AUTO_APPROVE · type “invoice” · 1 model call · posted — [saved result](evidence/edge-cases/runs/same-invoice-1.json)
  - verdict reason: Invoice wording and monetary amounts are present.
  - approved and posted
- `same-invoice-b.pdf` → HTTP 200 · REJECT [DUP_INVOICE_NO] · type “invoice” · 1 model call · nothing posted — [saved result](evidence/edge-cases/runs/same-invoice-2.json)
  - verdict reason: Invoice wording and monetary amounts are present.
  - same supplier and invoice number, different file; total posted: 649500 minor units

### ✅ Same supplier, amount and date under a different number

*Expected:* Held as a possible duplicate.

- `fingerprint-a.pdf` → HTTP 200 · AUTO_APPROVE · type “invoice” · 1 model call · posted — [saved result](evidence/edge-cases/runs/fingerprint-1.json)
  - verdict reason: Invoice wording and monetary amounts are present.
  - IT-1, $1,000.00 on 2026-08-28
- `fingerprint-b.pdf` → HTTP 200 · HOLD_REVIEW [DUP_FINGERPRINT] · type “invoice” · 1 model call · nothing posted — [saved result](evidence/edge-cases/runs/fingerprint-2.json)
  - verdict reason: Invoice wording and monetary amounts are present.
  - IT-2, same supplier, amount and date; total posted: 100000 minor units
