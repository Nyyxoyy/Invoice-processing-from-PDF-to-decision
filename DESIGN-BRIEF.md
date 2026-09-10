# Design brief — AP Invoice Decisioning UI

Context file for Claude Design. This describes a WORKING app (FastAPI + SQLite
backend, all endpoints live). The design job is the frontend only; every data
shape below is real and already served by the API.

## What the product is

An accounts-payable decisioning tool. A user uploads a vendor invoice PDF; a
pipeline extracts fields (LLM reads, code verifies), matches the invoice
against purchase orders, and produces an explained decision. Humans review
anything the machine isn't certain about. Money only ever moves through
deterministic rules.

One-line identity: **"LLM reads documents, code decides money, every decision
explained."**

## Audience and tone

- Primary viewer: an interviewer at an AI-operations company (this is a hiring
  case-study demo) and, in the fiction, an AP clerk + their finance manager.
- Tone: calm operational software. Precision over decoration. Feels like a
  well-made internal finance tool (think Linear/Stripe-dashboard restraint),
  not a marketing page. Numbers are the heroes.
- Trust is the theme: the UI's job is to SHOW WHY every decision happened —
  evidence, checks, arithmetic — not to hide machinery.

## Screens

### 1. Dashboard (home)
- Upload zone: drag-drop one PDF (that's the entire input surface)
- Purchase orders panel: per-PO consumption vs base amount (progress bar),
  currency code always shown beside amounts (USD 6,495.00 — never bare $),
  open/closed status. Amounts in DIFFERENT currencies must never be summed
  into one number — group or label per currency.
- Runs table: newest first. Each row = one processing attempt: filename,
  run status (completed/failed), disposition pill, timestamp. Reruns/review
  runs must be visually distinguishable from intake runs (kind: intake|review)
  so counts don't read as inflated invoice volume.
- A "reset demo workspace" affordance (small, out of the way).

### 2. Run detail
The core screen. Sections top to bottom:
- **Decision banner**: disposition + the template explanation sentence. This
  text answers: what happened, why, what changed financially, next action.
  Example real payload:
  "Held for review. This invoice would bring approved billing to USD 32,000.00
   against a USD 30,000.00 PO. The USD 2,000.00 overage exceeds the
   USD 1,500.00 exception limit. No amount was added to the approved ledger.
   Next: verify the invoice or amend the PO."
- **Reason codes** as chips (full list below).
- **Currency line**: resolved code or "Not stated", HOW it resolved
  (field / document_context / reviewer), reconciliation arithmetic string,
  all PO references found in the document.
- **Field evidence table** — the signature element. One row per field:
  name, status (selected/missing/ambiguous), raw value from the document,
  read method (llm_text / llm_vision / reviewer), and three check badges:
  source_match, role_check, normalization — each pass / fail /
  not_evaluated / not_applicable. Badge semantics:
    pass = code-verified · fail = caught an error · not_evaluated = no value
    to check (NOT a failure) · not_applicable = scan evidence, needs human.
  Also review_status marks: corrected (✏), attested (✓).
- **Stage trace**: chronological events (INGEST → EXTRACT → VALIDATE → MATCH →
  DECIDE), including model attempts (model id, latency, input/output tokens)
  and the budget rule line, e.g.
  `budget_check[v1]: A=24000, I=8000, C=32000, B=30000, D=2000 > T_exc=1500`.
  Collapsible; expanded state is for the interview demo.

### 3. Review panel (only on HELD runs)
Reviewer actions, each server-enforced:
- Edit any field value ("correct") — creates a new immutable revision;
  show current revision number; stale-view conflicts (409) surface as
  "reload — someone changed this" not raw errors.
- Attest checkboxes on scan-read fields (llm_vision) — the only way scan
  evidence becomes trusted.
- PO candidate picker: deterministic candidates (same vendor, same currency,
  open) with amounts. A candidate is a suggestion, never auto-selected.
- Approve (= reevaluate against fresh state; may still hold/reject — the UI
  must present that outcome honestly, not as an error)
- Reject with reason.
- No "approve anyway" control exists. Don't design one.

### 4. Live run view (during processing)
Upload → stage cards light up as the pipeline executes (INGEST, EXTRACT,
VALIDATE, MATCH, DECIDE, COMMIT). Currently sync request (~3-5s with one model
call); design the stage progression anyway (SSE planned). No fake animation —
stages reflect real events.

## Decision vocabulary (pill colors matter)

| Label | Meaning | Suggested tone |
|---|---|---|
| AUTO_APPROVE | all gates passed, money posted | green |
| APPROVE_WITH_EXCEPTION | posted, deviation within authorized band, logged | green with marker |
| HOLD_REVIEW | machine uncertain or fixable issue, human decides | amber |
| REJECT | certain violation (duplicate, blocked vendor) | red |
| REVIEWER_APPROVED / REVIEWER_REJECTED | human resolution (decision_mode=reviewer) | green/red + person marker |
| failed | operational failure (unreadable PDF), no business decision | muted red, distinct from REJECT |

Reason codes (chips): VENDOR_UNKNOWN, VENDOR_BLOCKED, PO_VENDOR_MISMATCH,
PO_CLOSED, NO_PO_MATCH, PO_FUZZY_CANDIDATE, PO_MULTIPLE_REFS,
PO_BUDGET_EXCEEDED, VARIANCE_EXCEPTION, DUP_FILE_HASH, DUP_INVOICE_NO,
DUP_FINGERPRINT, CONTENT_CONFLICT, MATH_MISMATCH, MISSING_FIELD,
UNVERIFIED_FIELD, AMBIGUOUS_CURRENCY, AMBIGUOUS_DATE, CURRENCY_MISMATCH,
UNSUPPORTED_DOCUMENT_TYPE, UNSUPPORTED_AMOUNT_STRUCTURE, REVIEW_REQUIRED_SCAN,
REVIEWER_REJECTED. Group visually: extraction problems vs business conflicts
vs policy limits.

## Real API (all live, localhost:8321)

- POST /api/invoices (multipart file) → {run_id, invoice_id, route, codes,
  explanation, posted}
- GET /api/runs → [{run_id, run_status, disposition, decision_mode, kind,
  invoice_id, filename, created_at, finished_at}]
- GET /api/runs/{id} → run + snapshot + events[{seq, ts, stage, event_type,
  payload}] (payload carries fields/gates/attempts/decision objects)
- GET /api/runs/{id}/review → {revision_seq, fields{...}, context,
  po_candidates[]}
- POST /api/runs/{id}/review/correct {field, value, actor, expected_seq}
- POST /api/runs/{id}/review/attest {fields[], actor, expected_seq}
- POST /api/runs/{id}/review/approve {actor, idempotency_key}
- POST /api/runs/{id}/review/reject {actor, idempotency_key, reason}
- GET /api/pos → [{po_id, supplier_id, currency, amount_minor, status,
  consumed_minor}] (amounts are integer minor units + currency code)
- POST /api/admin/reset

Field record example (from events / review):
```json
{"field":"invoice_gross_total","status":"selected","raw_value":"213470",
 "read_method":"llm_text",
 "evidence":{"extraction_revision_id":"xr_4cf9","block_id":"p1.b14","page":1},
 "checks":{"source_match":"pass","role_check":"pass",
           "normalization":"pass","ambiguity":"none"},
 "review_status":"not_reviewed"}
```

## Hard constraints

- Amounts: integer minor units + ISO code from the API; format per currency
  exponent (JPY 0 decimals, BHD 3). NEVER float-round money in JS display
  logic beyond formatting.
- Every string sourced from documents/model output is untrusted — escape it.
  (A test fixture literally contains "ignore previous instructions".)
- Truthful states only: no fabricated progress, no invented confidence
  percentages (the system deliberately has NO numeric confidence — check
  states only), no green checkmarks on unverified data.
- Must work as a plain static page against the API (current stack: single
  index.html; a React/Vite build is acceptable if it stays simple to serve
  from FastAPI).
- Demo runs live in an interview: legibility at laptop resolution +
  screen-share compression beats density. Key moments the design must make
  cinematic-but-honest: (1) approval explanation with the arithmetic,
  (2) a held run's field-evidence table, (3) reviewer fixing a field and the
  decision flipping, (4) PO consumption bar moving.

## What NOT to design

Login/auth, multi-workspace, settings pages, payment screens, charts beyond
the PO consumption bars, mobile-first layouts (desktop demo), marketing pages.
