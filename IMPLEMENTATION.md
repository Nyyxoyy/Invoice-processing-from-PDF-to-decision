# AP Invoice Decisioning — Implementation Record

Zamp ASA case study, PS-1 (invoice PDF → explained decision). Status as of 2026-09-10.
Runs locally at `http://localhost:8321`. 121 automated tests green. Two roles (invoice reviewer, procurement admin) with server-side enforcement. See `UX_FINDINGS.md` for the running UX audit (Steps 1–9) and verification record. Plan baseline: `PLAN.md` (v2.2, locked).

One line: **the LLM reads the document; code verifies every value, decides all money, and explains itself.**

---

## 1. What the system does

1. Accepts a vendor invoice PDF.
2. Extracts fields by having a model *point at* where each value is stated (block selection), then verifies each selection in code against the document text.
3. Reconciles the arithmetic, resolves currency, finds purchase-order references across all pages.
4. Matches the invoice to a PO and checks cumulative budget with a configurable tolerance.
5. Emits one of four decisions with reason codes and a template explanation:
   `AUTO_APPROVE` · `APPROVE_WITH_EXCEPTION` · `HOLD_REVIEW` · `REJECT`
6. Posts approved amounts to an append-only ledger atomically with the decision.
7. Lets a reviewer resolve holds: correct fields (with pick-one suggestions when a reading is ambiguous), attest scans, pick a PO, confirm a same-day match is a separate invoice, and send tracked requests to procurement for anything they cannot change (onboard or unblock a supplier, raise or amend an order). Procurement answers inline; the reviewer checks again. Approval is never an override.
8. Shows everything: live stage progress, the PDF with highlighted evidence, a plain-language checklist of what blocks approval and how to fix it, and a full audit trail.

---

## 2. Architecture

```
PDF upload ─► INGEST ─► EXTRACT ─► VALIDATE ─► MATCH ─► DECIDE ─► COMMIT
              hash,     model      code        vendor,  rules    one SQLite
              pages,    selects    verifies    PO,      →route   transaction:
              dedup     blocks     + math      budget   +codes   decision +
                                                                 posting +
                                                                 audit + status
```

**Stack:** Python 3.13 · FastAPI · SQLite (WAL, serialized mode) · pdfplumber + PyMuPDF · Gemini (`gemini-3.5-flash-lite` primary, `gemini-3.8-flash` bounded repair) · vanilla JS frontend with a restrained, responsive Invoice desk interface.

**Layout**

| Path | Lines | Role |
|---|---|---|
| `backend/app/pipeline.py` | 253 | Orchestration: document in → terminal decision out; every stage appends audit events |
| `backend/app/evidence.py` | 105 | pdfplumber text blocks with stable IDs (column-cell splitting), page classification, PyMuPDF rendering |
| `backend/app/extractor.py` | 271 | Gemini calls under a strict selection/transcription schema; code-side verification (source, role, normalization); call budget |
| `backend/app/normalize.py` | 315 | Deterministic value extraction: amounts (separator conventions), dates (unambiguous-only), PO refs (hyphenated ids), currency codes, names; `unusable_reason` / `readings` explain refusals and list legal readings |
| `backend/app/validate.py` | 145 | Field records, required-field gate, currency resolution, charge-aware reconciliation |
| `backend/app/currencies.py` | 55 | Bundled ISO 4217 registry (minor units), versioned |
| `backend/app/policy.py` | 62 | Versioned tolerance policy, per-currency floors, rounding policy |
| `backend/app/rules.py` | 236 | Budget math, decision resolver (precedence table), reason codes, template explanations |
| `backend/app/ledger.py` | 212 | Business-key identity, duplicate checks, atomic commit with posting |
| `backend/app/review.py` | 955 | Field revisions, corrections, attestation, confirm-not-duplicate, re-evaluation, reject, unified state-aware diagnosis with suggestions, master data (vendors, POs), procurement queue, tickets |
| `backend/app/db.py` | 157 | Schema, constraints, column migrations |
| `backend/app/main.py` | 578 | HTTP API, seeding, startup recovery, static hosting (no-cache), app-level auth gate |
| `backend/app/auth.py` | 100 | Roles, access codes (env), bearer verification, `require_reviewer` / `require_admin` |
| `backend/app/static/index.html` · `app.css` · `app.js` | 110 · 1603 · 2054 | Invoice desk: shell, tokenized light/dark styles, inbox, live view, review tasks with inline procurement slots, admin views |
| `backend/tests/*.py` | — | 101 tests across rules, ledger, pipeline, currency, review, auth/roles, UX recovery, normalize, extractor |

---

## 3. Extraction: the model points, code verifies

**Evidence preparation** (`evidence.py`). Every page's words are grouped into lines, then split into column cells on horizontal gaps > 24 pt. Each cell is a block with a stable ID (`p1.b37`) and coordinates, saved under an immutable extraction revision (content-hashed). Pages with < 50 chars of text are classified `scanned`.

**Model contract** (`extractor.py`). The model receives the numbered blocks and returns *selections*, never free values:

```json
{"field":"invoice_gross_total","status":"selected","source_block_id":"p1.b37","raw_value":"6,495.00"}
```

`status` is a Pydantic `Literal["selected","missing","ambiguous","unsupported"]` — enforced in the response schema after Gemini once invented `"extracted"`. Missing is a valid answer; the model is never forced to guess.

**Code-side checks per field:**

| Check | Meaning |
|---|---|
| `source_match` | raw token appears verbatim in the referenced block (catches hallucinated numbers) |
| `role_check` | a label for that field type appears in the block, the nearest cell to the left, or the cell above (catches "amount due" picked as "total", buyer picked as supplier) |
| `normalization` | the deterministic extractor can derive a typed value |

States are `pass / fail / not_evaluated / not_applicable`. There is deliberately **no numeric confidence score** — self-reported 0.93s are theater.

**Scan route.** Scanned pages are rendered (PyMuPDF, 120 dpi) and transcribed by vision. A transcription is trusted when an independent second reading of the page agrees or a hard cross-check holds (§28); otherwise through recorded reviewer attestation.

**Call budget.** Max 3 logical calls (extract ≤1, vision ≤1, repair ≤1), max 2 retries across the run, 5 outbound attempts, per-invoice token cap (100k) and wall time (120 s). Every attempt is logged with model, latency, and token counts.

**Live-verified extraction behaviour** (`fixtures/pdfs/`): three real-world third-party invoices (Bioplex, Zencorporations, plus tests on Neid/ConIncorporated/notapino layouts) were used as held-out layouts. They drove five real fixes: enum-constrained status, whole-line selections handled by code-side extraction, greedy number tokens spanning spaces, column-merged blocks, and neighbor-cell role labels.

---

## 4. Normalization rules (`normalize.py`)

- **Amounts**: currency-marked candidates preferred; percentages excluded; a single space before a three-digit group is a thousands separator (`1 436,78` → 1436.78); `1,234.56`, `1.234,56`, `2553,91`, Indian grouping `1,23,456.78` all parse; `1.234` / `1,234` alone are **ambiguous → None** (a consistent scale error also balances). Sub-precision amounts are surfaced, never rounded away (`quantize_minor`).
- **Dates**: ISO, year-first numeric, month names, and numeric day/month forms — but a numeric date parses **only when exactly one reading is legal** (`16.12.2021` → 2021-12-16 because 16 can only be a day; `05.05.2021` → same either way; `03.04.2021` → holds). Two-digit years hold.
- **Currency**: explicit ISO code or unambiguous name only; a bare `$` never establishes currency (USD/CAD/AUD share it). Document-context resolution: exactly one distinct code anywhere on the document (e.g. `Unit Price [EUR]` table headers) resolves it with block evidence.
- **PO references**: all distinct `…PO-…` tokens across every page, hyphenated ids included (`PO-SH-1`, `PO-1001-2026`); product codes like `BPXPN-00052` do not match. Multiple distinct references → `PO_MULTIPLE_REFS`.
- **Invoice numbers**: label stripped, leading zeros and punctuation preserved (`00123 ≠ 123`).
- **Refusals are explained** (`unusable_reason`): a bare `$` ("symbol, not a code — USD, CAD, AUD…"), two codes in one reading, `03.04.2021` ("3 April or 4 March — both valid"), `1.234` ("grouping or decimal"), several numbers in one reading, nothing found. **Legal readings are listed** (`readings`): both dates with the assumption each rests on, the grouping and (where the currency allows) decimal reading of an amount, the currencies behind a symbol. The reviewer picks; the code never picks for them.

---

## 5. Validation and reconciliation (`validate.py`)

- Required for approval: supplier, invoice number, invoice date, subtotal, tax, gross total, plus resolved currency and one confirmed PO. Every required field must be **affirmatively verified** — absence of failures is not sufficient.
- Reconciliation, exact `Decimal`, local bound 1 minor unit:
  - tax-exclusive: `subtotal + tax (+ shipping) = gross`
  - stated shipping must be **additional exactly once**; if gross reconciles without it → hold (ambiguous inclusion)
  - `amount_due ≠ gross` → `UNSUPPORTED_AMOUNT_STRUCTURE` (prepayments/adjustments never auto-approve; both values are extracted correctly first)
- Two independent confidences never collapse: extraction quality (per-field checks) vs match result (budget arithmetic).

---

## 6. Money, matching, policy

**Currency registry** (`currencies.py`): ~160 ISO 4217 codes with minor units (JPY 0, BHD 3 …), source and bundle version recorded in every run snapshot. All amounts stored as integer minor units + code; formatting uses the currency's exponent; amounts in different currencies are never summed.

**Policy** (`policy.py`), versioned, snapshotted per run:

```
variance: greater_of 2% / absolute floor {USD: 50.00}   (unconfigured currency → 0, percentage-only)
exception band: enabled, 5%
rounding: ROUND_HALF_UP, 1 minor unit local bound, 5 minor units document cap
```

**Budget rule** (`rules.py`), integer minor units, floors never round up:

```
B = PO base   A = approved consumption (opening imported once)   I = invoice gross
C = A + I     D = max(0, C − B)
T_primary   = max(⌊B·2%⌋, floor[currency])
T_exception = max(T_primary, ⌊B·5%⌋)
D ≤ T_primary → AUTO_APPROVE · T_primary < D ≤ T_exception (band enabled, only variance failing) → EXCEPTION · else HOLD
```

Tolerance applies to **cumulative overage**, never invoice-vs-PO closeness — a $12k invoice on a $30k PO is partial billing, not a 60% variance. The allowance is shared across splits, never renewed per invoice. Documented consequence: PO ≤ $1,000 collapses both limits to $50.

**Verified scenarios**: $10,450 on $10k → exception; $10,600 → hold; same held invoice under a 7% band → exception, one posting; $12k/$12k/$8k on $30k → approve, approve, hold (`PO_BUDGET_EXCEEDED`, D=$2,000 > $1,500).

---

## 7. Identity, duplicates, ledger (`ledger.py`, `db.py`)

| Entity | Purpose |
|---|---|
| `document_id` | bytes + SHA-256 + filename |
| `invoice_id` | logical invoice; **business key** `workspace + buyer + supplier + canonical invoice_no`, DB-unique |
| `extraction_revision_id` | immutable evidence; block IDs bind to it |
| `run_id` | one attempt (intake or review), policy snapshot, consumed-A snapshot |
| `ledger_event_id` | one posting/reversal; partial unique index = one active posting per invoice |

**Duplicates**: L1 identical bytes → link to original, reject the submission; L2 business key already posted → reject; same key, different total → `CONTENT_CONFLICT` hold, both versions preserved; L3 same supplier + currency + amount + **same date**, different number → hold (the ±30-day window waits for line-item hashes).

**Commit** is one `BEGIN IMMEDIATE` transaction: resolve-or-create invoice on the business key, recheck duplicates, re-read fresh consumption, run the resolver, insert the posting, write decision + terminal `run_status` + audit events. A crash after posting can never leave a run mislabeled.

**Concurrency proven by tests**: two different $7k invoices racing on a $10k PO → exactly one posts; same invoice submitted twice concurrently → one `invoice_id`, one posting. Startup marks stale `running` jobs `failed/interrupted` (this recovered a real crash during development).

**Delete**: `DELETE /api/runs/{id}` removes a non-posting run and its audit rows, orphaned document (freeing the hash for re-upload) and orphaned invoice. Runs that posted money are refused with an explanation.

---

## 8. Decision resolver (`rules.py`)

Precedence: identical document → business-key duplicate → blocked vendor (only if reliably resolved) → every HOLD gate (unknown vendor, PO problems, unverified fields, math, scan, currency, date, unsupported structure, fingerprint) → budget. Missing prerequisites are `not_evaluated`, never a silent pass. The exception band can waive exactly one thing: the variance rule.

Status is three separate fields — `run_status` (queued/running/completed/failed), `disposition` (approved/held/rejected), `decision_mode` (automatic/automatic_exception/reviewer) — so a crashed parser is not a rejection and a reviewer approval is not an auto-approval.

**Explanations are templates**, never LLM prose, and always show the arithmetic:

> Held for review. This invoice would bring approved billing to USD 32,000.00 against a USD 30,000.00 PO. The USD 2,000.00 overage exceeds the USD 1,500.00 exception limit. No amount was added to the approved ledger. Next: verify the invoice or amend the PO.

---

## 9. Reviewer workflow (`review.py`)

- **Field revisions** are immutable: extraction = revision 1; every correction/attestation appends. Stale views are rejected with 409 (`expected_seq`).
- **Correct** a field → normalization re-checked, `review_status: corrected`.
- **Attest** scan-read fields → the way vision evidence becomes trusted. A reading with no legal interpretation cannot be attested (422 with the reason); a **corrected** scan value counts as verified everywhere (gate, diagnosis, UI) — typing it is stronger evidence than ticking a box.
- **Select PO** from deterministic candidates (same vendor, currency, open).
- **Confirm not a duplicate**: for the same-supplier/amount/day fingerprint only, a reviewer may record (reason required, audited) that this is a separate invoice; re-evaluation then skips that one gate and logs `fingerprint_overridden`. Exact duplicates (same file, same invoice number) stay final.
- **Approve = full re-evaluation** as a *new* review run (`decision_mode: reviewer`, `parent_run_id` links back; original stays). Fresh duplicate and budget checks run at commit; the PO is resolved exactly as on first reading (`extract_po_refs` on the field, an exact known order id verbatim, else the single document-wide reference). Tests prove a reviewer cannot approve a duplicate or a budget overage.
- **Reject** with reason, recorded as a review run.
- **Idempotency keys** on approve/reject: replay returns the prior result, no second posting.

**Unified diagnosis** (`diagnose_run`) is the single source of truth for the UI. From the run's decision codes it produces the checklist items (plain-language label, action, jump target, affected fields) *and* the per-field problems (why, accepted format, suggestion — including a `difflib` nearest-vendor suggestion). It is **state-aware**: each code is re-checked against current corrections and master data and marked resolved before re-evaluation, so the checklist shows "n of m resolved". Every field problem carries `unusable` (why the current reading cannot be used) and `suggestions: [{value, reason}]` — facts first (a code stated elsewhere on the document, the referenced order's currency, the supplier's open orders when they share one), then the legal readings of the raw value.

**Master-data actions** (procurement admin only, audited as `MASTER` events on the run): onboard, rename (alias kept), block/unblock, delete suppliers (refused while referenced); create, amend (never below approved billing), close/reopen, delete purchase orders (refused once billed). Reviewers reach these through **requests** (section 17–18).

**Live-proven on real PDFs**
- `invoice-1-3` (Zencorporations, EUR): held → PO-2001 selected → date confirmed → **EUR 2,809.30 posted** as reviewer decision.
- `invoice-0-4` (Bioplex): held on unknown vendor + 3 PO refs + no currency → **Onboard Bioplex** → currency EUR → **Create PO BPXPO-00536** (prefilled from the document) → approve → **EUR 6,610.95 posted**, shipping reconciled (`5964.50 + 596.45 + 50.00 = 6610.95`).

---

## 10. HTTP API (`main.py`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/invoices` | upload PDF, run pipeline synchronously |
| GET | `/api/runs` · `/api/runs/{id}` | invoice summaries and review lineage / detail with events + snapshot |
| POST | `/api/runs/{id}/retry` | retry failed/interrupted reading as a child attempt, preserving document and history |
| DELETE | `/api/runs/{id}` | delete non-posting run |
| GET | `/api/runs/{id}/review` | fields (with `problem`, `attestable`), PO candidates, diagnosis, revision seq |
| POST | `/api/runs/{id}/review/{correct,attest,confirm-distinct,approve,reject}` | reviewer actions (`confirm-distinct` = reasoned attestation that a same-day match is a separate invoice) |
| GET | `/api/runs/{id}/document` · `/page/{n}` | page geometry + evidence blocks; rendered PNG |
| GET/POST/PATCH/DELETE | `/api/vendors` · `/api/vendors/{id}` · `/api/pos` · `/api/pos/{id}` | master data read (any role) / onboard, edit, block, delete, create, amend, close (admin) |
| GET/POST | `/api/auth/config` · `/api/auth/login` · `/api/auth/me` | sign-in: role config (dev codes only in dev mode), code → role, current user |
| GET | `/api/queue/procurement` | held invoices needing a procurement action (admin) |
| GET/POST | `/api/tickets` · `/api/tickets/{id}/resolve` · `/api/tickets/kinds` | reviewer requests to procurement: raise (reviewer), list by `status` / `run_id` / `document_id` (both), resolve/decline with note (admin) |
| GET | `/api/audit` | cross-run event feed |
| GET/POST | `/api/samples` · `/api/samples/{name}/run` | fixture list / run a sample |
| POST | `/api/admin/reset` | wipe and reseed the demo workspace |
| GET | `/api/health` | includes `interrupted_on_boot` |

Single bounded worker (one pipeline at a time) via a process lock; SQLite in serialized thread mode so live polling can read while the worker writes. Upload limits: 10 MB, 10 pages, must start with `%PDF`; corrupt or encrypted files → `failed` run, not a 500.

---

## 11. Frontend — Invoice desk (2026-09-10 simplification)

The UI now follows the user's job: **upload → understand the result → resolve only what needs attention**. Implementation explanations no longer lead the default experience.

- **Inbox:** supplier/invoice number, amount, status and next action. Status filters and search. Superseded review attempts are collapsed into the current result; full history remains accessible. Upload is primary; sample PDFs are behind a disclosure. PO budgets and supplier management have separate pages.
- **Processing:** three event-backed steps — Read the invoice, Check the details, Save the result. Background processing survives navigation. Timeouts/errors remain visible with an inbox recovery route. Technical events are retained in result details.
- **Review:** outcome and invoice summary first; relevant correction tasks beside a clean, paginated document. Only problem fields appear initially. Other fields are expandable. Human field labels, accepted-format hints, suggestion buttons, on-demand evidence highlights, explicit save/confirm actions.
- **Supplier/PO recovery:** the reviewer selects a matching supplier/currency order; anything needing master data is a request to procurement sent from inside the task (section 18). Procurement onboards suppliers and raises or amends orders in the app. Ledger reversals and payments remain out of scope and the UI says so.
- **Scans:** unconfirmed scan fields are grouped for comparison with the original. Save & confirm records the check (attestation when unchanged, correction when edited); readings with no usable interpretation show the reason and pick-one suggestions instead. No automatic trust or hidden override.
- **Finish:** “Check again” reruns the existing approval rules and shows the updated result. Reject requires a recorded reason and now carries the invoice's field revision into the rejection result.
- **Failures:** guarded retry creates a child attempt using the existing PDF; failed history is kept, successful invoices cannot enter this path, repeated retries cannot reuse the same parent. Unreadable PDFs explain replacement/export steps.
- **Form recovery:** invalid normalized corrections receive 422 with a format hint before creating a revision; input stays visible. Stale views offer reload. Existing unsaved corrections are retained when another field is saved. Navigation warns before discarding edited fields. Repeated actions are locked and approval/rejection use stable idempotency keys within the page session.
- **Progressive disclosure:** decision explanations, prior attempts, user-readable activity and full technical evidence remain under “Decision details & activity”. Reset is in Help & demo settings with confirmation. Routine invoice deletion is absent from the UI; the protected API remains available.
- **Responsive/accessibility:** native links, labels, forms, focus styles, skip link, error/status announcements and reduced-motion support. Mobile inbox rows keep status and next steps visible. Mobile document preview expands on demand so review actions are not buried.

Files: `backend/app/static/index.html`, `app.css`, `app.js`. Backups: `backups/index.before-ux.html`, `backups/*.before-theme.*`. No package/build dependency was introduced.

Browser verification used `tools/ux_qa_server.py` on port 8322, an isolated temporary database and deterministic extraction fixtures (no model calls). Verified date correction→approval, supplier→new PO→approval, interrupted reading→retry result, scan confirmation→approval, invalid field recovery, rejection, search, and desktop/mobile layouts. Real existing invoice data was also inspected read-only on port 8321.

## 12. Tests (121)

| File | Covers |
|---|---|
| `test_rules.py` | headline arithmetic, ±1¢ boundaries, exception switch off, de minimis collapse, allowance shared across splits, exception cannot waive other gates, missing prerequisite never passes |
| `test_ledger.py` | happy path, duplicate after approval, content conflict, **two concurrency races**, opening balance counted once, leading zeros, pending never consumes |
| `test_pipeline.py` | end-to-end with a deterministic extractor stub: clean approval, L1 duplicate, prepayment trap, math mismatch, unknown/blocked vendor, closed PO, split trio, L3 same-day fingerprint, explicit shipping, ambiguous shipping, multiple PO refs, startup recovery |
| `test_currency_money.py` | registry, quantization and precision errors, separator conventions, per-currency floors, EUR end to end, currency mismatch, missing currency never posts |
| `test_review.py` (23) | correct→approve posts once + idempotent replay, stale revision 409, no bypass of duplicate or budget, attestation clears scan gate, reject, only held runs reviewable, delete guards, diagnosis covers every code and flags business fields, vendor suggestion, onboarding + PO creation unblocks, diagnosis progress, supplier rename/block/delete guards, PO amend/close guards, procurement queue filtering, ticket lifecycle + blocked-supplier re-check, tickets follow Check again runs, fingerprint cleared with a reason (exact duplicates not clearable), Check again resolves the PO like the first reading, unusable readings explained/never attested/with legal readings, corrected scan values need no attestation |
| `test_auth_roles.py` (6) | 401 without a code, 403 matrix per role (approve is reviewer-only; master data and reset admin-only), env codes honoured and never leaked, page-image query-code route only |
| `test_ux_recovery.py` | retry preserves history/posts once, failed retry remains recorded, summaries use latest revision with stable ordering/parent links, invalid correction retains saved values, rejection retains invoice details |
| `test_normalize.py` · `test_extractor_offline.py` | extractors, deterministic dates, call-budget accounting, grounded-but-wrong role failure, hallucinated value, scan never `pass`, neighbor-cell labels |

Deterministic tests never call the model; live behaviour is verified separately through the running server on the fixture PDFs.

---

## 13. Deliberate scope limits (talking points)

- Line-level price/quantity matching: needs PO line data (roadmap). Current control is cumulative gross budget.
- No FX: cross-currency invoice/PO holds.
- No reservations for held invoices in v1; approvals serialize at commit against fresh balance.
- Repair call (`gemini-3.8-flash`) is wired and budgeted but not yet triggered by the pipeline's routing.
- Numeric dates with two legal readings hold until a vendor format profile exists.
- Onboarding, PO creation and amendment are procurement actions with their own approvals in production; here they are restricted to the procurement admin role and audited.
- Duplicate handling: only the same-day fingerprint heuristic can be cleared, by a reviewer with a recorded reason. Exact duplicates and content conflicts are final; a posted entry is never reversed in the app.
- Self-hosted OCR (MinerU / PaddleOCR) deferred; scans use vision with an independent second reading and cross-checks (§28); what neither confirms is attested by the reviewer.
- SSE deferred; live view uses short polling of persisted events.

## 14. Not yet done

- Reviewer roster: admin invites reviewers by email → per-user accounts under the admin (designed, deferred; today one access code per role).
- Scan-path live test with a real scanned fixture (code path exists, unit-tested with stubbed vision; a user-supplied scan was reviewed live on 2026-09-10).
- Remaining demo fixture PDFs (split trio, overage, injection, scan) as files — the scenarios are covered by tests, not yet by uploadable PDFs.
- Hosted deployment: artifacts ready (§31), not yet pushed; the 5-minute demo video.

## 15. Theme, supplier management, re-check state (2026-09-10)

- **Dark theme**: every colour in `app.css` is a semantic token; `[data-theme="dark"]` overrides them. Toggle in the top bar, persisted in `localStorage`, follows the OS preference by default, applied before first paint.
- **Supplier management**: `PATCH /api/vendors/{id}` (rename keeps the old name as an alias; approved ↔ blocked) and `DELETE /api/vendors/{id}` (refused with an explanation when purchase orders or invoices reference the supplier). Cards on the Suppliers page expose Edit / Block / Delete with confirmations.
- **Red re-check state**: after Check again, a still-held review result compares its open blockers with the previous result; blockers that survived render red with a "still unresolved" count, so the reviewer sees exactly what remains.

## 16. Roles and access control (2026-09-10)

Two roles, enforced on the server for every request, with actor names derived from the role:

| | Invoice reviewer | Procurement admin |
|---|---|---|
| Upload, retry, run samples | yes | no |
| Correct, attest, approve, reject | yes | **no** |
| Read invoices, audit, suppliers, POs | yes | yes |
| Onboard / edit / block / delete suppliers | no | yes |
| Create / amend / close / delete purchase orders | no | yes |
| Procurement queue, reset workspace | no | yes |

The split is segregation of duties: the role that creates budget (supplier + PO) never releases money against it. Access codes come from `ADMIN_ACCESS_CODE` and `REVIEWER_ACCESS_CODE`; unset they fall back to `admin-demo` / `reviewer-demo` and the API reports `dev_mode`. Codes are compared in constant time and never returned once set. The bearer-code scheme is the swap point for SSO/OIDC.

**Deployment checklist:** set both access codes, `GEMINI_API_KEY`, and `DATA_DIR` on a persistent volume; serve over HTTPS (the token travels in the Authorization header); the frontend stores the code in `localStorage` for the demo — move it to an httpOnly session cookie when a real identity provider replaces the codes.

## 17. Requests to procurement (2026-09-10)

> Superseded in part by §24: requests now close themselves; admins no longer "resolve" them by hand (they can only decline, or reply to an `other` request).

Reviewers cannot change master data, so anything they cannot fix becomes a **tracked request**: approve a blocked supplier again, onboard a supplier, raise a purchase order, amend a budget, or other. One open request per invoice and kind; opening and resolving are recorded on the invoice's audit trail (`REQUEST` events). Admins see requests first in the procurement queue, grouped by requester, and resolve or decline them with a note the reviewer sees on the invoice. A rejection caused solely by a blocked supplier becomes reviewable again once the supplier is approved, so the reviewer can re-check and approve without re-uploading. Page images pass the access code as a query parameter on that one route because `<img>` cannot send headers.

## 18. Inline procurement slots and the last reviewer dead-ends (2026-09-10)

> The admin mirror described below (`adminSlotHTML`, `adminInlineKinds`, `adminRequestsHTML`, "Mark done / Decline") was replaced by the steps-plus-decline layout in §24. The reviewer-side slots are current.

- **Slot pattern** (`app.js`: `KIND_FOR_CODE`, `SLOT_COPY`, `latestTicket`, `ticketForm`, `slotHTML`, `askHTML`, `ticketNoticesHTML`): one blocker code maps to one request kind; the request's whole lifecycle (send → waiting → done/declined → send again) renders inside the task that shows the blocker. Reviewer's standalone request panel removed; footer keeps a collapsed "other" request. `blockedHTML` gives rejected-blocked invoices the same slot plus Check again.
- **Admin mirror** (`adminSlotHTML`, `adminInlineKinds`, `adminRequestsHTML`): the reviewer's open request with Mark done / Decline appears inline in the procurement task that answers it; the separate card shows only history, requests without a task, and the blocked-supplier action.
- **Tickets follow the invoice**: `GET /api/tickets?document_id=` (`list_tickets(document_id=…)` adds `document_id`), so a request opened before Check again is still visible on the review run.
- **Confirm not a duplicate**: `POST /api/runs/{id}/review/confirm-distinct` (`confirm_not_duplicate`) records a reviewer attestation (reason required, `duplicate_confirmed_distinct` event); `reevaluate` passes `fingerprint_cleared_by` to `commit_decision`, which skips only the same-supplier/amount/day fingerprint gate and emits `fingerprint_overridden`. Exact duplicates (same file, same invoice number) are unaffected.
- **Check again PO resolution**: `reevaluate` now uses `extract_po_refs` like the pipeline (label-prefixed raw values resolve), accepts an exact known order id verbatim, and falls back to the single document-wide reference when the field is untouched. `_PO_REF` accepts hyphenated ids (`PO-SH-1`, `PO-1001-2026`).
- Tests (`test_reviewer_can_clear_a_same_day_fingerprint_with_a_reason`, `test_tickets_follow_the_invoice_across_check_again_runs`, `test_check_again_resolves_the_po_like_the_first_reading`).

## 19. Unusable readings: reasons, legal readings, no dead-end attest (2026-09-10)

- `normalize.unusable_reason(field, raw)` — why a value has no single legal reading (bare symbol, two codes, ambiguous day/month, ambiguous separator, several numbers, nothing found). `normalize.readings(field, raw, currency)` — the legal readings with the assumption each rests on (both dates; grouping/decimal amount; symbol → codes).
- `diagnose_run` attaches `unusable` and `suggestions: [{value, reason}]` to every field problem; currency suggestions also come from the document context code, the referenced order and the supplier's open orders (single currency only). `suggestion` stays as the first value.
- Review response marks each field `attestable` (scan reading with a legal interpretation). `attest_fields` refuses unusable readings with the reason; `correct_field` errors carry the reason plus the expected format. `field_diagnosis` uses the reason as `why`.
- UI (`editor`, `problemCopy`): reason first, pick-one "Use …" buttons with their reason, attest checkbox only when attestable, otherwise a note to pick or type then Save & confirm.
- Corrected scan values count as verified: `assess` scan gate, `diagnose_run` (REVIEW_REQUIRED_SCAN item and `still_open`) and the editor treat `review_status in (attested, corrected)` alike, so a typed value is never asked to be attested again. 
- Tests: 101 (`test_unusable_readings_are_explained_never_attested_and_offer_legal_readings`, `test_corrected_scan_value_needs_no_separate_attestation`).

## 20. Request outcome must match the record (2026-09-10)

> The reply form (`replyFormHTML`, "Send reply & complete") no longer exists — see §24. The fulfilment derivation (`ticket_fulfilled`) and the refused contradicting decline remain.

Bug: admin onboarded a supplier, then clicked Decline with the note "approved" — the request read "Declined" while the supplier was approved. The outcome was free text with no link to the facts.

- `review.ticket_fulfilled(conn, ticket)` derives, from current master data, whether the request is already satisfied and states the fact: onboard → supplier resolves and is approved; unblock → no longer blocked; raise PO → the PO codes no longer open, or an open order in the invoice currency exists for the reviewer to select; amend → the referenced order now has room for the invoice total (ledger consumption included). `other` is never derived.
- `resolve_ticket` refuses a decline of a fulfilled request (409 with the fact and how to undo the master-data change first). Completing records `fulfilled` and `fact` on the `REQUEST` event.
- `list_tickets` returns `fulfilled` / `fact` for open requests. UI: the reply form (`replyFormHTML`, shared by the invoice task and history views) shows "✓ fact" and offers only "Send reply & complete" when fulfilled; otherwise both buttons with explicit labels ("Decline — nothing will change"). The Requests page marks fulfilled to-dos.
- The one contradictory demo record (MY COMPANY, "approved") was corrected to resolved with a `ticket_corrected` audit event.
- Tests: 103 (`test_a_fulfilled_request_cannot_be_declined`).

## 21. Onboard = supplier + purchase order (2026-09-10)

> The "single reply form … Send reply & complete" described below is gone (§24): both steps done closes the request automatically.

A new supplier has no orders, so onboarding alone left the reviewer needing a second request. The `onboard_supplier` request now means "onboard a new supplier and raise its purchase order":

- `ticket_fulfilled`: onboard is fulfilled only when the supplier is approved **and** an order the reviewer can select exists (or the PO checks already clear); until then it reports progress ("X is approved. Add its purchase order to finish the request."). `raise_po` shares the same order check.
- `resolve_ticket`: completing any derivable request (all kinds except `other`) requires the record to show it done — otherwise 409 with the missing step; declining a fulfilled one stays refused. Decline is the only exit for a request the admin will not fulfil.
- Admin UI: an open onboard request always shows the purchase-order step; step 1 says "approved — now add its purchase order in the next step"; the single reply form sits under step 2 and offers only Decline until the order exists, then only Send reply & complete. Reviewer copy: "one request covers both".
- Tests: 104 (`test_onboard_request_is_done_only_with_a_purchase_order`; fulfilment test updated).

## 22. Save & confirm is the only scan action (2026-09-10)

The attest checkboxes and the "Confirm checked values" button are gone. On a scan-read field, **Save & confirm** does both: an unchanged value is recorded as an attestation (`review/attest`), a changed value as a correction (`review/correct`) — either counts as verified. Unusable readings still cannot be confirmed as they stand (reason + pick-one suggestions, section 19). Backend unchanged.

## 23. What procurement owes is derived once (2026-09-10)

Admin opened a held invoice whose request was closed and still saw "Help the reviewer continue · Provide the purchase order". The invoice was held for the reviewer's items; procurement owed nothing.

- `review.procurement_asks(conn, fields, context, diag)` is the single derivation of what procurement still owes: open procurement codes minus those current master data already satisfies (supplier approved; an order the reviewer can select in the invoice currency; an amended order with room). Used by the queue, returned as `procurement_needs` in the review view, and mirrored in the admin inbox.
- Admin detail: tasks = `procurement_needs` ∪ open requests. When both are empty the card reads "Procurement is up to date" and lists what is still with the reviewer; the outcome header says "Waiting on the reviewer".
- Admin inbox: "On hold" split into **Needs procurement** (detected need or open request) and **With reviewer**; the row action says Resolve or With reviewer accordingly.
- Tests: 105 (`test_procurement_owes_nothing_once_supplier_and_selectable_order_exist`).

## 24. Requests close themselves; stale tabs reload (2026-09-10)

- **No "mark done".** `review.settle_requests(conn, actor)` closes every open request the record now fulfils (derived by `ticket_fulfilled`), with a resolution note = the fact + the reviewer's next step, and a `ticket_resolved` event flagged `auto`. It runs after every master-data change (`POST/PATCH /api/vendors`, `POST/PATCH /api/pos`, whose responses now carry `settled`), after a reviewer correction, and once at startup for requests fulfilled while the server was down. `other` requests are never auto-closed.
- **Admin invoice page** (`procurementHTML`): the steps (approve supplier → provide the order, or amend / unblock) and, underneath, a single footer that can only **Decline** the open request with a reason (`requestFooterHTML`). The reply form and "Send reply & complete" are gone; an `other` request keeps "Reply & close". Completing both steps re-renders into "Procurement is up to date".
- **Stale tab guard.** Every response carries `X-App-Version` (newest mtime of the static files; also in `/api/health`). `api()` remembers the first value; when it changes the page reloads itself if nothing is unsaved and no live run is in progress, otherwise it shows a notice to reload. Cause: hash routing never reloads the page, so a tab left open for hours kept running old JavaScript against the new server — the origin of the "Requests from the reviewer" card still being visible.
- Tests: 106 (`test_requests_close_themselves_when_the_record_is_complete`).

### 24a. Hardening after adversarial review (2026-09-10)

A three-lens review (backend, frontend, tests/docs) with refutation agents confirmed five defects; all fixed and pinned by tests:

- **Requests follow the invoice.** `ticket_fulfilled` now evaluates against the newest run of the invoice lineage (`latest_run_in_lineage`), so a reviewer correction on a Check-again run settles a request opened on the original run.
- **"None of these orders is right" is answered only by a new order.** A request records the orders that already existed for the supplier (`tickets.known_pos`); a `raise_po` request is fulfilled by a selectable order not in that list, or by the reviewer selecting one. Onboard requests accept any selectable order (a new supplier had none). No clocks involved.
- **Nothing to request.** `open_ticket` refuses a request the record already satisfies (409 with the fact) instead of creating a ticket that can neither be completed nor declined.
- **Unblock requests are about one supplier.** `tickets.supplier_id` pins it at creation; changing the invoice's supplier name to another approved vendor closes the request with "The invoice now names …" rather than pretending the blocked one was approved.
- **Final invoices close leftovers.** Reviewer rejection or approval (reviewer or automatic on Check again) closes open requests on that invoice as declined with an explanatory note; a blocked-supplier rejection keeps its unblock request. `resolve_ticket` lets an admin close anything left on a final invoice; the admin page offers "Close request" there.
- **Settlement runs under the worker lock** (`_settle` in `main.py`), so it can never open a transaction while the pipeline holds one.
- Tests: 112 (`test_requests_follow_the_reviewer_to_check_again_runs_and_close_there`, `test_startup_settles_requests_fulfilled_while_the_server_was_down`, `test_reviewer_correction_settles_a_request_through_the_api`, `test_a_request_the_record_already_satisfies_is_refused`, `test_final_decisions_close_leftover_requests_but_not_the_blocked_one`, `test_master_data_endpoints_settle_requests_and_stamp_the_frontend_version`).

## 25. Unknown name, existing supplier (2026-09-10)

An invoice often prints a subsidiary, brand or trading name of an approved supplier ("White Group" for Northwind). Two ways in, one per role:

- **Reviewer, per invoice** (`mapSupplierHTML`, form `map-supplier`): in "Confirm the supplier", pick the approved supplier the invoice belongs to and, in the same step, one of its open orders in the invoice currency (`mapPoOptions`, refreshed on supplier change). Recorded as corrections of `supplier_name` (evidence keeps `corrected_from`) and `po_reference`; the second correction uses the revision returned by the first. The invoice then posts under the parent supplier's identity.
- **Procurement, permanently** (`update_vendor(add_aliases=…)` / `aliases=…`, `PATCH /api/vendors/{id}`): register the printed name as another name of the supplier; `resolve_vendor` already matches aliases, so the next such invoice resolves on its own, and an open onboard request settles through it. An alias can never belong to two suppliers (409). Admin invoice page offers "Existing supplier under another name?" under the onboard step (`aliasFormHTML`); the Suppliers page shows "Also known as" and edits the list. `GET /api/vendors` returns `aliases`; a `vendor_alias_added` MASTER event is written when a run is given.
- Tests: `test_unknown_name_mapped_to_an_existing_supplier_by_reviewer_or_by_alias`, `test_aliases_are_admin_master_data`.

## 26. Space-grouped thousands (2026-09-10)

`1 436,78` (plain, no-break or narrow no-break space before a group of exactly three digits, as in French, German, Swiss and ISO 31-0 formatting) was read as `436.78`: the leading group was taken for a separate number. `normalize._join_space_groups` removes such a space before tokenising in `extract_amount`, `unusable_reason` and `readings`; `1 4360,78` (four digits) is not joined; several distinct numbers still hold. Test `test_space_grouped_thousands_are_one_number`.

## 27. Budget forecast at selection time (2026-09-10)

Choosing an order with too little budget used to surface only after Check again. The review view now carries the budget rule's forecast (`budget_forecast`, same arithmetic as `commit_decision`: cumulative overage against the primary and exception tolerances):
- every PO candidate has `remaining_minor`, `status` (`ok` / `exception` / `exceeded` / `null` when the total or currency is unusable) and `short_minor`; the picker labels exceeded orders and warns when none fits;
- `budget` describes the order the invoice references now; when it is `exceeded` the reviewer sees "The order cannot take this invoice" with the numbers, the amend-budget request slot and "Reject this invoice instead" (opens the rejection form) — before Check again. Test `test_budget_forecast_matches_the_rule_before_check_again`.

## 28. Scan self-check — deviation from plan v2.2 noted (2026-09-11)

Plan v2.2 said scan readings verify only through reviewer attestation. On real scans that meant confirming every field, including ones plainly legible. Nikunj asked for fields the system is sure about to pass without the reviewer. Kept the principle (no model-reported confidence decides anything); replaced "always attest" with two code-checkable confirmations:

- **Independent second reading** (`extractor.transcribe_page`, one extra logical call `verify`; budget now 4 logical / 6 outbound): the whole page is transcribed separately; `agrees_with_page` compares each field value against it — verbatim for text, as normalised values for amounts and dates (so "1 436,78" and "1436,78" agree). Agreement sets `checks.independent_read = agree` and `source_match = pass`; otherwise `disagree`, and the field waits for the reviewer.
- **Hard cross-checks** (`pipeline.scan_cross_checks`): amounts that reconcile exactly confirm each other (`cross_check = arithmetic`); a supplier name that resolves in the vendor master (`vendor_master`); a PO reference that exists for that supplier (`po_master`). Recorded per field and in a `scan_self_check` audit event listing what was confirmed, how, and what is still for the reviewer.
- `FieldRecord.self_verified()` = normalises and (independent reading agrees or cross-check holds). It feeds `affirmatively_verified`, the scan gate, `field_diagnosis`, the REVIEW_REQUIRED_SCAN item and the UI (`selfVerified`, "✓ n scanned values confirmed automatically" disclosure with the reason per field; such fields leave the confirm list but stay editable).
- Scans can now approve on first pass when everything is confirmed; the PO reference of a scan is taken from the confirmed vision reading (a scanned page has no text blocks). If the second reading is unavailable (budget), cross-checks still apply and the rest waits for the reviewer.
- Tests: `test_scan_reading_is_confirmed_only_when_an_independent_reading_agrees`, `test_scan_fields_confirmed_by_code_need_no_attestation` (approve / partial / no second reading).

## 29. Grouped records with deep links (2026-09-11)

- `review.invoices_by_po(conn)`: every invoice under each purchase order — posted ones from the ledger (authoritative), plus current held/rejected runs whose latest reading references the order (superseded runs excluded). `GET /api/pos` returns it as `invoices` per order.
- Purchase orders page: each row has "Invoices (n)" with links to the invoice, and the supplier name links to its card. Suppliers page: each card has "Purchase orders (n)" with links to the order rows and "Invoices (n) →" into the inbox filtered by the supplier name.
- Routes `#pos/<po_id>`, `#vendors/<supplier_id>` (open the page, scroll to and flash the record) and `#invoices/<search>` (inbox with the search prefilled). Test `test_invoices_are_grouped_under_their_purchase_order`.

## 30. Generic modal and clean display values (2026-09-11)

- `openModal({title, subtitle, body, filter})` / `closeModal()` on one `<dialog id="app-modal">` (index.html): header with ✕, scrolling body, optional filter box for long lists; closes on Esc, backdrop click, or when a link inside navigates. `recordListHTML` renders uniform record rows (main / meta / badge). Grouped records use it: "Invoices (n)" on an order and "Purchase orders (n)" on a supplier open the list in the modal instead of inline, so any count fits.
- `normalize.display_values(raw, currency_code)` derives label-free display values with the same extractors that drive decisions ("Currency: USD Total: $4,968.00" → "USD 4,968.00"; "$ 544,46" → "544.46" with "currency not confirmed"). `GET /api/runs` returns it as `display`, the review view as `display`; inbox rows, invoice headers and modal rows use it, so one amount format everywhere.

## 31. Deployment (2026-09-11)

Artifacts: `Dockerfile` (python:3.13-slim, uvicorn, `DATA_DIR=/data` volume, health check on `/api/health`), `.dockerignore`, `render.yaml` (Render web service with a 1 GB persistent disk mounted at `/data`). SQLite and uploaded PDFs live on the disk; the container is otherwise stateless.

Required environment: `GEMINI_API_KEY`, `ADMIN_ACCESS_CODE`, `REVIEWER_ACCESS_CODE` (the app refuses to fall back to demo codes only implicitly — set both), `DATA_DIR=/data`. `PORT` is supplied by the platform.

Steps: `git init` + push to a private GitHub repo → Render "New Blueprint" from the repo → set the three secrets → deploy → sign in with the codes. Railway or Fly.io work the same way with a volume at `/data`. First boot seeds the demo suppliers and orders; nothing from the local `data/` directory is shipped.

## 32. Standalone requests (2026-09-11)

Reviewers can raise a request without an invoice: **New request** on My requests (replaces Refresh for that role) opens the modal with two kinds — onboard a named supplier, or raise a purchase order for an existing supplier — plus a note. `POST /api/requests` (`open_standalone_request`); `tickets.run_id` is now nullable (older databases are rebuilt in place by `_relax_ticket_run`) and `tickets.subject` holds the supplier name. Duplicates return the existing request; a request the record already satisfies is refused. Fulfilment is derived like invoice requests (`_standalone_fulfilled`: approved supplier by name or alias; a new order for the pinned supplier), so it closes itself through `settle_requests` with "Done by procurement". Admin resolves from the Requests page in the modal (onboard form / register alias / create order / decline); rows show "Raised from My requests" and link to the supplier. Test `test_standalone_requests_close_themselves_like_invoice_ones`. 121 tests.
- Every standalone request names the order the supplier needs (`amount_minor`, `currency`, required). Onboard requests are fulfilled only when the supplier is approved **and** an open order in that currency of at least that amount exists; order requests only by a new order that covers the amount (a smaller one leaves the request open with "does not cover it"). The admin modal walks onboard requests in two steps — approve the supplier, then the prefilled order form — and reopens on step 2 after step 1.

## 33. Bulk intake, sample library, open access (2026-09-11)

**Several PDFs or a ZIP at once.** `POST /api/invoices/batch` takes any number of `files` parts (PDFs and/or ZIP archives). `intake.expand_uploads` validates and expands synchronously — PDF signature, 10 MB per document, 60 MB per archive, 25 documents per batch, 120 MB per request — and reports every part that could not be used as a *skipped* item with a reason (not a PDF, empty, too large, encrypted ZIP entry, nested archive, over the batch cap) so one bad file never blocks the rest. ZIP expansion checks the declared uncompressed size before reading an entry (a zip bomb is skipped without inflating), ignores `__MACOSX/` and dotfiles, and reads with a hard byte ceiling. `BatchRegistry` then processes the accepted documents in a background thread, one at a time under the same worker lock as every other pipeline call, each through `process_document` (so identity, duplicate and ledger rules are identical to a single upload and each document is an ordinary run in the inbox). The request returns the batch record; the UI polls `GET /api/batches/{id}` and shows a per-file progress list with links into each result. Batch state is in memory: after a restart the runs are in the database, the in-flight one is marked interrupted by startup recovery, and the batch page says the batch is no longer tracked. Frontend: the file picker is `multiple` and accepts `.zip`; the drop zone takes many files; one PDF keeps the single live card, anything else opens the batch view (`#batch/{id}`). Tests: `test_intake_batch.py`.

**Connectors: no more manual upload required.** `connectors.py` adds three intake routes that need no cloud account, and `sources.py` keeps the two that do. All five end in `intake.expand_uploads` → a batch, so nothing downstream knows where a document came from. `GET /api/sources` lists them with connected/not, scope and setup steps; `GET /api/sources/{kind}/files` lists what is waiting; `POST /api/sources/{kind}/import` (`ids` or `urls`) starts a batch. The UI's **Other ways to add** modal renders each connector by mode.
- *Watched folder* (`FolderSource`, on by default at `<DATA_DIR>/intake`, `INTAKE_DIR` / `INTAKE_POLL_SECONDS`): a poller thread picks up PDFs/ZIPs once their size is stable across two polls, moves them to `processed/` (or `rejected/`) and starts a batch as `watched-folder`. Sync the folder from anywhere — Drive/Dropbox desktop client, SFTP, `gcsfuse`, `gsutil rsync`. Manual "import all now" and listing also exist.
- *Paste a link* (`UrlSource`): Google Drive share links are rewritten to `uc?export=download&id=…` so an "anyone with the link" file works with no Google API; `storage.cloud.google.com` console links become public object URLs; Dropbox `dl=0` → `dl=1`; any https link works. Guards: http(s) only, hosts resolving to private/loopback/link-local addresses refused (SSRF), redirects re-checked hop by hop, hard byte cap, short timeout, signature check with a Drive-specific hint when the download is an HTML sign-in page.
- *E-mail inbox* (`MailSource`, `INTAKE_IMAP_HOST/USER/PASSWORD[/FOLDER]`): lists unseen messages carrying PDF/ZIP attachments, imports the attachments, marks the message seen. Standard library only.
- *Google Drive / Cloud Storage* (`GoogleDriveSource`, `GcsSource`): client libraries are now installed (`requirements.txt`); they connect the moment a deployment supplies a service account (`GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_SERVICE_ACCOUNT_JSON`) plus `GDRIVE_FOLDER_ID` or `GCS_BUCKET`/`GCS_PREFIX`. Scope is fixed server-side; the reviewer only picks files within it. Until configured they answer 501 and the UI shows *Not connected* with the steps. Deliberately not done: per-user OAuth, write-back to a `done/` prefix, Drive push notifications.
- Shutdown is graceful: `BatchRegistry.shutdown()` refuses new batches and joins in-flight workers, and the folder poller is joined, so the SQLite connection is never closed under a worker (this was a segfault in tests before). Tests: `test_connectors.py`.

**Sample library.** `tools/make_samples.py` generates 25 small PDFs plus a ZIP bundle into `fixtures/pdfs/` with a `samples.json` manifest (title, blurb, category, expected outcome), built against the seeded suppliers and orders: clean approval, small overage inside the exception band, EUR approval; blocked, unknown, closed-PO, PO-of-another-supplier, no PO, two POs, over budget; math mismatch, missing total, no currency, currency mismatch; duplicate invoice number, identical file; scanned page, credit note, quotation (document gate), password-protected, hidden prompt-injection text; a three-invoice split delivery whose third document tips the order into the exception band; the two real-world scans that were already in the repo. `GET /api/samples` returns the manifest; `POST /api/samples/run-batch` runs any selection (including the ZIP) as a batch; the single-sample route still runs one PDF live. The UI groups the library by situation with the expected outcome as a badge, a Run button per sample and tick-boxes for a batch. `test_sample_library.py` runs every generated sample through the offline pipeline and asserts it reaches the outcome the manifest promises (the scan and real-world documents, which need the vision model, are excluded).

**No passwords.** The sign-in screen is gone. The reviewer workspace opens directly; **Switch to procurement / Switch to invoice review** in the top bar changes role. The bearer token is now the role name (`reviewer` / `admin`; the old demo codes remain as aliases), `ADMIN_ACCESS_CODE` / `REVIEWER_ACCESS_CODE` and `/api/auth/login` are removed, and page images pass `?role=` instead of `?access_code=`. Segregation of duties is unchanged and still enforced server-side on every request (`test_auth_roles.py`): the UI hiding a button was never the control, and which role a tab claims is now an explicit choice rather than a secret.
