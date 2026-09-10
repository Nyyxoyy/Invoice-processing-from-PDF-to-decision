# Invoice UI simplification — working record

## Current work — role-focused UX, 2026-09-10
The user added enforced reviewer/admin profiles, procurement tickets, supplier/PO editing, duplicate confirmation and improved scan diagnosis after the original UI pass. Re-read the complete updated `IMPLEMENTATION.md` (through section 19) and the new role/ticket code before editing. Those features and permissions are the baseline and must be preserved.

### Step 10 — findings and role journeys
- Both roles still enter a mostly identical invoice screen; admin copy even starts with upload instructions. Their first useful task is resolving procurement requests.
- The reviewer inbox does not distinguish work they can do from invoices waiting on procurement or answered requests ready to resume.
- Admin queue counts the same invoice again under detected needs; request lists are lengthy cards with no concise status/search workflow.
- Keep the document and task panel as siblings in the two-column layout; verify this structure during the redesign.
- Request action, data change, and reply are separate controls. A blocker disappearing after an admin edit moves the open request to a different panel, making completion difficult to follow.
- Empty purchase-order dropdowns from the user's screenshots have been removed in later code, but the empty state still needs a clear owner and prominent next action. No unrelated supplier orders should be offered as selectable fixes.
- Sign-in explains server enforcement and environment variables instead of helping each person begin their work. Role changes and theme controls compete with the page's purpose.
- Forms, secondary admin actions and repeated warning/confirmation blocks crowd the experience. Preserve advanced actions behind clear disclosures.

Planned: reviewer inbox with To review / With procurement / Ready to recheck; admin Requests home with deduplicated detected needs and request history; role-specific navigation and sign-in; one contextual admin task that keeps the request until data is updated and the reviewer is answered; clean detail columns and specific PO empty states; verify both roles in isolated fixtures, including send → admin fix → reply → reviewer resumes.

## Goal and source boundaries
Make the product understandable to an AP user: upload an invoice, know the outcome, and know exactly how to resolve anything that needs attention. This file is updated during the work so another session can continue.

Read: `IMPLEMENTATION.md`, current frontend, API and reviewer code; user screenshot; candidate PDF (background, not new instructions).
Reference: https://n8n.io/workflows/4452-automated-pdf-invoice-processing-and-approval-flow-using-openai-and-google-sheets/ — useful intake → human review → recorded outcome structure. No integration or email sending is implied.

## Step 1 — audit findings
- Dashboard leads with implementation explanations and unrelated PO budgets. History describes runs, not the invoices a person must act on.
- Processing exposes block counts, model names, token counts, hashes, internal stages and atomic commits. Real progress is useful; these details belong in an optional activity view.
- Detail repeats blockers across chips, checklist, field flags and document overlays. The actual editing controls sit far below the document.
- Fields use database names. All fields and all PO candidates are exposed even when most are irrelevant.
- Failed uploads have a temporary toast and send the user away. No persistent recovery path. Polling can wait indefinitely after connection trouble.
- “Approve — re-evaluate” promises approval while the operation may keep the invoice on hold. It should say “Check again” and explain that passing checks approves automatically.
- Reviewer attempts clutter invoice history and can make a resolved invoice appear to still need attention.
- Reset is a prominent one-click destructive action. Delete controls are hidden on hover and appear even for protected approvals.
- Native labels, keyboard navigation, mobile layouts and contextual errors need improvement.
- Workspace has no Git repository; preserve the original frontend locally before replacement.

## Step 2 — design decisions / implementation in progress
1. One invoice inbox, status filters and search; upload is the primary action. Samples are optional.
2. Three plain-language live steps: read invoice, check details, save result. Keep technical events accessible after processing.
3. Outcome + short next step first. Review tasks beside a clean document preview. Show only problem fields first; other fields remain expandable.
4. Use the server diagnosis as the source of truth. Supplier → details / scan confirmation → purchase order → check again. Explain external resolution for budget, duplicate and unsupported-document holds.
5. Persistent errors next to the action; retain inputs when requests fail. Clear retry / return / replacement-upload paths.
6. Preserve deterministic approval, stale-revision protections, attestation and audit history.

## Step 3 — implemented
- Replaced the crowded single-file UI with `index.html`, `app.css`, and `app.js`. Original saved at `backups/index.before-ux.html` because this directory has no Git history.
- Light, restrained invoice inbox; status filters/search; supplier/invoice/amount/next-step columns; PO budgets moved to their own page; sample actions collapsed.
- Three real progress steps. No hashes, tokens, model names or internal stages in the default journey. Real event payloads remain under technical evidence.
- Review tasks next to a clean paginated PDF. Friendly field labels, explicit save/confirm controls, source highlight on demand, other fields collapsed.
- Supplier onboarding and authorized PO creation appear in the relevant task. Scan confirmation is explicit. Check again runs the existing rules; reject requires a reason.
- External holds explicitly explain what the demo cannot do (amend PO, reverse an approval, override duplicates). No promise of an unavailable override.
- Persistent form errors and connection recovery, file constraints, pending edits guard, repeated-action lock, decision idempotency keys, reset confirmation.
- API list includes parent/document IDs and saved invoice summary fields. Inbox collapses superseded parent attempts and preserves earlier results in history.
- Added guarded retry endpoint for failed readings: new child attempt, original document/history retained; successful decisions cannot be retried through this path.

## Step 4 — verification and follow-up fixes
- All 79 existing backend tests passed after the redesign. Five new regression tests bring the suite to **84 passing**.
- Browser: corrected an ambiguous date, saved it, saw all checks resolved, and used Check again to approve.
- Browser: onboarded the fixture supplier, created/selected its authorized purchase order, and approved after rechecking.
- Browser: retried an interrupted reading, saw the real result, and confirmed it became a child attempt without deleting history.
- Browser: confirmed all eight scan readings against a known image fixture, cleared all blockers, then approved. Model transcription was stubbed; this is a UI/reviewer-path test, not an assessment of live OCR quality.
- Found invalid-correction recovery gap in the backend. A normalization failure could be recorded as corrected and disappear from diagnosis. Invalid corrections now return 422 with the accepted format before writing a revision; existing bad corrections remain diagnosable. Browser verified “not a date” stays in the field beside its error.
- Found rejection context loss: rejection attempts did not retain the field revision, losing supplier/amount in the inbox. Rejections now copy the latest field revision into their own historical result; regression test verifies it.
- Browser: invoice search, external budget recovery instructions, mobile document expand/collapse and rejection with a recorded reason worked.
- Visual QA at 1280×720 and 390×844. Mobile originally hid status off-screen in a wide table; switched invoice rows to a compact layout. Mobile preview now expands so the first review action appears sooner.
- Existing inbox polling used to replace unchanged rows every refresh, detaching focus/targets. It now redraws only when data changes.
- Request completion waits for the upload/retry request's returned run ID; provisional filename matching is used for progress only.
- Frontend formatted with the locally available Prettier; `node --check backend/app/static/app.js` passes.
- `IMPLEMENTATION.md` updated for UI, API, recovery and 84-test status.

## Step 5 — theme, supplier management, red re-check state
- **Dark theme.** All `app.css` colour literals were replaced by semantic tokens (`--surface`, `--line-strong`, `--ok-fg`, `--bad-bg`, …); a `[data-theme="dark"]` block redefines them. Toggle in the top bar (`data-action="toggle-theme"`), persisted in `localStorage`, defaults to the OS preference, applied by an inline script before first paint (no flash), updates `<meta theme-color>` and `color-scheme`. Previous CSS/HTML/JS saved as `backups/*.before-theme.*`.
- **Supplier edit / block / delete.** `PATCH /api/vendors/{id}` (name, country, status approved|blocked — a rename keeps the old name as an alias so invoices that print it still match; clashing names 409) and `DELETE /api/vendors/{id}` (409 when the supplier has purchase orders or invoices — history stays coherent; the UI says to block instead). Supplier cards show reference counts and Edit / Block or Approve again / Delete with confirm dialogs and inline errors. `GET /api/vendors` now returns `total_pos` and `invoices`.
- **Red after Check again.** A held result that is a review run (`kind = review`) compares its open diagnosis codes with the parent result's decision codes; codes present in both are "persistent". Those tasks, field editors and the outcome card render red (`.still-open`, `.outcome.rechecked`), the outcome shows "N still unresolved", the panel heading becomes "What still needs your attention", and the check-again notice says the red items remain. Newly surfaced codes stay amber.
- Follow-up: native form controls were still white in dark mode — `input, select, textarea` used the named colour `white`, which the hex-only tokenization missed. Replaced with `var(--surface)`, swept all named colours, themed `option`, placeholders, disabled state, autofill and `<dialog>`. The first re-test still showed white because the browser served a cached stylesheet; `/static/*` and `/` now return `Cache-Control: no-cache, must-revalidate`, so edits are picked up on every load. Re-verified in dark mode: input/select background = surface token, toast text readable.
- Verification: 87 backend tests (3 new: rename keeps alias + clash 409, block → invoices reject, delete guarded/orphan ok). Browser: toggled dark ↔ light (persisted, both palettes render), opened a re-checked hold (title/badge/red tasks/red field confirmed), opened Suppliers and the inline edit form. API: PATCH rename/block, DELETE 409 on referenced supplier, DELETE ok on orphan.

## Step 6 — two roles with server-side enforcement (2026-09-10)
- **Decision:** strict segregation of duties. *Invoice reviewer* uploads, corrects, attests, approves, rejects. *Procurement admin* onboards/edits/blocks/deletes suppliers, creates/amends/closes/deletes purchase orders, works the procurement queue, resets the demo — and **cannot** upload, approve or reject. Both read everything.
- **Enforcement is server-side** (`backend/app/auth.py`): app-level `auth_gate` dependency; every non-public route requires `Authorization: Bearer <access code>`; `require_reviewer` / `require_admin` per endpoint; actor names come from the role, not the request body. Public: `/`, `/static/*`, `/api/health`, `/api/auth/config`, `/api/auth/login`.
- **Deployable:** codes from `ADMIN_ACCESS_CODE` / `REVIEWER_ACCESS_CODE`, constant-time compared; unset → demo defaults and `dev_mode: true` (the sign-in screen pre-fills them and says so). With env codes set, `/api/auth/config` never reveals them. The bearer-code scheme is a deliberate stand-in for SSO/OIDC: swap `resolve_user` and nothing else moves.
- **Frontend:** sign-in landing with two role cards; role badge + Switch role in the top bar; `admin-only` nav (Procurement queue with live count); reviewer sees upload/samples/review tasks and "Waiting on procurement" callouts instead of master-data forms; admin sees a procurement view (no upload), a queue page, and on a held invoice a "What procurement can do here" panel (onboard / raise PO / amend). Master pages show forms and actions only to admin. Stale/lost session → 401 → back to sign-in.
- **PO admin:** `PATCH /api/pos/{id}` (amount never below approved billing; open/closed) and `DELETE /api/pos/{id}` (409 when ledger history exists).
- **Queue semantics:** only true procurement work — an invoice whose supplier already has a selectable open order is the reviewer's job and is not listed.
- Verification: 94 tests (auth: 401 anon, reviewer 403 on master data/reset/queue, admin 403 on upload/approve/correct/reject, env codes honoured and never leaked; PO amend/close/delete guards; queue filtering). Browser: signed-out landing → reviewer (upload zone, review tasks, no master forms) → switch → admin (no upload, queue count, queue page, procurement panel with create-PO form, no Check again). Live API: anon 401, reviewer POST vendors 403, admin approve 403.

## Step 7 — requests to procurement (tickets) and blocked-supplier re-check (2026-09-10)
- **Why:** a reviewer facing a blocked or unknown supplier, a missing order or a too-small budget had no in-product way to ask procurement and no record of having asked. Now they raise a tracked request.
- **Backend:** `tickets` table (kind ∈ unblock_supplier | onboard_supplier | raise_po | amend_po | other; open → resolved | declined; requester, resolver, notes, timestamps). `POST /api/tickets` (reviewer; one open ticket per invoice+kind, repeats return the existing one), `GET /api/tickets?status=&run_id=` (both), `POST /api/tickets/{id}/resolve` (admin; outcome + note), `GET /api/tickets/kinds`. Opening and resolving emit `REQUEST` events on the invoice's audit trail.
- **Re-check after unblock:** a rejection whose only cause is `VENDOR_BLOCKED` is now reviewable again (correct/attest/approve), so once procurement approves the supplier the reviewer presses Check again and the invoice can approve. All other rejections stay final (duplicates etc.) — tested.
- **Frontend:** "Ask procurement" panel on held invoices and on blocked-supplier rejections (request kind pre-selected from the hold codes, note, tracked status with procurement's reply). Admin sees "Requests from the reviewer" on the invoice with resolve/decline + note, and for a blocked supplier a one-click "Approve supplier again". Procurement queue now leads with **Requests from reviewers**, grouped by requester (the reviewer tree), then "Detected needs". Nav count = open requests + detected needs. Request events appear in the activity log.
- **Bug fixed:** page images broke after the auth gate — `<img>` cannot send a bearer header. The image route (and only that route) accepts `?access_code=`; verified header/query both 200, anonymous 401, and the query token is refused on every other route.
- Layout fix: the request panel's list and form were placed directly inside `.card`, which has no padding of its own (content is expected inside `.task` / `.review-footer`). They now sit in those wrappers; measured in the browser: textarea and button 23 px inside the card edges on both sides.
- Request panel is state-aware: with an open request the form is withheld ("waiting on procurement"); after a **resolved** request it becomes "Done by procurement — now check the invoice again" with a Check again button and the form only behind "Still stuck? Send another request"; after a **declined** request the form returns with procurement's note; otherwise the plain form. Verified in-browser on a run with a resolved onboarding request: no top-level form, Check again present.
- Verification: 96 tests (ticket lifecycle, dedupe, unknown kind 422, resolve twice 409, audit events, blocked re-check approves, other rejections stay 409). Browser, dark theme: reviewer opens rejected Zencorporations → preview renders → sends "Approve a blocked supplier again" with a note → admin queue shows it under `From reviewer@demo` → admin opens invoice, Approve supplier again, Mark resolved with note → reviewer sees resolution, Check again → **Invoice approved**.

## Running / continuing
- Main app: `http://localhost:8321`. Sign in with `admin-demo` or `reviewer-demo` locally; deployed environments set `ADMIN_ACCESS_CODE` / `REVIEWER_ACCESS_CODE`.
- Start main app if needed: `venv/bin/python -m uvicorn app.main:app --port 8321 --app-dir /Users/nikunj/zamp-case-study/backend`.
- Tests: `PYTHONPATH=backend venv/bin/python -m pytest backend/tests -q`.
- Isolated browser QA: `venv/bin/python tools/ux_qa_server.py`, then `http://localhost:8322`. Creates a fresh temporary database; uses no AI calls and does not touch the user's invoices.
- Keep the existing approval/ledger constraints. PO amendments, duplicate overrides, reversals and actual payments remain unsupported and are explicitly explained in the UI.
- Future product validation: observe a real AP user completing a hold without guidance. No hosted deployment or new external integrations were requested or added.

## Step 8 — one place per problem (2026-09-10)

Finding: the reviewer's "send request" lived in a separate panel above the tasks, while the problem it answered sat inside a task (e.g. "Choose the purchase order" said "waiting on procurement" with no button). After procurement acted, the panel kept offering the form.

Case map (who can fix what):
- Reviewer alone: misread fields, dates, currency codes, math, scan attestation, picking an existing order (several references, fuzzy candidate).
- Procurement: unknown supplier → onboard; blocked supplier → approve again; no/closed/wrong-currency/wrong-supplier order → raise or reopen; over budget → amend. Each maps to exactly one request kind.
- Reviewer decides, nothing to ask: same supplier/amount/day match → confirm it is a separate invoice (new, audited) or reject; content conflict, prepayment/credit note → correct a misread or reject. Exact duplicates stay final.
- Cross-cutting: request state none/open/resolved/declined per kind; procurement fixing without a request; blocker resolved so its task disappears; still-red after Check again; superseded run; rejected-blocked run.

Fix: one "slot" component rendered inside the task that owns the blocker — form ("Ask procurement to …") → "Sent to procurement · time · note" → "Done by procurement · note · Check again / Still stuck? Send again" or "Declined · note · Send again". Requests whose blocker has since disappeared show as one green line under the heading. The standalone reviewer panel is gone; a collapsed "Need something else from procurement?" stays in the footer. Admin sees the mirror: the reviewer's open request with Mark done / Decline inline in the task that answers it; the separate card only shows history and requests with no task. Requests follow the invoice across Check again runs (looked up by document). Rejected-blocked invoices get the same slot plus Check again.

Also fixed while verifying: Check again re-derived the purchase order from the raw field text, so an uncorrected "PO Reference: PO-1001" held on NO_PO_MATCH; and hyphenated order ids (PO-SH-1) were truncated by the reference extractor.

## Step 9 — unusable readings (2026-09-10)

Finding: a scan read "$" for currency; the editor offered "I checked $ against the scanned invoice" and saving produced "Enter an ISO currency code… could not be read". A tick box for a value that can never pass is a dead end, and the error said nothing about why.

Edge cases, all handled by one rule — a reading with no single legal interpretation is explained, never attestable, and comes with the legal readings to pick from:
- Currency: bare symbol ($ — USD/CAD/AUD…; € → EUR offered; ¥ → JPY or CNY offered), two codes in one reading, a word that is not a code. Suggestions from facts: code stated elsewhere on the document, the referenced order's currency, the supplier's open orders when they share one currency.
- Dates: 03.04.2021 → both readings offered, labelled "if the day comes first (3 April 2021)" / "if the month comes first"; two dates in one reading; no date.
- Amounts: 1.234 / 1,400 → grouping reading (1400.00) and, when the currency allows, the decimal reading; several numbers in one reading → each offered; no number.
- PO reference without PO-…; invoice number that is only a label; empty reading.
- Attest of an unusable reading refused server-side with the same reason; typing an unusable value gets the reason plus the accepted format.

Rule kept: the code lists readings, the reviewer picks. Nothing is guessed.
- Found alongside: a scan value the reviewer had already typed was still asked to be "confirmed against the scan" (checkbox, checklist item, and the approval gate). Correction now counts as the stronger evidence it is.

### Step 11 — implemented role journeys
- Reviewer home separates To review, With procurement and Ready to recheck. My requests adds searchable waiting/completed/declined history and replies. Inbox refresh now includes ticket changes.
- Admin signs into Requests. Compact searchable requests lead to one task containing the reviewer’s note, supplier/order controls and a required reply. Open requests remain visible after the underlying blocker clears.
- Admin can amend or reopen the referenced order without leaving the invoice. Available orders show the correct supplier/currency and remaining budget; create another order is secondary.
- Review has one primary finish action. While procurement is working, returning to reviews is primary; rechecking remains available. No empty order dropdown, and asking for another order is possible even when candidates exist.
- Found and fixed detected-queue exclusion for orders in the wrong currency. The backend now only treats a same-currency order as selectable.
- Simplified sign-in, navigation and request cards; preserved theme tokens and role controls. Verification in progress.

## Step 10 — reply must match the record (2026-09-10)

> Superseded by Step 14: the reply form is gone; requests close themselves.

Finding: on the rebuilt Requests page a request showed "Declined — approved" after the admin onboarded the supplier and then pressed Decline. Two similar buttons, no tie to the facts.

Fix: fulfilment is derived from the supplier/order/ledger state. When the record already satisfies the request the reply form shows "✓ MY COMPANY is an approved supplier" and offers only Send reply & complete; the server refuses a contradicting decline. When not fulfilled, Decline is labelled "nothing will change". The Requests list marks fulfilled to-dos so the admin sees what only needs a reply.

## Step 11 — one request for a new supplier (2026-09-10)

> The "one reply" described here no longer exists (Step 14); the two steps remain.

Finding: after procurement onboarded a new supplier the reviewer still had no order to pick, so a second request ("raise a purchase order") was needed for every new supplier.

Fix: the onboard request covers both. Procurement sees two steps (approve supplier, provide the purchase order) and one reply that can only complete once both are recorded; the request page shows progress ("approved — add its purchase order"). Completing any request without the record showing it done is refused, so a reply never contradicts what the reviewer will find.

## Step 12 — one action per scan field (2026-09-10)

Finding: scan fields had a checkbox, a "Confirm checked values" button and a Save & confirm button; pressing the wrong one produced "Check the boxes for values you have compared…". Pressing Save & confirm already means the reviewer checked the value.

Fix: checkbox and confirm button removed. Save & confirm on an unchanged reading records an attestation; on a changed value a correction. One button, one meaning.

## Step 13 — held is not the same as owed (2026-09-10)

Finding: after closing a request, the admin still saw the invoice under "On hold" with a "Provide the purchase order" task. Held meant "the reviewer has work", not "procurement has work", but the admin views did not distinguish.

Fix: one server-side derivation of what procurement owes drives the queue, the invoice page and the inbox. The admin inbox now separates Needs procurement from With reviewer; an invoice with nothing owed shows "Procurement is up to date" and the reviewer's remaining items.

## Step 14 — done is decided by the record (2026-09-10)

Finding: after adding the supplier and the order, the admin still faced a "Mark resolved / Decline" form and a "Requests from the reviewer" card. Half of that was a browser tab running hours-old JavaScript (hash routing never reloads); the other half was a button asking a human to declare something the record already showed.

Fix: requests close themselves when the supplier and order tables satisfy them, with an automatic note for the reviewer. The admin page is now: step 1 add the supplier, step 2 add the order, and underneath only "Decline request" with a reason. The app also reloads itself when the server has newer frontend files.

- Hardening after review: requests follow Check-again runs; "a different order" is answered only by a new order; a request the record already satisfies is refused with the fact; unblock requests are pinned to the supplier they were about; a final invoice closes its leftover requests; on a final invoice the admin can only "Close request".

## Step 15 — the supplier is a child of an approved one (2026-09-10)

Finding: an unknown printed name ("White Group") offered only "correct the misread" or "ask procurement to onboard", although it was a subsidiary of an approved supplier with open orders.

Fix: the reviewer picks the approved supplier and its order in the same step (recorded as their correction); procurement can register the name as an alias so future invoices match by themselves.

## Step 16 — "1 436,78" (2026-09-10)

Finding: a scanned tax of 1 436,78 was suggested as 436.78. Fix: a space before a three-digit group is a thousands separator in the amount reader.

## Step 17 — budget known at selection time (2026-09-10)

Finding: the only selectable order had USD 1.00 left; the reviewer had to select it and check again to learn the budget was insufficient. Fix: the picker flags orders that cannot take the invoice; once selected, the page shows the numbers, the request to raise the budget, and "Reject this invoice instead" — no Check again needed to find out.

## Step 18 — scans: confirm only what the code could not (2026-09-11)

Finding: every scanned invoice asked the reviewer to confirm every field, including ones plainly legible and internally consistent.

Fix: a second, independent reading of the page plus hard cross-checks (amounts add up, supplier in master, order on record) confirm fields by code; the reviewer sees "✓ n scanned values confirmed automatically" with the reason for each and confirms only the rest. No model confidence score is used — agreement and arithmetic are.

## Step 19 — find the next one from here (2026-09-11)

Finding: from an order there was no way to see its invoices; from a supplier no way to see its orders.

Fix: orders list their invoices, suppliers list their orders, every entry links to the record, and links land on the highlighted row or card.

## Step 20 — one modal, one number format (2026-09-11)

Finding: inline lists under orders and suppliers would not scale, and the inbox showed three formats for one currency ("$ 544,46", "Currency: USD Total: $540.00", "USD $2,160.00") because raw readings were printed as-is.

Fix: a single reusable modal for any list (filterable, closes on Esc/backdrop/navigation); amounts, numbers, dates and references shown everywhere in their normalised form, with "currency not confirmed" when the code is unknown.
