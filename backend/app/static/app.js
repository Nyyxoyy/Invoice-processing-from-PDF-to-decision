"use strict";
const $ = (s) => document.querySelector(s);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const FIELD = {
  supplier_name: "Supplier",
  buyer_name: "Billed to",
  invoice_number: "Invoice number",
  invoice_date: "Invoice date",
  due_date: "Due date",
  currency: "Currency",
  po_reference: "Purchase order",
  subtotal_net: "Subtotal",
  tax_total: "Tax",
  shipping_total: "Shipping",
  invoice_gross_total: "Invoice total",
  amount_due: "Amount due",
};
const EXPECTED = {
  supplier_name: "Use the supplier’s legal name.",
  invoice_number: "Enter the invoice number exactly as printed.",
  invoice_date: "Use YYYY-MM-DD, for example 2026-08-28.",
  due_date: "Use YYYY-MM-DD.",
  currency: "Use a currency code, such as USD or EUR.",
  po_reference: "Use the purchase order number, for example PO-1001.",
  subtotal_net: "Use a number, for example 6000.00.",
  tax_total: "Use a number, for example 495.00.",
  shipping_total: "Use a number, for example 50.00.",
  invoice_gross_total: "Use a number, for example 6495.00.",
  amount_due: "Use a number, for example 6495.00.",
};
const LABELS = {
  VENDOR_UNKNOWN: "Confirm the supplier",
  VENDOR_BLOCKED: "Supplier is blocked",
  NO_PO_MATCH: "Choose a purchase order",
  PO_MULTIPLE_REFS: "Choose one purchase order",
  PO_CLOSED: "Purchase order is closed",
  PO_VENDOR_MISMATCH: "Purchase order belongs to another supplier",
  PO_FUZZY_CANDIDATE: "Confirm the purchase order",
  CURRENCY_MISMATCH: "Currencies do not match",
  AMBIGUOUS_CURRENCY: "Confirm the currency",
  AMBIGUOUS_DATE: "Confirm the invoice date",
  MISSING_FIELD: "Complete the missing details",
  UNVERIFIED_FIELD: "Check the invoice details",
  MATH_MISMATCH: "Check the amounts",
  REVIEW_REQUIRED_SCAN: "Confirm the scanned details",
  UNSUPPORTED_AMOUNT_STRUCTURE:
    "Prepayment or adjustment needs separate review",
  UNSUPPORTED_DOCUMENT_TYPE: "This document is not supported",
  PO_BUDGET_EXCEEDED: "Purchase order budget exceeded",
  DUP_FILE_HASH: "This file was already uploaded",
  DUP_INVOICE_NO: "This invoice was already approved",
  DUP_FINGERPRINT: "Possible duplicate invoice",
  CONTENT_CONFLICT: "Another version of this invoice exists",
  VARIANCE_EXCEPTION: "Approved with a budget exception",
  REVIEWER_REJECTED: "Rejected after review",
};
const PO_CODES = [
  "NO_PO_MATCH",
  "PO_MULTIPLE_REFS",
  "PO_CLOSED",
  "PO_VENDOR_MISMATCH",
  "PO_FUZZY_CANDIDATE",
  "CURRENCY_MISMATCH",
];
const EXP = {
  JPY: 0,
  KRW: 0,
  CLP: 0,
  VND: 0,
  ISK: 0,
  PYG: 0,
  UGX: 0,
  RWF: 0,
  GNF: 0,
  DJF: 0,
  KMF: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BIF: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
  IQD: 3,
  LYD: 3,
};
const state = {
  runs: [],
  pos: [],
  vendors: [],
  samples: [],
  filter: "all",
  search: "",
  route: "",
  generation: 0,
  detail: null,
  review: null,
  doc: null,
  page: 1,
  selectedField: null,
  live: null,
  batch: null,
  busy: false,
  decisionKeys: {},
  user: null,
  authConfig: null,
  allTickets: [],
  requestFilter: "open",
  requestSearch: "",
};
// Open demo: no passwords. The "token" is the role itself (reviewer by
// default); the server still enforces what each role may do.
const TOKEN_KEY = "role";
const DEFAULT_ROLE = "reviewer";

// This browser's workspace. The demo is public, so what you upload, the orders
// you spend and the reset button are yours alone; the id is generated here,
// never issued by the server, and lives only in this browser.
const WORKSPACE_KEY = "invoice-desk-workspace";
const getWorkspace = () => {
  try {
    let id = localStorage.getItem(WORKSPACE_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, "");
      localStorage.setItem(WORKSPACE_KEY, id);
    }
    return id;
  } catch (e) {
    return "";   // storage blocked: the server falls back to the shared demo
  }
};
const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || DEFAULT_ROLE;
  } catch (e) {
    return DEFAULT_ROLE;
  }
};
const setToken = (role) => {
  try {
    localStorage.setItem(TOKEN_KEY, role);
  } catch (e) {}
};
const isAdmin = () => state.user?.role === "admin";
function applyRoleUI() {
  const signedIn = !!state.user;
  document.body.classList.toggle("signed-out", !signedIn);
  document.body.dataset.role = state.user?.role || "";
  const badge = $("#role-badge");
  badge.hidden = !signedIn;
  badge.textContent = signedIn ? state.user.label : "";
  badge.className = `role-badge ${state.user?.role || ""}`;
  $("#switch-role").hidden = !signedIn;
  $("#switch-role").textContent = isAdmin()
    ? "Switch to invoice review"
    : "Switch to procurement";
  $("#nav-count").hidden = isAdmin() || !signedIn;
  document
    .querySelectorAll(".admin-only")
    .forEach((el) => (el.hidden = !isAdmin()));
  document
    .querySelectorAll(".reviewer-only")
    .forEach((el) => (el.hidden = isAdmin() || !signedIn));
  $("#workspace-label").textContent = isAdmin()
    ? "PROCUREMENT"
    : "ACCOUNTS PAYABLE";
  $("#invoice-nav-label").textContent = isAdmin()
    ? "Invoice history"
    : "Invoice reviews";
  $(".brand").href = isAdmin() ? "#queue" : "#dashboard";
  // admin order: Invoice history, Purchase orders, Suppliers, Requests (last)
  if (isAdmin()) $("nav").append(document.querySelector('[data-nav="queue"]'));
}
function signOut() {
  state.user = null;
  state.live = null;
  state.batch = null;
  applyRoleUI();
}
async function ensureSession() {
  try {
    state.user = await api("/api/auth/me");
  } catch (e) {
    state.user = null;
    state.sessionError = e.message;
  }
  applyRoleUI();
  return state.user;
}
async function switchRole(role) {
  setToken(role);
  signOut();
  await ensureSession();
  location.hash = "";
  await route();
}
const TICKET_KINDS = {
  unblock_supplier: "Approve a blocked supplier again",
  onboard_supplier: "Onboard a new supplier and raise its purchase order",
  raise_po: "Raise a purchase order",
  amend_po: "Amend a purchase order budget",
  other: "Other procurement request",
};
// A rejection caused only by the state of the supplier register — the supplier
// is blocked, or absent from it — reopens once procurement changes that state.
// Mirrors RECHECKABLE_REJECT_CODES in review.py; every other rejection is final.
const RECHECKABLE_REJECT_CODES = ["VENDOR_BLOCKED", "VENDOR_UNKNOWN"];
// One blocker code ↔ one request kind. A "slot" renders the request state
// for that kind exactly where the blocker is shown, so the ask, the wait, the
// answer and the retry all live in the same place as the problem.
const KIND_FOR_CODE = {
  VENDOR_UNKNOWN: "onboard_supplier",
  VENDOR_BLOCKED: "unblock_supplier",
  NO_PO_MATCH: "raise_po",
  PO_CLOSED: "raise_po",
  CURRENCY_MISMATCH: "raise_po",
  PO_VENDOR_MISMATCH: "raise_po",
  PO_BUDGET_EXCEEDED: "amend_po",
};
const SLOT_COPY = {
  onboard_supplier: {
    ask: "Ask procurement to onboard this supplier and raise its order",
    placeholder:
      "Contract or registration details procurement can verify, and who authorized the spend (amount, currency)",
  },
  unblock_supplier: {
    ask: "Ask procurement to approve this supplier again",
    placeholder:
      "Why this supplier should be approved again — contract, contact, reason it was blocked…",
  },
  raise_po: {
    ask: "Ask procurement to raise or reopen the order",
    placeholder:
      "Who authorized this spend, the amount and currency, any quote or contract reference",
  },
  amend_po: {
    ask: "Ask procurement to amend the order budget",
    placeholder:
      "Why the invoice exceeds the order — approved change, price revision, reference",
  },
  other: {
    ask: "Send to procurement",
    placeholder: "What you checked and what you need",
  },
};
function money(minor, code) {
  if (minor == null || !code) return "—";
  const exp = EXP[code] ?? 2;
  return `${code} ${(minor / 10 ** exp).toLocaleString("en-US", { minimumFractionDigits: exp, maximumFractionDigits: exp })}`;
}
function date(value) {
  if (!value) return "—";
  const d = new Date(
    value.replace(" ", "T") + (value.endsWith("Z") ? "" : "Z"),
  );
  return isNaN(d)
    ? value
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function dateTime(value) {
  if (!value) return "—";
  const d = new Date(
    value.replace(" ", "T") + (value.endsWith("Z") ? "" : "Z"),
  );
  return isNaN(d)
    ? value
    : d.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}
function statusKey(r) {
  return ["failed", "running", "queued"].includes(r.run_status)
    ? r.run_status
    : r.disposition || "queued";
}
function statusLabel(r) {
  return (
    {
      held: "Needs review",
      approved:
        r.decision_mode === "automatic_exception"
          ? "Approved · exception"
          : "Approved",
      rejected: "Rejected",
      failed: "Couldn’t process",
      running: "Processing",
      queued: "Waiting",
    }[statusKey(r)] || "Waiting"
  );
}
function badge(r) {
  return `<span class="badge ${statusKey(r)}">${esc(statusLabel(r))}</span>`;
}
function raw(name) {
  return state.review?.fields?.[name]?.raw_value ?? "";
}
function human(text) {
  let result = String(text ?? "");
  for (const [key, label] of Object.entries(FIELD))
    result = result.replaceAll(key, label.toLowerCase());
  result = result.replaceAll(
    "Not stated on the document (or not found). Enter it if you can see it on the document; if it genuinely isn’t there, this may be a reason to reject.",
    "Not found. Enter the value shown on the invoice, or ask the supplier for a corrected copy.",
  );
  return result
    .replaceAll("vendor master", "supplier list")
    .replaceAll("attest", "confirm")
    .replaceAll("page above", "document")
    .replaceAll("pages above", "document")
    .replaceAll("below", "here");
}
function notice(message) {
  $("#notice").textContent = message;
  $("#notice").hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => ($("#notice").hidden = true), 4500);
}
class ApiError extends Error {
  constructor(message, status = 0, data = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}
// The server stamps every response with the frontend version it serves. A
// tab that has been open for hours (hash routing never reloads the page)
// would otherwise keep running old JavaScript against a newer server.
let loadedAppVersion = null;
let versionNoticeShown = false;
function checkAppVersion(version) {
  if (!version) return;
  if (loadedAppVersion === null) {
    loadedAppVersion = version;
    return;
  }
  if (version === loadedAppVersion || versionNoticeShown) return;
  // a live reading or an open quick-resolve session is work in progress too
  if (!unsaved() && !state.live && !state.resolve) {
    location.reload();
    return;
  }
  versionNoticeShown = true;
  notice("Invoice desk was updated. Save your work, then reload the page to get the new version.");
}
async function api(path, options = {}) {
  const timeout = options.timeout ?? 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const token = getToken();
    const headers = { ...(options.headers || {}) };
    if (token && !path.startsWith("/api/auth/login"))
      headers.Authorization = `Bearer ${token}`;
    const workspace = getWorkspace();
    if (workspace) headers["X-Workspace"] = workspace;
    const response = await fetch(path, {
      ...options,
      headers,
      signal: controller.signal,
    });
    checkAppVersion(response.headers.get("X-App-Version"));
    const data = await response.json().catch(() => null);
    if (response.status === 401) {
      // a stale stored role (or none): fall back to the reviewer workspace
      if (getToken() !== DEFAULT_ROLE) {
        setToken(DEFAULT_ROLE);
        switchRole(DEFAULT_ROLE);
      }
      throw new ApiError("The role could not be resolved. Reloading as invoice reviewer.", 401);
    }
    if (!response.ok) {
      const detail = data?.detail;
      const msg =
        typeof detail === "string"
          ? detail
          : Array.isArray(detail)
            ? detail.map((x) => `${x.loc.at(-1)}: ${x.msg}`).join(". ")
            : detail?.error ||
              (response.status >= 500
                ? `The server hit an error (${response.status}). Your last action may still have gone through — reload to check.`
                : "The request could not be completed.");
      throw new ApiError(msg, response.status, data);
    }
    return data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(
      e.name === "AbortError"
        ? "The connection timed out. Your request may still be processing."
        : "We couldn’t connect to Invoice desk. Check the connection and try again.",
    );
  } finally {
    clearTimeout(timer);
  }
}
function post(path, body = {}, options = {}) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...options,
  });
}
function errorHTML(message, action = "reload", label = "Try again") {
  return `<div class="error" role="alert"><p>${esc(message)}</p>${action ? `<button class="small" data-action="${action}">${label}</button>` : ""}</div>`;
}
function formError(container, error) {
  let box = container.querySelector(".action-error");
  if (!box) {
    box = document.createElement("div");
    box.className = "action-error";
    container.append(box);
  }
  box.innerHTML = errorHTML(
    error.status === 409 ? error.message : error.message,
    error.status === 409 ? "reload" : "",
    "Reload latest result",
  );
  box.scrollIntoView({ block: "nearest" });
}
async function confirmAction(title, message, label) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  $("#confirm-yes").textContent = label;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "confirm"),
      { once: true },
    ),
  );
}
function currentRows() {
  const parents = new Set(
    state.runs.map((r) => r.parent_run_id).filter(Boolean),
  );
  return state.runs.filter((r) => !parents.has(r.run_id));
}
function unsaved() {
  return [
    ...document.querySelectorAll(
      "[data-form]:not([data-form=login]) input:not([type=checkbox]), [data-form]:not([data-form=login]) textarea",
    ),
  ].some(
    (i) => i.value.trim() !== (i.dataset.original ?? i.defaultValue).trim(),
  );
}
function header(title, subtitle, action = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}
function uploadButton(text = "Upload invoice") {
  return isAdmin()
    ? ""
    : `<button class="primary" data-action="upload">${text}</button>`;
}
// The theme is the browser's preference, full stop: no switch, nothing stored.
// The attribute (not a media query) keeps every [data-theme="dark"] rule and the
// pre-paint script in index.html as they are; a change of preference while
// the page is open is picked up live.
// Held at module scope so the listener can never be collected with its list.
const SYSTEM_THEME = matchMedia("(prefers-color-scheme: dark)");
function followSystemTheme() {
  const query = SYSTEM_THEME;
  const apply = () => {
    const theme = query.matches ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "dark" ? "#0f151c" : "#f7f8fa";
  };
  apply();
  query.addEventListener("change", apply);
  try { localStorage.removeItem("theme"); } catch (e) {}  // a preference saved by the old switch
}
async function renderLanding() {
  // No sign-in screen: the reviewer workspace opens directly. This is only
  // reached when the server could not tell us who we are.
  state.route = "landing";
  document.body.classList.remove("welcome-screen");
  document.documentElement.classList.remove("onboarding-shell");
  applyRoleUI();
  $("#breadcrumb").textContent = "Invoice desk";
  $("#main").innerHTML =
    `<div class="landing"><div class="eyebrow">INVOICE DESK</div><h1>Couldn’t open the workspace</h1><p>${esc(state.sessionError || "The server did not respond.")}</p>${errorHTML("Check that the server is running, then try again.", "retry-session", "Try again")}</div>`;
}
const welcome = { tab: "upload", dataset: "messy", files: [], source: "gdrive", sources: [] };
const welcomeSources = [
  ["gdrive", "Google Drive"], ["gcs", "Google Cloud Storage"],
  ["link", "Public links"], ["folder", "Watched folder"],
];
async function welcomePage() {
  const generation = state.generation;
  $('#main').innerHTML = `<div class="invoice-start">
    <header><h1>Start with an invoice.</h1><p>AI reads each one, checks supplier and PO, and flags what needs you.</p></header>
    <div class="intake-tabs" role="tablist" aria-label="Invoice source"><button role="tab" id="upload-tab" aria-controls="welcome-intake" data-action="welcome-tab" data-tab="upload">Upload ZIP / PDFs</button><button role="tab" id="storage-tab" aria-controls="welcome-intake" data-action="welcome-tab" data-tab="storage">Connect storage</button></div>
    <section id="welcome-intake" role="tabpanel"></section>
    <div id="upload-error" role="alert"></div>
    <details class="welcome-samples" open><summary><span><strong>No invoices handy?</strong> Try a sample batch</span><span class="sample-chevron" aria-hidden="true">⌄</span></summary><div id="welcome-batches" aria-live="polite">Loading sample batches…</div></details>
    <a class="welcome-workspace" href="#dashboard">Open existing workspace →</a>
    </div>`;
  renderWelcomeIntake();
  try {
    const [samples, sources] = await Promise.all([api('/api/samples'), api('/api/sources').catch(() => [])]);
    if (generation !== state.generation) return;
    state.samples = samples;
    welcome.sources = sources;
    renderWelcomeBatches();
    if (welcome.tab === 'storage') renderWelcomeIntake();
  } catch(e) {
    if (generation === state.generation) $('#welcome-batches').innerHTML = errorHTML('Couldn’t load sample batches.', 'reload', 'Retry');
  }
}
function renderWelcomeIntake() {
  document.querySelectorAll('[data-action="welcome-tab"]').forEach(b => {
    b.setAttribute('aria-selected', String(b.dataset.tab === welcome.tab));
    b.tabIndex = b.dataset.tab === welcome.tab ? 0 : -1;
  });
  const panel = $('#welcome-intake');
  panel.setAttribute('aria-labelledby', welcome.tab === 'upload' ? 'upload-tab' : 'storage-tab');
  if (welcome.tab === 'upload') {
    panel.innerHTML = `<div class="start-drop" id="drop-zone"><div><b>Drop a ZIP or PDFs</b> or <label class="text-button" for="file-input" tabindex="0" role="button">browse</label><small>PDFs ≤ 10 MB / 10 pages · up to 25 per batch</small></div></div><div class="staged-files" aria-live="polite">${welcome.files.length ? `<span>${welcome.files.map(f => esc(f.name)).join(', ')}</span><button class="text-button" data-action="clear-staged">Clear</button>` : ''}</div><button class="primary start-process" data-action="process-staged" ${welcome.files.length ? '' : 'disabled'}>Process invoices <span aria-hidden="true">→</span></button>`;
    return;
  }
  const source = welcome.sources.find(s => s.kind === welcome.source);
  const label = welcomeSources.find(s => s[0] === welcome.source)[1];
  panel.innerHTML = `<div class="storage-options" role="group" aria-label="Storage provider">${welcomeSources.map(([kind, name]) => `<button aria-pressed="${kind === welcome.source}" data-action="welcome-source" data-kind="${kind}">${name}</button>`).join('')}</div>
    <div class="storage-connect"><div class="storage-scope">${esc(source?.scope || (welcome.source === 'link' ? 'Public PDF / ZIP or shared Google Drive file URL' : welcome.source === 'folder' ? 'Choose a folder to watch' : `${label} folder or bucket`))}</div><button data-action="welcome-connect">${source?.configured ? 'Browse' : 'Connect'}</button></div>
    <p class="storage-hint">${esc(source?.reason || (welcome.source === 'link' ? 'Import publicly accessible files using their links.' : welcome.source === 'folder' ? 'New files are picked up automatically from the watched folder.' : source?.configured ? 'Read-only access · select files to process.' : 'Connect a read-only service account to browse invoices.'))}</p>`;
}
function renderWelcomeBatches() {
  const bundles = ['clean', 'messy', 'multi-currency'].map(kind => state.samples.find(s => s.dataset === kind && s.members)).filter(Boolean);
  if (!bundles.length) {
    $('#welcome-batches').innerHTML = errorHTML('Sample batches are unavailable.', 'reload', 'Retry');
    return;
  }
  const selected = bundles.find(s => s.dataset === welcome.dataset) || bundles[0];
  welcome.dataset = selected.dataset;
  $('#welcome-batches').innerHTML = `<div class="batch-choices" role="group" aria-label="Sample batch">${bundles.map(b => `<button class="batch-choice" aria-pressed="${b === selected}" data-action="welcome-dataset" data-dataset="${esc(b.dataset)}"><span class="batch-choice-title">${esc(b.title)}<span class="choice-check" aria-hidden="true">${b === selected ? '✓' : ''}</span></span><span class="batch-description">${esc(b.blurb)}</span></button>`).join('')}</div><div class="sample-run-row"><button data-sample="${esc(selected.name)}">Run “${esc(selected.title)}” · ${selected.members.length} ${selected.dataset === 'messy' ? 'documents' : 'invoices'} <span aria-hidden="true">→</span></button><details class="sample-downloads"><summary>Download the ZIPs to upload yourself</summary><div>${bundles.map(b => `<a href="/api/samples/${encodeURIComponent(b.name)}/download" download>${esc(b.title)} ZIP ↓</a>`).join('')}</div></details></div>`;
}
function stageWelcomeFiles(files) {
  const chosen = Array.from(files || []);
  if (!chosen.length) return;
  const invalid = chosen.find(f => (!isPdfName(f.name) && !isZipName(f.name)) || !f.size || f.size > (isZipName(f.name) ? 60 : 10) * 1024 * 1024);
  if (invalid || chosen.length > 25) {
    intakeError(invalid ? `Cannot use ${invalid.name}. Choose nonempty PDFs up to 10 MB or ZIPs up to 60 MB.` : 'Choose up to 25 documents per batch.');
    return;
  }
  welcome.files = chosen;
  $('#upload-error').innerHTML = '';
  renderWelcomeIntake();
}
async function datasetPage(generation) {
  $('#main').innerHTML = `<div class="dataset-page"><div class="welcome-nav dataset-nav"><a class="welcome-brand" href="#home"><span class="brand-mark">i</span>Invoice desk</a></div><a class="back-link" href="#home">← Choose another way to start</a>${header('Select documents to process.', 'Upload the complete collection or choose individual PDFs below.')}<div id="dataset-content" aria-live="polite"><div class="skeleton" role="status">Loading documents…</div></div><section class="onboarding-upload" id="drop-zone" aria-label="Drop invoice PDFs or a ZIP archive"><div><h2>Upload your own documents</h2><p>Drop PDFs or a ZIP here, choose files from your computer, or import from cloud.</p><small>PDFs up to 10 MB / 10 pages each · up to 25 per batch</small></div><div class="upload-actions"><button class="primary" data-action="upload">Choose files</button><button data-action="cloud-import">Import from cloud</button></div></section><div id="upload-error" role="alert"></div></div>`;
  try {
    const [library, runs] = await Promise.all([api('/api/samples'), api('/api/runs').catch(() => [])]);
    if (generation !== state.generation) return;
    const bundle = library.find(s => s.onboarding && s.recommended && isZipName(s.name));
    const samples = library.filter(s => bundle?.members?.includes(s.name) && isPdfName(s.name));
    state.samples = library;
    const parents = new Set(runs.map(r => r.parent_run_id).filter(Boolean));
    const latest = runs.filter(r => !parents.has(r.run_id));
    const priorFor = sample => latest.find(r => r.filename === sample.name && r.run_status === 'completed');
    if (!bundle || !samples.length) {
      $('#dataset-content').innerHTML = errorHTML('The document collection is unavailable. Retry, or return to upload your own invoice.', 'reload', 'Retry collection');
      return;
    }
    $('#dataset-content').innerHTML = `<section class="starter-kit"><div class="kit-main"><span class="entry-tag kit-tag">RECOMMENDED</span><h2>Invoice collection</h2><p>${samples.length} PDF documents in one ZIP archive.</p><p class="kit-description">Submit the collection together. Each document is processed separately, with its details and status available in your workspace.</p></div><div class="kit-action"><span class="kit-file">ZIP / ${samples.length} PDFs</span><button class="primary" data-sample="${esc(bundle.name)}">Process collection →</button><small>No download required.</small></div></section>
    <div class="dataset-heading individual-heading"><div><h2>Documents in this collection</h2><p>Select individual files from the same archive.</p></div></div>
    <form data-form="sample-batch" class="starter-selection"><div class="sample-toolbar"><span class="muted" id="sample-count">Select documents to process together.</span><div class="button-row"><button type="button" class="small" data-action="sample-select-all">Select all</button><button type="submit" class="small primary" data-sample-submit disabled>Process selected</button></div></div><div class="starter-pdfs">${samples.map((entry,i) => {
      const prior = priorFor(entry);
      return `<article class="starter-pdf"><div class="starter-pdf-top"><label><input type="checkbox" name="names" value="${esc(entry.name)}"><span class="sr-only">Select ${esc(entry.title)}</span><span aria-hidden="true">PDF ${String(i+1).padStart(2,'0')}</span></label></div><h3>${esc(entry.title)}</h3><p>${esc(entry.blurb)}</p>${prior ? `<a class="button-link" href="#invoice/${encodeURIComponent(prior.run_id)}">View saved result →</a>` : `<button type="button" data-sample="${esc(entry.name)}">Process document →</button>`}</article>`;
    }).join('')}</div></form>`;
  } catch(e) {
    if (generation === state.generation) $('#dataset-content').innerHTML = errorHTML('The document collection could not load. Try again or return to upload your own invoice.', 'reload', 'Retry collection');
  }
}
async function route() {
  const generation = ++state.generation;
  if (!state.user) {
    await renderLanding();
    return;
  }
  let route = location.hash.slice(1) || (location.pathname === "/onboarding/dataset" ? "dataset" : location.pathname === "/app" ? (isAdmin() ? "queue" : "dashboard") : "home");
  const reviewDeepLink = route === "invoices?filter=review";
  if (reviewDeepLink) {
    route = "invoices";
    state.filter = isAdmin() ? "attention" : "review";
    state.search = "";
  }
  const onboarding = ["home", "dataset"].includes(route);
  if (onboarding && isAdmin()) {
    setToken("reviewer");
    await ensureSession();
    if (generation !== state.generation) return;
  }
  // Keep hash-based workspace navigation, but give onboarding its own URLs.
  // replaceState preserves live upload state while moving into the workspace.
  const canonicalURL = onboarding ? (route === "dataset" ? "/onboarding/dataset" : "/onboarding") : `/app#${route}${reviewDeepLink ? "?filter=review" : ""}`;
  if (location.pathname + location.hash !== canonicalURL) history.replaceState(null, "", canonicalURL);
  document.body.classList.toggle("welcome-screen", onboarding);
  document.documentElement.classList.toggle("onboarding-shell", onboarding);
  if (
    (route === "queue" && !isAdmin()) ||
    (route === "requests" && isAdmin())
  ) {
    location.hash = isAdmin() ? "queue" : "invoices";
    return;
  }
  state.route = route;
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const active =
      a.dataset.nav ===
      (route.startsWith("invoice/") || route.startsWith("invoices/") || route === "processing" || route.startsWith("batch")
        ? "invoices"
        : route.split("/")[0]);
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("#breadcrumb").textContent =
    (isAdmin() ? "Procurement / " : "Accounts payable / ") +
    (route.startsWith("invoice/")
      ? "Invoice details"
      : route.startsWith("batch")
        ? "Batch check"
        : {
          home: "Welcome",
          dataset: "Invoice dataset",
          invoices: "Invoices",
          dashboard: "Dashboard",
          pos: "Purchase orders",
          vendors: "Suppliers",
          activity: "Activity log",
          help: "Help",
          "edge-cases": "Edge cases",
          processing: "Processing",
          batch: "Batch",
          queue: "Requests",
          requests: "My requests",
        }[route] || "Invoices");
  $("#main").innerHTML = '<div class="skeleton" role="status">Loading…</div>';
  try {
    if (route === "home") welcomePage();
    else if (route === "dataset") await datasetPage(generation);
    else if (route === "invoices" || route === "dashboard") await inbox(generation);
    else if (route.startsWith("invoices/")) {
      state.search = decodeURIComponent(route.slice(9));
      state.filter = "all";
      await inbox(generation);
    } else if (route.startsWith("invoice/"))
      await detail(decodeURIComponent(route.slice(8)), generation);
    else if (route === "processing") renderLive();
    else if (route === "batch") renderBatch();
    else if (route.startsWith("batch/"))
      await openBatch(decodeURIComponent(route.slice(6)), generation);
    else if (route === "pos" || route === "vendors")
      await master(route, generation);
    else if (route.startsWith("pos/") || route.startsWith("vendors/")) {
      const [kind, id] = [route.split("/")[0], decodeURIComponent(route.slice(route.indexOf("/") + 1))];
      await master(kind, generation);
      focusRecord(`${kind === "pos" ? "po" : "vendor"}-${id}`);
    }
    else if (route === "activity") await activity(generation);
    else if (route === "queue" || route === "requests") await queue(generation);
    else if (route === "help") help();
    else if (route === "edge-cases") await edgeCases(generation);
    else {
      location.hash = "invoices";
    }
  } catch (e) {
    if (generation === state.generation)
      $("#main").innerHTML =
        `<a class="back-link" href="#invoices">← Back to invoices</a>${header("Couldn’t load this page", "Your saved invoices are unchanged.")}${errorHTML(e.message)}`;
  }
}
async function inbox(generation = state.generation) {
  const [runs, tickets, needs] = await Promise.all([
    api("/api/runs"),
    api("/api/tickets?status=all"),
    isAdmin() ? api("/api/queue/procurement").catch(() => []) : Promise.resolve([]),
  ]);
  if (generation !== state.generation) return;
  state.runs = runs;
  state.allTickets = tickets;
  // runs where procurement still owes something: a detected need or an open request
  const openDocs = new Set(tickets.filter((t) => t.status === "open").map((t) => t.document_id));
  state.procurementRuns = new Set([
    ...needs.map((n) => n.run_id),
    ...runs.filter((r) => openDocs.has(r.document_id)).map((r) => r.run_id),
  ]);
  if (state.route === "dashboard") {
    $("#main").innerHTML = '<div id="upload-error"></div><div id="ai-dashboard" class="dashboard-page"></div>';
    renderDashboard(currentRows());
    return;
  }
  $("#main").innerHTML =
    header(
      "Invoice review",
      isAdmin()
        ? "Look up an invoice and its decision. New work arrives in Requests."
        : "AI reads, matches and routes every invoice. Focus on the exceptions.",
      // Reviewers get no header action here: the upload zone directly below
      // already carries the primary one, and two upload buttons on one screen
      // is a choice the reader has to resolve for no benefit.
      isAdmin()
        ? '<a class="button-link primary" href="#queue">Open requests →</a>'
        : "",
    ) +
    `
  ${!isAdmin() ? `<section class="upload-zone" id="drop-zone" aria-label="Drop invoice PDFs or a ZIP archive"><div class="upload-icon" aria-hidden="true">↥</div><div><h2>Upload once. AI takes it from here.</h2><p>Drop PDFs or a ZIP of PDFs · automatic extraction, checks and procurement requests · up to 10 MB and 10 pages each, 25 per batch</p></div><div class="upload-actions"><button class="primary" data-action="upload">Choose files</button><button data-action="cloud-import">Other ways to add</button></div></section><details class="sample-details" id="sample-details"><summary>Invoice collection</summary><div class="samples" id="samples">Loading samples…</div></details>` : ""}
  <div id="upload-error"></div><section class="card"><div class="inbox-head"><div class="inbox-tools"><div class="filters" aria-label="Filter invoices"></div><input class="search" id="search" type="search" aria-label="Search invoices" placeholder="Search supplier or invoice…" value="${esc(state.search)}"></div></div><div id="invoice-table"></div></section><p class="footer-note">Your inbox keeps the latest result. Earlier reviews stay in the invoice’s activity.</p>`;
  renderRows();
  loadSamples();
}
// "Northwind Supplies LLC" then "Invoice #NW-1 · nw.pdf · 12 Sept". When the
// heading is already the file name — no supplier could be read — it is not
// repeated underneath it.
function detailSubtitle(d, summary) {
  const parts = [];
  if (summary.invoice_number) parts.push("Invoice #" + summary.invoice_number);
  if (summary.supplier_name) parts.push(d.filename);
  parts.push(date(d.created_at));
  return parts.join(" · ");
}
function confidenceBadge(c) {
  if (!c || c.score == null) return '<span class="confidence unavailable">Not scored</span>';
  return `<span class="confidence ${esc(c.band)}" title="${esc((c.reasons || []).join(' · '))}">${esc(c.band)} · ${c.score}/100</span>`;
}
// The score sits in the header beside the status badge; the evidence behind it
// is one click away rather than a card of its own.
function confidenceReasons(c) {
  if (!c || c.score == null || !(c.reasons || []).length) return '';
  return `<details class="confidence-why"><summary>How the reading was scored${c.score != null ? ` · ${c.score}/100` : ''}</summary><p>Based on extracted evidence and supplier / purchase-order checks. The score never overrides an approval rule.</p><ul>${c.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul></details>`;
}
function renderDashboard(rows) {
  const el = $('#ai-dashboard');
  if (!el) return;
  const stages = [
    ['approved', 'Approved', '#34866b'], ['review', 'Needs review', '#dc9a43'],
    ['waiting', 'With procurement', '#7b76cc'], ['ready', 'Ready to recheck', '#459db2'],
    ['rejected', 'Rejected', '#c97179'], ['processing', 'Processing', '#8794a7'],
  ].map(([key, label, color]) => ({key, label, color, count: rows.filter(r => workState(r).key === key).length}));
  const count = key => stages.find(s => s.key === key).count;
  const automatic = rows.filter(r => r.disposition === 'approved' && r.decision_mode !== 'reviewer').length;
  const attention = count('review') + count('ready');
  const rate = rows.length ? Math.round(automatic / rows.length * 100) : 0;
  const scored = rows.filter(r => Number.isFinite(r.confidence?.score));
  const avg = scored.length ? Math.round(scored.reduce((n, r) => n + r.confidence.score, 0) / scored.length) : null;
  $('#nav-count').textContent = isAdmin() ? '' : attention || '';
  let offset = 0;
  const segments = stages.map(s => { const start = offset; offset += rows.length ? s.count / rows.length * 100 : 0; return `${s.color} ${start}% ${offset}%`; });
  // Use the original upload date for a lineage, even after a later review.
  const byId = new Map(state.runs.map(r => [r.run_id, r]));
  const uploadedAt = r => { const seen = new Set(); while (r.parent_run_id && byId.has(r.parent_run_id) && !seen.has(r.run_id)) { seen.add(r.run_id); r = byId.get(r.parent_run_id); } return new Date(r.created_at); };
  const days = Array.from({length: 14}, (_, i) => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - 13 + i); return d; });
  const daily = days.map(d => { const end = new Date(d); end.setDate(end.getDate() + 1); const items = rows.filter(r => { const at = uploadedAt(r); return at >= d && at < end; }); return {d, total: items.length, outcomes: stages.map(stage => ({...stage, count: items.filter(r => workState(r).key === stage.key).length}))}; });
  const dailyDescription = day => `${day.d.toLocaleDateString()}: ${day.total} uploaded · ${day.outcomes.map(s => `${s.label}: ${s.count}`).join(' · ')}`;
  const peak = Math.max(1, ...daily.map(d => d.total));
  const periodTotal = daily.reduce((n,d) => n + d.total, 0);
  const priorities = rows.filter(r => ['review','ready'].includes(workState(r).key)).sort((a,b) => Number(workState(b).key === 'ready') - Number(workState(a).key === 'ready') || (a.confidence?.score ?? 101) - (b.confidence?.score ?? 101)).slice(0,4);
  const bands = [['high','High confidence','90–100','#34866b'],['medium','Medium confidence','70–89','#dc9a43'],['low','Low confidence','0–69','#c97179'],['unscored','Not scored','Awaiting evidence','#8794a7']];
  el.innerHTML = `
    <div class="dash-heading"><div><div class="eyebrow">INVOICE INTELLIGENCE</div><h1>Your invoice operations, at a glance.</h1><p>See what cleared, what’s moving, and where you can make a difference.</p></div><div class="dash-heading-actions"><span class="dash-live">Auto-refresh · 7s</span>${isAdmin() ? '<a class="button-link primary" href="#queue">Open requests →</a>' : ''}</div></div>
    <section class="dash-brief"><div class="dash-brief-symbol" aria-hidden="true">✦</div><div><span class="dash-kicker">WORKSPACE SUMMARY</span><h2>${!rows.length ? 'Ready for your first invoice.' : attention ? `${attention} invoice${attention === 1 ? '' : 's'} could use your attention.` : 'Your review queue is clear.'}</h2><p>${rows.length ? `${automatic} automatically approved · ${count('waiting')} with procurement · ${count('processing')} processing. Review the priorities below to keep invoices moving.` : 'Upload invoices to see real outcomes, confidence scores, and activity here.'}</p></div><a href="#invoices?filter=review" class="button-link">Open invoice review ↗</a></section>
    <div class="dash-section-label">WORKSPACE OVERVIEW <span>All time · latest result per invoice lineage</span></div>
    <section class="dash-metrics" aria-label="Invoice overview">
      ${[['Total invoices', rows.length, 'Across every workflow stage', '◫'],['Automatically approved', automatic, `${rate}% of all invoices`, '✓'],['Needs your attention', attention, `${count('ready')} ready to recheck`, '↗', '#invoices?filter=review'],['Average confidence', avg === null ? '—' : `${avg}<small>/100</small>`, `${scored.length} scored invoices · evidence based`, '✦']].map(([label,value,sub,icon,href]) => `<${href ? 'a' : 'article'} class="card dash-metric${href ? ' dash-metric-link' : ''}"${href ? ` href="${href}"` : ''}><div><span>${label}</span><i aria-hidden="true">${icon}</i></div><strong>${value}</strong><p>${sub}</p></${href ? 'a' : 'article'}>`).join('')}
    </section>
    <div class="dash-charts">
      <section class="card dash-panel"><div class="dash-panel-head"><div><h2>Invoice activity</h2><p>Uploads by day, grouped by their current outcome</p></div><span class="dash-chip">Last 14 days</span></div><div class="dash-chart-summary"><strong>${periodTotal}</strong><span>invoices received</span></div><div class="dash-chart-key" aria-label="Invoice activity outcomes">${stages.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('')}</div>
      <div class="dash-volume" role="img" aria-label="Daily invoice uploads over the last 14 days. ${esc(daily.map(dailyDescription).join('; '))}">${daily.map(d => `<div class="dash-day"><span class="dash-bar-value">${d.total || ''}</span><div class="dash-bar-track" title="${esc(dailyDescription(d))}"><div class="dash-bar" style="height:${d.total / peak * 100}%">${d.outcomes.filter(s => s.count).map(s => `<span style="height:${s.count / d.total * 100}%;background:${s.color}" title="${esc(s.label)}: ${s.count}"></span>`).join('')}</div></div><small>${d.d.getDate()}</small></div>`).join('')}</div><div class="dash-axis"><span>${days[0].toLocaleDateString(undefined,{month:'short',day:'numeric'})}</span><span>${periodTotal ? 'Daily upload count · local time' : 'No uploads in the last 14 days'}</span><span>Today</span></div></section>
      <section class="card dash-panel"><div class="dash-panel-head"><div><h2>Where invoices stand</h2><p>Every invoice, accounted for</p></div></div><div class="dash-outcomes"><div class="dash-donut" role="img" aria-label="${esc(stages.map(s => `${s.label}: ${s.count}`).join(', '))}" style="background:${rows.length ? `conic-gradient(${segments.join(',')})` : 'var(--track)'}"><div><strong>${rows.length}</strong><span>invoices</span></div></div><div class="dash-legend">${stages.map(s => `<div><i style="background:${s.color}"></i><span>${s.label}</span><strong>${s.count}</strong></div>`).join('')}</div></div></section>
    </div>
    <div class="dash-bottom">
      <section class="card dash-panel"><div class="dash-panel-head"><div><h2>Your next best actions</h2><p>Ready to recheck first, then lowest confidence</p></div><a href="#invoices">View invoices →</a></div><div class="dash-priorities">${priorities.length ? priorities.map(r => `<a class="dash-priority" href="#invoice/${encodeURIComponent(r.run_id)}"><span class="dash-file" aria-hidden="true">▤</span><div><strong>${esc(r.summary?.supplier_name || r.filename)}</strong><small>${esc(r.summary?.invoice_number || r.filename)} · ${esc(workState(r).label)}</small></div>${confidenceBadge(r.confidence)}<span aria-hidden="true">↗</span></a>`).join('') : '<div class="dash-clear"><span aria-hidden="true">✓</span><h3>No invoices need your review</h3><p>New exceptions and procurement replies will appear here.</p></div>'}</div></section>
      <section class="card dash-panel"><div class="dash-panel-head"><div><h2>How strong is the evidence?</h2><p>Confidence across your invoice collection</p></div></div><div class="dash-confidence">${bands.map(([key,label,range,color]) => { const n = rows.filter(r => key === 'unscored' ? !Number.isFinite(r.confidence?.score) : r.confidence?.band === key).length; return `<div><div><span>${label} <small>${range}</small></span><strong>${n}</strong></div><div class="dash-confidence-track"><span style="width:${rows.length ? n / rows.length * 100 : 0}%;background:${color}"></span></div></div>`; }).join('')}</div><p class="dash-note">Evidence scores reflect extracted fields and supplier / PO checks. Approval also depends on budget, duplicate, and policy checks.</p></section>
    </div>`;
}

function workState(r) {
  return InvoiceWorkflow.workState(r, state.allTickets || []);
}
function renderRows() {
  const rows = currentRows().sort((a, b) => Number(b.confidence?.band === "low" && b.disposition === "held") - Number(a.confidence?.band === "low" && a.disposition === "held"));
  const count = (k) => rows.filter((r) => workState(r).key === k).length;
  $("#nav-count").textContent = isAdmin()
    ? ""
    : count("review") + count("ready") || "";
  const filters = isAdmin()
    ? [
        ["all", "All invoices", rows.length],
        [
          "procurement",
          "Needs procurement",
          rows.filter((r) => r.disposition === "held" && state.procurementRuns?.has(r.run_id)).length,
        ],
        [
          "attention",
          "With reviewer",
          rows.filter((r) => r.disposition === "held" && !state.procurementRuns?.has(r.run_id)).length,
        ],
        ["approved", "Approved", count("approved")],
        ["rejected", "Rejected", count("rejected")],
      ]
    : [
        ["all", "All", rows.length],
        ["review", "To review", count("review")],
        ["waiting", "With procurement", count("waiting")],
        ["ready", "Ready to recheck", count("ready")],
      ];
  filters.push(["low", "Low confidence", rows.filter(r => r.confidence?.band === "low").length]);
  if (!filters.some((f) => f[0] === state.filter)) state.filter = "all";
  $(".filters").innerHTML = filters
    .map(
      ([key, label, n]) =>
        `<button class="filter ${state.filter === key ? "active" : ""}" data-filter="${key}" aria-pressed="${state.filter === key}">${label}<span>${n}</span></button>`,
    )
    .join("");
  const filtered = rows.filter(
    (r) =>
      (state.filter === "all" ||
        (state.filter === "low" ? r.confidence?.band === "low" : state.filter === "attention"
          ? r.disposition === "held" && !state.procurementRuns?.has(r.run_id)
          : state.filter === "procurement"
            ? r.disposition === "held" && state.procurementRuns?.has(r.run_id)
            : workState(r).key === state.filter)) &&
      [r.filename, ...Object.values(r.summary || {})]
        .join(" ")
        .toLowerCase()
        .includes(state.search.toLowerCase()),
  );
  $("#invoice-table").innerHTML = filtered.length
    ? `<div class="table-scroll"><table><thead><tr><th>Invoice</th><th class="amount">Amount</th><th>${isAdmin() ? "Decision" : "Where it stands"}</th><th>AI confidence</th><th class="col-date">Updated</th><th>Next step</th></tr></thead><tbody>${filtered
        .map((r) => {
          const summary = { ...(r.summary || {}), ...Object.fromEntries(Object.entries(r.display || {}).filter(([, v]) => v)) },
            w = workState(r);
          return `<tr><td><a class="invoice-link" href="#invoice/${encodeURIComponent(r.run_id)}">${esc(summary.supplier_name || r.filename)}</a><small class="invoice-sub">${esc(summary.invoice_number ? "#" + summary.invoice_number + " · " + r.filename : r.filename)}</small></td><td class="amount">${summary.invoice_gross_total ? `${esc(r.display?.invoice_gross_total || summary.invoice_gross_total)}${r.display?.invoice_gross_total && !r.display?.currency ? '<small class="muted-line">currency not confirmed</small>' : ""}` : "—"}</td><td>${isAdmin() ? badge(r) : `<span class="badge work-${w.key}">${esc(w.label)}</span>`}</td><td>${confidenceBadge(r.confidence)}</td><td class="col-date"><small>${esc(date(r.finished_at || r.created_at))}</small></td><td><a class="row-action" href="#invoice/${encodeURIComponent(r.run_id)}"${resolvable(r) ? ` data-resolve-open="${esc(r.run_id)}"` : ""}>${isAdmin() ? (r.disposition === "held" ? (state.procurementRuns?.has(r.run_id) ? "Resolve" : "With reviewer") : "View details") : resolvable(r) ? "Resolve" : w.action} →</a></td></tr>`;
        })
        .join("")}</tbody></table></div>`
    : `<div class="empty"><h3>${state.search ? "No matching invoices" : state.filter === "waiting" ? "Nothing is waiting on procurement" : state.filter === "ready" ? "No replies to act on yet" : rows.length ? "You’re up to date" : "Your inbox is ready"}</h3><p>${state.search ? "Try a supplier, invoice number or filename." : !rows.length ? (isAdmin() ? "Invoices will appear when a reviewer uploads them." : "Add a PDF invoice to get started.") : "Invoices for this stage will appear here."}</p></div>`;
}
async function loadSamples() {
  if (!$("#samples")) return;
  try {
    state.samples = await api("/api/samples");
    if ($("#samples")) $("#samples").innerHTML = sampleLibraryHTML(state.samples);
  } catch (e) {
    if ($("#samples"))
      $("#samples").textContent =
        "Samples are unavailable. You can still upload a PDF.";
  }
}
// The sample library is grouped by the situation each file demonstrates.
// One click runs a single PDF live; tick several (or a ZIP) to run a batch.
const EXPECT_LABEL = {
  approved: ["approved", "Approves"],
  held: ["held", "Needs review"],
  rejected: ["rejected", "Rejected"],
  failed: ["failed", "Can’t process"],
  mixed: ["queued", "Mixed"],
  varies: ["queued", "Varies"],
};
function sampleLibraryHTML(samples, priorRuns = []) {
  if (!samples.length)
    return "No samples available. Choose a PDF from your computer.";
  const groups = new Map();
  samples.forEach((s) => {
    const key = s.category || "Other samples";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });
  return `<form data-form="sample-batch" class="sample-library"><div class="sample-toolbar"><span class="muted" id="sample-count">Choose one invoice to process, or select up to 25 for a batch.</span><div class="button-row"><button type="button" class="small" data-action="sample-select-all">${samples.length > 25 ? "Select first 25" : "Select all"}</button><button type="submit" class="small primary" data-sample-submit disabled>Process selected</button></div></div>${[...groups]
    .map(
      ([cat, list]) =>
        `<section class="sample-group"><h3>${esc(cat)}</h3><ul>${list
          .map((s) => {

            const zip = isZipName(s.name);
            const prior = priorRuns.find(r => r.filename === s.name && r.run_status === "completed");
            return `<li class="sample-row"><label class="sample-pick"><input type="checkbox" name="names" value="${esc(s.name)}"><span class="sample-title">${esc(s.title || s.name)}</span></label><p class="sample-blurb">${esc(s.blurb || "")}</p>${prior ? `<a class="button-link small" href="#invoice/${encodeURIComponent(prior.run_id)}">View saved result</a>` : `<button type="button" class="small" data-sample="${esc(s.name)}" title="${esc(s.name)}">${zip ? "Run bundle" : "Process invoice"}</button>`}</li>`;
          })
          .join("")}</ul></section>`,
    )
    .join("")}</form>`;
}
function updateSampleSelection(form) {
  const count = form.querySelectorAll('input[name=names]:checked').length;
  form.querySelector('#sample-count').textContent = count ? `${count} selected · up to 25 PDFs per batch` : 'Choose one invoice to process, or select up to 25 for a batch.';
  const submit = form.querySelector('[data-sample-submit]');
  submit.disabled = !count || count > 25;
  submit.textContent = count ? `Process ${count} selected` : 'Process selected';
}
function runSamplesBatch(names) {
  if (names.length > 25) { notice("Choose up to 25 PDFs per batch."); return; }
  if (!names.length) {
    notice("Tick at least one sample first.");
    return;
  }
  startBatchView(`${names.length} sample${names.length === 1 ? "" : "s"}`, () =>
    post("/api/samples/run-batch", { names }, { timeout: 180000 }),
  );
}
function intakeError(message) {
  const target = $("#upload-error") || $("#live-errors") || $("#main");
  target.innerHTML = errorHTML(message, "upload", "Choose files");
}
function isZipName(name) {
  return name.toLowerCase().endsWith(".zip");
}
function isPdfName(name) {
  return name.toLowerCase().endsWith(".pdf");
}
// Entry point for the file picker, the drop zone and the sample library.
// One PDF keeps the single live progress card; anything else (several PDFs,
// a ZIP, a mix) becomes a batch.
async function upload(fileOrFiles) {
  const files = Array.from(
    fileOrFiles instanceof File ? [fileOrFiles] : fileOrFiles || [],
  );
  if (!files.length) return;
  const bad = files.filter((f) => !isPdfName(f.name) && !isZipName(f.name));
  if (bad.length === files.length) {
    intakeError(
      "Choose PDF invoices or a ZIP archive of PDFs. Other file types aren’t supported.",
    );
    return;
  }
  if (bad.length)
    notice(
      `Left out (not PDF or ZIP): ${bad.map((f) => f.name).join(", ")}`,
    );
  const usable = files.filter((f) => isPdfName(f.name) || isZipName(f.name));
  if (usable.length === 1 && isPdfName(usable[0].name)) {
    uploadSingle(usable[0]);
    return;
  }
  uploadBatch(usable);
}
function uploadSingle(file) {
  if (state.live && !state.live.finished) {
    notice("An invoice is already processing. You can follow its progress.");
    location.hash = "processing";
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    intakeError(
      "This PDF is larger than 10 MB. Compress it or ask for a smaller copy, then upload it again.",
    );
    return;
  }
  if (!file.size) {
    intakeError("This file is empty. Choose a readable PDF invoice.");
    return;
  }
  const fd = new FormData();
  fd.append("file", file);
  beginLive(file.name, () =>
    api("/api/invoices", { method: "POST", body: fd, timeout: 180000 }),
  );
}
// ---- batches: many PDFs or a ZIP -------------------------------------------
// The server validates and expands the upload, then processes each document
// in the background. We only poll the batch record; every finished document
// is an ordinary run in the inbox.
function startBatchView(label, request) {
  state.batch = { label, sending: true, data: null, error: null, pollErrors: 0 };
  const mine = state.batch;
  location.hash = "batch";
  renderBatch();
  request()
    .then((data) => {
      if (state.batch !== mine) return;
      mine.sending = false;
      mine.data = data;
      location.hash = `batch/${encodeURIComponent(data.batch_id)}`;
      pollBatch(mine);
    })
    .catch((e) => {
      if (state.batch !== mine) return;
      mine.sending = false;
      mine.error = e.message;
      if (state.route.startsWith("batch")) renderBatch();
    });
}
function uploadBatch(files) {
  const tooBig = files.filter(
    (f) => f.size > (isZipName(f.name) ? 60 : 10) * 1024 * 1024,
  );
  if (tooBig.length) {
    intakeError(
      `Too large to upload: ${tooBig.map((f) => f.name).join(", ")}. PDFs may be up to 10 MB and ZIP archives up to 60 MB.`,
    );
    return;
  }
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  startBatchView(
    files.length === 1 ? files[0].name : `${files.length} files`,
    () =>
      api("/api/invoices/batch", {
        method: "POST",
        body: fd,
        timeout: 180000,
      }),
  );
}
async function pollBatch(batch) {
  if (state.batch !== batch || !batch.data) return;
  if (batch.data.status === "done") {
    if (state.route.startsWith("batch")) renderBatch();
    return;
  }
  try {
    batch.data = await api(
      `/api/batches/${encodeURIComponent(batch.data.batch_id)}`,
    );
    batch.error = null;
    batch.pollErrors = 0;
  } catch (e) {
    batch.pollErrors++;
    if (e.status === 404) {
      batch.error =
        "This batch is no longer tracked (the server may have restarted). Finished invoices are in the inbox.";
      batch.data.status = "done";
    } else if (batch.pollErrors >= 3)
      batch.error =
        "Connection interrupted. We’ll keep checking. Finished invoices already appear in the inbox.";
  }
  if (state.route.startsWith("batch")) renderBatch();
  if (batch.data.status === "done") {
    if (!state.route.startsWith("batch"))
      notice("Your batch has finished. Results are in Invoices.");
    return;
  }
  setTimeout(() => pollBatch(batch), 1200);
}
async function openBatch(id, generation) {
  if (state.batch?.data?.batch_id === id) {
    renderBatch();
    if (state.batch.data.status !== "done") pollBatch(state.batch);
    return;
  }
  const data = await api(`/api/batches/${encodeURIComponent(id)}`);
  if (generation !== state.generation) return;
  state.batch = {
    label: `${data.total} files`,
    sending: false,
    data,
    error: null,
    pollErrors: 0,
  };
  renderBatch();
  if (data.status !== "done") pollBatch(state.batch);
}
function batchItemStatus(item) {
  if (item.status === "skipped") return ["skipped", "Skipped"];
  if (item.status === "failed") return ["failed", "Couldn’t process"];
  if (item.status === "running") return ["running", "Checking…"];
  if (item.status === "queued") return ["queued", "Waiting"];
  const key =
    {
      AUTO_APPROVE: "approved",
      APPROVE_WITH_EXCEPTION: "approved",
      HOLD_REVIEW: "held",
      REJECT: "rejected",
    }[item.route] || "done";
  const label =
    {
      AUTO_APPROVE: "Approved",
      APPROVE_WITH_EXCEPTION: "Approved · exception",
      HOLD_REVIEW: "Needs review",
      REJECT: "Rejected",
    }[item.route] || "Done";
  return [key, label];
}
function renderBatch() {
  if (!state.route.startsWith("batch")) return;
  const b = state.batch;
  if (!b) {
    $("#main").innerHTML =
      header(
        "No batch is processing",
        "Upload several PDFs or a ZIP to get started.",
        uploadButton("Choose files"),
      ) + '<a href="#invoices">Back to invoices</a>';
    return;
  }
  const d = b.data;
  const counts = d?.counts || {};
  const finished = (counts.done || 0) + (counts.failed || 0);
  const toDo = (d?.total || 0) - (counts.skipped || 0);
  const done = d?.status === "done";
  const title = b.sending
    ? "Uploading your files"
    : b.error && !d
      ? "We couldn’t start this batch"
      : done
        ? "Your batch is complete"
        : "Checking your invoices";
  const sub = b.sending
    ? `${esc(b.label)} · validating and unpacking`
    : d
      ? `${finished} of ${toDo} document${toDo === 1 ? "" : "s"} checked${counts.skipped ? ` · ${counts.skipped} skipped` : ""}`
      : esc(b.label);
  const pct = toDo ? Math.round((finished / toDo) * 100) : 0;
  const rows = (d?.items || [])
    .map((it) => {
      const [cls, label] = batchItemStatus(it);
      const quick = it.route === "HOLD_REVIEW" && !isAdmin();
      const link = it.run_id
        ? `<a class="button-link small" href="#invoice/${encodeURIComponent(it.run_id)}"${quick ? ` data-resolve-open="${esc(it.run_id)}" data-resolve-batch="${esc(d?.batch_id || "")}"` : ""}>${it.route === "HOLD_REVIEW" ? (quick ? "Resolve" : "Review") : "Open"} →</a>`
        : "";
      const meta = [
        it.source.startsWith("zip:") ? `from ${esc(it.source.slice(4))}` : "",
        it.reason ? esc(it.reason) : "",
        it.status === "done" && it.explanation ? esc(it.explanation) : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `<li class="batch-row ${cls}"><span class="badge ${cls}">${label}</span><div class="batch-main"><b>${esc(it.filename)}</b>${meta ? `<p>${meta}</p>` : ""}</div>${link}</li>`;
    })
    .join("");
  const heldItems = (d?.items || []).filter((it) => it.route === "HOLD_REVIEW" && it.run_id);
  $("#main").innerHTML = `<div class="reading-wrap batch-wrap"><a href="#invoices" class="back-link">← Back to invoices${!done && d ? " · processing continues" : ""}</a><section class="card reading-card"><div class="eyebrow">BATCH CHECK</div><h1>${title}</h1><p class="reading-file">${sub}</p>${d ? `<div class="batch-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>` : ""}<div id="live-errors">${b.error ? errorHTML(b.error, "inbox", "Back to invoices") : ""}</div>${rows ? `<ul class="batch-list">${rows}</ul>` : ""}${done ? `<div class="reading-result"><p>${counts.done ? `${counts.done} document${counts.done === 1 ? "" : "s"} checked.` : ""} ${counts.failed ? `${counts.failed} couldn’t be read — open them for recovery options.` : ""} ${heldItems.length && !isAdmin() ? `${heldItems.length} need${heldItems.length === 1 ? "s" : ""} a decision from you — resolve them one after another without leaving this batch.` : "Open the dashboard for confidence scores and review items."} Automatic procurement requests are in My requests.</p><div class="button-row">${heldItems.length && !isAdmin() ? `<a class="button-link primary" href="#invoice/${encodeURIComponent(heldItems[0].run_id)}" data-resolve-open="${esc(heldItems[0].run_id)}" data-resolve-batch="${esc(d.batch_id)}">Resolve ${heldItems.length} invoice${heldItems.length === 1 ? "" : "s"} →</a><a class="button-link" href="#dashboard">See results in dashboard →</a>` : `<a class="button-link primary" href="#dashboard">See results in dashboard →</a>`}<a class="button-link" href="#requests">View procurement requests</a></div></div>` : d ? '<p class="reading-foot">You can leave this page. Each result appears in your inbox as it finishes.</p>' : ""}</section></div>`;
}
// ---- cloud import (Google Drive / Cloud Storage) -----------------------------
// The server reports whether each source is connected. When it is not, the
// modal explains what a deployment needs; when it is, files in the configured
// folder/bucket can be picked and imported as a batch.
async function cloudImportModal(kind = null) {
  openModal({
    title: "Other ways to add invoices",
    subtitle: "Every route ends in the same checks as an upload.",
    body: '<p class="muted">Checking connections…</p>',
  });
  let sources;
  try {
    sources = await api("/api/sources");
  } catch (e) {
    $("#modal-body").innerHTML = errorHTML(e.message, "");
    return;
  }
  const row = (s) => {
    let status, action;
    if (s.mode === "links") {
      status = "Ready · paste Google Drive “anyone with the link”, public Cloud Storage or any https link";
      action = `<form data-form="source-import" data-kind="link" class="link-form"><textarea name="urls" rows="3" placeholder="One link per line" aria-label="Links to PDF or ZIP files"></textarea><div class="button-row"><button class="small primary" type="submit">Import links</button></div><div class="action-error"></div></form>`;
    } else if (s.mode === "folder") {
      status = `${s.remote ? "Watching a shared Google Drive folder" : "Watching a folder on this machine"} · checked every ${s.poll_seconds}s · ${s.pending ? `<b>${s.pending} new</b>` : "nothing new"} · ${s.picked_up} picked up since start${s.reason ? ` · <span class="error-text">${esc(s.reason)}</span>` : ""}`;
      action = `<form data-form="folder-settings" class="folder-form"><label class="folder-label">Folder to watch — a Google Drive folder link or a path on this machine<input name="dir" type="text" value="${esc(s.scope)}" spellcheck="false" placeholder="https://drive.google.com/drive/folders/… or /Users/you/Dropbox/Invoices"></label><div class="button-row"><button class="small primary" type="submit">Save folder</button><button class="small" type="button" data-action="browse-source" data-kind="folder">${s.pending ? "See waiting files" : "Refresh"}</button>${s.pending ? '<button class="small" type="button" data-action="import-folder-all">Import all now</button>' : ""}</div><div class="action-error"></div></form>`;
    } else if (s.configured) {
      status = `Connected · ${esc(s.scope)}`;
      action = `<button class="small primary" data-action="browse-source" data-kind="${esc(s.kind)}">Browse</button>`;
    } else {
      status = `Not connected · ${esc(s.reason)}`;
      action = '<span class="badge queued">Not connected</span>';
    }
    const inline = s.mode === "links" || s.mode === "folder";
    return `<li class="source-row"><div class="source-main"><b>${esc(s.label)}</b><p>${status}</p>${inline ? action : ""}${!s.configured || s.mode === "folder" ? `<details class="compact-details"><summary>${s.configured ? "How it works" : "How to connect"}</summary><ol class="source-setup">${s.setup.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></details>` : ""}</div>${inline ? "" : `<div class="source-action">${action}</div>`}</li>`;
  };
  $("#modal-body").innerHTML = `<ul class="source-list">${sources.filter(s => !kind || s.kind === kind).map(row).join("") || '<li class="source-row">This connection is unavailable. Refresh the page to check again.</li>'}</ul><p class="muted source-foot">Files from any connector go through the same identity, duplicate and policy checks as an upload, and appear in the inbox one by one. Google Drive, Cloud Storage and mailbox connections are deployment settings (a service account or app password), not something a reviewer does here.</p>`;
}
async function browseSource(kind) {
  $("#modal-body").innerHTML = '<p class="muted">Listing files…</p>';
  let files;
  try {
    files = await api(`/api/sources/${encodeURIComponent(kind)}/files`, {
      timeout: 60000,
    });
  } catch (e) {
    $("#modal-body").innerHTML = errorHTML(e.message, "cloud-import", "Back");
    return;
  }
  if (!files.length) {
    $("#modal-body").innerHTML =
      `<p class="muted modal-empty">${kind === "folder" ? "Nothing is waiting in the folder. Drop PDFs or ZIPs in and they are picked up automatically." : "No PDF or ZIP files in the configured location."}</p><div class="button-row"><button type="button" class="small" data-action="cloud-import">Back</button></div>`;
    return;
  }
  $("#modal-body").innerHTML = `<form data-form="source-import" data-kind="${esc(kind)}"><ul class="record-list source-files">${files
    .map(
      (f) =>
        `<li class="record-row"><label><input type="checkbox" name="ids" value="${esc(f.id)}" checked> ${esc(f.name)}</label><span class="record-meta">${f.from ? `${esc(f.from)} · ` : ""}${(f.size / 1024 / 1024).toFixed(1)} MB${f.modified ? ` · ${esc(date(f.modified))}` : ""}</span></li>`,
    )
    .join("")}</ul><div class="button-row"><button class="primary" type="submit">Import selected</button><button type="button" data-action="cloud-import">Back</button></div><div class="action-error"></div></form>`;
}
async function submitSourceImport(form) {
  const kind = form.dataset.kind;
  const body = {};
  let count;
  if (kind === "link") {
    body.urls = (form.querySelector("textarea[name=urls]")?.value || "")
      .split(/\s+/)
      .map((u) => u.trim())
      .filter(Boolean);
    count = body.urls.length;
    if (!count) {
      form.querySelector(".action-error").innerHTML = errorHTML("Paste at least one link.", "");
      return;
    }
  } else {
    body.ids = [...form.querySelectorAll("input[name=ids]:checked")].map((i) => i.value);
    count = body.ids.length;
    if (!count) {
      form.querySelector(".action-error").innerHTML = errorHTML("Choose at least one file.", "");
      return;
    }
  }
  closeModal();
  const label = { link: "link", folder: "file from the watched folder", mail: "e-mail" }[kind] || "file from cloud";
  startBatchView(`${count} ${label}${count === 1 ? "" : "s"}`, () =>
    post(`/api/sources/${encodeURIComponent(kind)}/import`, body, { timeout: 180000 }),
  );
}
async function saveFolderSettings(form, body) {
  const payload = body || { dir: form.querySelector("input[name=dir]").value };
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const st = await post("/api/sources/folder/settings", payload);
    notice(`Now watching ${st.scope}`);
    cloudImportModal();
  } catch (e) {
    form.querySelector(".action-error").innerHTML = errorHTML(e.message, "");
    button.disabled = false;
  }
}
function importFolderAll() {
  closeModal();
  startBatchView("everything waiting in the folder", () =>
    post("/api/sources/folder/import", { ids: [] }, { timeout: 180000 }),
  );
}
async function beginLive(filename, request) {
  if (state.live && !state.live.finished) {
    location.hash = "processing";
    return;
  }
  const live = {
    filename,
    started: Date.now(),
    runId: null,
    finished: false,
    detail: null,
    error: null,
    known: new Set(),
    pollErrors: 0,
  };
  state.live = live;
  try {
    const runs = await api("/api/runs");
    live.known = new Set(runs.map((r) => r.run_id));
  } catch (e) {
    live.error = e.message;
    live.finished = true;
    location.hash = "processing";
    renderLive();
    return;
  }
  location.hash = "processing";
  renderLive();
  request()
    .then((data) => {
      live.runId = data.run_id;
      live.requestDone = true;
    })
    .catch((e) => {
      const id = e.data?.detail?.run_id;
      if (id) {
        live.runId = id;
        live.requestDone = true;
      } else {
        live.error = e.message;
        live.requestDone = true;
      }
    });
  pollLive(live);
}
async function pollLive(live) {
  if (state.live !== live || live.finished) return;
  try {
    if (!live.runId) {
      const runs = await api("/api/runs");
      const candidate = runs.find(
        (r) => !live.known.has(r.run_id) && r.filename === live.filename,
      );
      if (candidate) live.runId = candidate.run_id;
    }
    if (live.runId) {
      live.detail = await api(`/api/runs/${encodeURIComponent(live.runId)}`);
      // A provisional filename match provides progress only. Wait for this
      // request's authoritative run ID before presenting its terminal result.
      live.finished =
        live.requestDone &&
        !["running", "queued"].includes(live.detail.run_status);
      live.error = null;
    } else if (live.requestDone && live.error) live.finished = true;
    live.pollErrors = 0;
  } catch (e) {
    live.pollErrors++;
    if (live.pollErrors >= 3)
      live.error =
        "Connection interrupted. We’ll keep checking for your result. You can also return to the inbox.";
  }
  if (Date.now() - live.started > 210000 && !live.finished) {
    live.error =
      "This is taking longer than expected. Return to the inbox to check the latest status before uploading again.";
    live.finished = true;
  }
  if (state.route === "processing") renderLive();
  if (live.finished) {
    if (live.detail && state.route !== "processing")
      notice("Your invoice result is ready in Invoices.");
    return;
  }
  setTimeout(() => pollLive(live), 900);
}
function renderLive() {
  if (state.route !== "processing") return;
  const l = state.live;
  if (!l) {
    $("#main").innerHTML =
      header(
        "No invoice is processing",
        "Upload a PDF to get started.",
        uploadButton(),
      ) + '<a href="#invoices">Back to invoices</a>';
    return;
  }
  const events = l.detail?.events ?? [];
  const extracted = events.some((e) => e.event_type === "fields");
  const decided = events.some((e) => e.event_type === "decision");
  const classified = events.some((e) => e.event_type === "classified");
  const phase = extracted ? 1 : 0;
  const stopped = l.finished;
  const steps = [
    [
      "Read the invoice",
      classified
        ? "Finding the supplier, amounts and invoice details."
        : "Opening the PDF and checking that it can be read.",
    ],
    [
      "Check the details",
      "Compare the invoice with the supplier and purchase order.",
    ],
    ["Save the result", "Approve eligible invoices or flag what needs review."],
  ];
  $("#main").innerHTML =
    `<div class="reading-wrap"><a href="#invoices" class="back-link">← Back to invoices${!stopped ? " · processing continues" : ""}</a><section class="card reading-card"><div class="eyebrow">INVOICE CHECK</div><h1>${stopped ? (l.error ? "We couldn’t get a result" : l.detail?.run_status === "failed" ? "This PDF needs your attention" : "Your invoice check is complete") : "Checking your invoice"}</h1><p class="reading-file">${esc(l.filename)}</p><div>${steps
      .map(([title, desc], i) => {
        const done = decided || (i === 0 && extracted);
        const cls = done
          ? "done"
          : !stopped && i === phase
            ? "running"
            : "pending";
        return `<div class="progress-step ${cls}"><span class="progress-icon">${done ? "✓" : i + 1}</span><div><h3>${title}</h3><p>${desc}</p></div></div>`;
      })
      .join(
        "",
      )}</div><div id="live-errors">${l.error ? errorHTML(l.error, "inbox", "Back to invoices") : ""}</div>${stopped && l.detail ? `<div class="reading-result">${badge(l.detail)}<p>${l.detail.disposition === "approved" ? "This invoice is approved. No further review is needed." : l.detail.disposition === "held" ? "We need your help with a few details. Open the invoice to see what to do next." : l.detail.run_status === "failed" ? "We couldn’t read this PDF. Open the invoice for recovery options." : (l.detail.snapshot?.codes ?? []).includes("UNSUPPORTED_DOCUMENT_TYPE") ? "This file was rejected as not an invoice. No review is required. Open it to see what we found." : "Open the result to see why this invoice was rejected."}</p><a class="button-link primary" href="#invoice/${encodeURIComponent(l.runId)}">${l.detail.disposition === "held" ? "Review invoice" : "View result"} →</a></div>` : !stopped ? '<p class="reading-foot">You can leave this page. The result will appear in your inbox.</p>' : ""}</section></div>`;
}
async function detail(id, generation) {
  const d = await api(`/api/runs/${encodeURIComponent(id)}`);
  if (generation !== state.generation) return;
  if (["running", "queued"].includes(d.run_status)) {
    if (!state.live || state.live.runId !== id) {
      state.live = {
        filename: d.filename,
        started: Date.now(),
        runId: id,
        finished: false,
        detail: d,
        known: new Set(),
        pollErrors: 0,
        requestDone: true,
      };
      pollLive(state.live);
    }
    location.hash = "processing";
    return;
  }
  const [rv, pos, runs, vendors, tickets] = await Promise.all([
    api(`/api/runs/${encodeURIComponent(id)}/review`).catch((e) => {
      if (e.status === 404) return null;
      throw e;
    }),
    api("/api/pos"),
    api("/api/runs"),
    api("/api/vendors"),
    api(
      `/api/tickets?status=all&document_id=${encodeURIComponent(d.document_id)}`,
    ),
  ]);
  if (generation !== state.generation) return;
  state.tickets = tickets;
  state.detail = d;
  state.review = rv;
  state.pos = pos;
  state.runs = runs;
  $("#nav-count").textContent =
    currentRows().filter((r) => ["held", "failed"].includes(statusKey(r)))
      .length || "";
  state.vendors = vendors;
  state.doc = null;
  state.page = 1;
  state.selectedField = null;
  const dec = d.events
    .filter((e) => e.event_type === "decision")
    .at(-1)?.payload;
  const key = statusKey(d);
  const noReading = !rv && (key === "held" || key === "failed");
  const items = rv?.diagnosis?.items ?? [];
  const open = items.filter((i) => i.status !== "resolved");
  // A held result that came from "Check again" (a review run) means these
  // blockers survived a full re-check. Mark the ones the previous result
  // already reported so they read as red — "still unresolved" — not amber.
  const rechecked = d.kind === "review" && key === "held" && !!rv;
  let persistent = new Set();
  if (rechecked) {
    persistent = new Set(open.map((i) => i.code));
    if (d.parent_run_id) {
      try {
        const parent = await api(
          `/api/runs/${encodeURIComponent(d.parent_run_id)}`,
        );
        const before = new Set(
          parent.events.filter((e) => e.event_type === "decision").at(-1)
            ?.payload?.codes ?? [],
        );
        if (before.size)
          persistent = new Set([...persistent].filter((c) => before.has(c)));
      } catch (e) {
        /* parent unavailable: treat every open item as persistent */
      }
    }
  }
  state.persistent = persistent;
  const fields = rv?.fields ?? {};
  const s = Object.fromEntries(
    Object.entries(fields).map(([name, rec]) => [name, rv?.display?.[name] || rec.raw_value]),
  );
  const curr = s.currency || rv?.context?.currency?.code || "";
  const child = runs.find((r) => r.parent_run_id === id);
  const postedRelated = runs.find(
    (r) => r.document_id === d.document_id && r.disposition === "approved",
  );
  const decisionCodes = new Set(dec?.codes ?? []);
  const notInvoice =
    key === "rejected" && decisionCodes.has("UNSUPPORTED_DOCUMENT_TYPE");
  let docType = d.events
    .filter((e) => e.event_type === "document_type")
    .at(-1)?.payload;
  const automaticNonInvoice = d.events.findLast(e => e.event_type === "non_invoice_auto_rejected")?.payload;
  if (automaticNonInvoice) docType = {
    ...docType, label: "not an invoice", automatic_rejection: true,
    reasons: [`This file was flagged as not an invoice and scored ${automaticNonInvoice.score}/100, below the ${automaticNonInvoice.threshold}-point threshold.`,
      "It was rejected automatically. No review or procurement action is required."],
  };
  const supplierStateOnly =
    key === "rejected" &&
    decisionCodes.size > 0 &&
    [...decisionCodes].every((c) => RECHECKABLE_REJECT_CODES.includes(c));
  const canReview =
    key === "held" && !!rv && !child && !postedRelated && !isAdmin();
  const canProcure =
    key === "held" && !!rv && !child && !postedRelated && isAdmin();
  const canRecheckRejected =
    supplierStateOnly && !!rv && !child && !postedRelated && !isAdmin();
  const title = noReading
    ? "We couldn’t finish reading this invoice"
    : key === "held"
      ? open.length
        ? rechecked && persistent.size
          ? "Still on hold after checking"
          : isAdmin()
            ? (rv?.procurement_needs?.length || tickets.some((t) => t.status === "open")
                ? "Help the reviewer continue"
                : "Waiting on the reviewer")
            : "Review the items below"
        : isAdmin()
          ? "Ready for the reviewer"
          : "Your changes are ready to check"
      : key === "approved"
        ? "Invoice approved"
        : notInvoice
          ? "This doesn’t look like an invoice"
          : key === "rejected"
            ? "Invoice rejected"
            : "Invoice could not be processed";
  const description = noReading
    ? failureHelp(d)
    : key === "held"
      ? canReview
        ? rechecked && persistent.size
          ? "These items still need attention. Saved corrections are kept; resolve the remaining items before checking again."
          : tickets.some((t) => t.status === "open")
            ? "Your request is with procurement. You can finish any remaining invoice details while they respond."
            : !open.length
              ? "The missing details are resolved. Check again to finish this invoice."
              : "Confirm the flagged details, then check the invoice again."
        : canProcure
          ? tickets.some((t) => t.status === "open")
            ? "Update the record and send the reviewer a reply below."
            : !open.length
              ? "Procurement updates are complete. The reviewer can now check the invoice."
              : !rv?.procurement_needs?.length
                ? "Procurement’s part is done. The reviewer still has items to resolve on the invoice, then checks again."
                : "Update the supplier or purchase order so the reviewer can continue."
          : "This is an earlier result. Open the latest result to continue."
      : key === "approved"
        ? `Added to the approved purchase order balance${d.decision_mode === "automatic_exception" ? " using the permitted budget exception" : ""}. ${d.decision_mode === "reviewer" ? "Approved after review." : "No further action is needed."}`
        : notInvoice
          ? notInvoiceHelp(docType)
          : rejectionHelp(dec);
  $("#main").innerHTML =
    `<a href="${isAdmin() ? "#queue" : "#invoices"}" class="back-link">← ${isAdmin() ? "Requests" : "Invoice reviews"}</a><section class="card detail-header ${key}${rechecked && persistent.size ? " rechecked" : ""}"><div class="detail-top"><div class="detail-id"><h1>${esc(s.supplier_name || d.filename)}</h1><p>${esc(detailSubtitle(d, s))}</p></div><div class="detail-marks">${badge(d)}${rechecked && persistent.size ? `<span class="badge still-open">${persistent.size} still unresolved</span>` : ""}${d.confidence?.score != null ? confidenceBadge(d.confidence) : ""}</div></div><h2>${title}</h2><p class="detail-outcome">${esc(description)}</p>${Object.keys(fields).length ? `<dl class="invoice-summary"><div><dt>Invoice total</dt><dd>${esc(s.invoice_gross_total ? (rv?.display?.invoice_gross_total ? s.invoice_gross_total : `${curr} ${s.invoice_gross_total}`) : "Not confirmed")}</dd></div><div><dt>Invoice date</dt><dd>${esc(s.invoice_date || "Not confirmed")}</dd></div><div><dt>Purchase order</dt><dd>${esc(s.po_reference || "Not selected")}</dd></div></dl>` : ""}${confidenceReasons(d.confidence)}<div class="button-row detail-actions">${canReview && open.length ? `<a class="button-link primary" href="#invoice/${encodeURIComponent(id)}" data-resolve-open="${esc(id)}">Resolve step by step →</a>` : ""}${noReading && !isAdmin() && !child ? '<button class="primary" data-action="retry-reading">Try reading again</button>' : ""}${noReading && !isAdmin() ? '<button data-action="upload">Upload a replacement PDF</button>' : ""}</div><div id="retry-error"></div>${tickets.some(t => t.status === "open" && t.requested_by === "invoice-ai") ? `<p class="detail-note">AI has created a procurement request with the invoice details. <a href="${isAdmin() ? "#queue" : "#requests"}">View request →</a></p>` : ""}${child ? `<p class="detail-note">This invoice has a newer result. <a href="#invoice/${encodeURIComponent(latestDescendant(id))}">Open latest result →</a></p>` : ""}${notInvoice ? notInvoicePanel(docType, child) : key === "rejected" ? duplicateLink(d, dec) : ""}</section><div class="review-layout"><div class="review-panel">${canReview ? reviewHTML(rv) : canProcure || (isAdmin() && supplierStateOnly && !!rv && !child && !postedRelated) ? procurementHTML(rv) : canRecheckRejected ? supplierRejectHTML(rv, decisionCodes) : `${isAdmin() && !child && tickets.length ? terminalRequestsHTML() : ""}${summaryHTML(fields)}`}<div id="review-notice" role="status"></div></div><section class="card document-panel" aria-label="Invoice document"><div class="document-header"><h2>Original invoice</h2><button class="mobile-document-toggle small" data-action="toggle-preview" aria-expanded="false">Show document</button><div class="page-controls" id="page-controls"></div></div><div class="document-canvas" id="document-canvas"><p>Loading document…</p></div><div class="document-caption" id="document-caption">Compare these details with your invoice.</div></section></div>${detailsHTML(d, dec, rv)}<p class="footer-note">Approval records an amount against a purchase order. This demo does not send payments.</p>`;
  renderDocument(id, generation);
}
function latestDescendant(id) {
  let cursor = id;
  const seen = new Set();
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const next = state.runs.find((r) => r.parent_run_id === cursor);
    if (!next) break;
    cursor = next.run_id;
  }
  return cursor;
}
function failureHelp(d) {
  const reason = d.failure_reason || "";
  if (/page_limit/.test(reason))
    return "This PDF has more than 10 pages. Upload an invoice of 10 pages or fewer.";
  if (/parse_error|unreadable/.test(reason))
    return "The PDF could not be opened. Export a new, unencrypted copy or ask the supplier for a readable PDF, then upload it here.";
  return "The reading was interrupted before we had enough information. Try reading it again, or upload a clearer copy. Nothing has been approved.";
}
function notInvoiceHelp(docType) {
  const label = docType?.label && docType.label !== "not an invoice" ? `It reads as a ${docType.label}.` : "";
  return `This document was rejected as not an invoice. There is nothing to review or fill in. ${label} No amount was added to any purchase order.`.replace(/\s+/g, " ");
}
function notInvoicePanel(docType, child) {
  const reasons = docType?.reasons ?? [];
  const sig = docType?.signals ?? {};
  const found = [
    sig.invoice_words ? "invoice wording" : null,
    sig.amounts ? `${sig.amounts} amount${sig.amounts === 1 ? "" : "s"}` : null,
    sig.total_words ? "a total line" : null,
    sig.currency_marks ? "a currency" : null,
    sig.tax_words ? "a tax line" : null,
    sig.dates ? `${sig.dates} date${sig.dates === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return `<div class="not-invoice"><h3>What we found</h3><ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>${sig.chars !== undefined ? `<p class="muted-line">Signals on the page: ${found.length ? esc(found.join(", ")) : "none of the usual invoice signals"}.</p>` : ""}${!isAdmin() ? `<div class="button-row" style="margin-top:14px"><button class="primary" data-action="upload">Upload the invoice</button>${!child && !docType?.automatic_rejection ? '<button data-action="read-as-invoice" title="Skip the document-type check and read this file as an invoice">Read as an invoice anyway</button>' : ""}</div><div id="retry-error"></div>` : ""}<p class="muted-line" style="margin-top:12px">Every case we check for is listed under <a href="#edge-cases">Edge cases</a>.</p></div>`;
}
function rejectionHelp(dec) {
  const codes = dec?.codes ?? [];
  if (codes.includes("DUP_FILE_HASH"))
    return "The same PDF was already submitted. Open the earlier result to review its status; this submission added no amount.";
  if (codes.includes("DUP_INVOICE_NO"))
    return "This invoice number has already been approved for this supplier. No second amount was added.";
  if (codes.includes("VENDOR_BLOCKED"))
    return "This supplier is blocked, so the invoice was rejected automatically. If the supplier should be approved again, ask procurement below, then check again once they have.";
  if (codes.includes("VENDOR_UNKNOWN"))
    return "The supplier on this invoice is not in the supplier register, and this workspace rejects invoices from unknown suppliers. If the name was misread, correct it below and check again; if the supplier is genuinely new, ask procurement to onboard it. Procurement can also switch this to an onboarding request instead of a rejection, on the Suppliers page.";
  return (
    dec?.explanation ||
    "This invoice was not approved. No amount was added to the purchase order."
  );
}
function duplicateLink(d, dec) {
  if (!(dec?.codes ?? []).some((c) => c.startsWith("DUP_"))) return "";
  const original = state.runs.find(
    (r) =>
      r.run_id !== d.run_id &&
      (r.document_id === d.document_id ||
        (d.invoice_id && r.invoice_id === d.invoice_id)) &&
      r.disposition !== "rejected",
  );
  return `<div class="button-row" style="margin-top:15px">${original ? `<a href="#invoice/${encodeURIComponent(latestDescendant(original.run_id))}">Open earlier invoice →</a>` : '<a href="#invoices">Find the original in Invoices →</a>'}</div>`;
}
function summaryHTML(fields) {
  return `<section class="card card-pad"><h2>Invoice details</h2>${
    Object.keys(fields).length
      ? `<div class="facts">${Object.entries(fields)
          .filter(
            ([name, v]) =>
              v.raw_value &&
              !["supplier_name", "invoice_gross_total"].includes(name),
          )
          .map(
            ([name, v]) =>
              `<div class="fact"><span>${esc(FIELD[name] || name)}</span><b>${esc(v.raw_value)}</b></div>`,
          )
          .join("")}</div>`
      : '<p style="margin-top:12px">No invoice details were saved for this attempt. The original document and available activity are kept here.</p>'
  }</section>`;
}
function problemCopy(name, problem) {
  const codes = problem.codes || [];
  if (problem.unusable)
    return `${problem.unusable} ${problem.suggestions?.length ? "Pick the right value below, or type it, then save." : "Type the value as shown on the invoice, then save."}`;
  if (name === "currency" && codes.includes("AMBIGUOUS_CURRENCY"))
    return "Confirm the currency code with the invoice or supplier. A symbol such as $ is not enough.";
  if (codes.includes("AMBIGUOUS_DATE"))
    return human(problem.why).replace(
      /^.*?could not be converted to a usable value\.\s*/,
      "",
    );
  if (
    String(problem.why).includes("Not stated on the document") ||
    String(problem.why).includes("Not found on the document")
  )
    return "Enter the value shown on the invoice. If it is missing, ask the supplier for a corrected copy.";
  if (String(problem.why).includes("scanned image"))
    return "Check this value against the scan. Correct it if needed, then Save & confirm — that records you checked it.";
  return human(problem.why);
}
function editor(name, rec = {}, problem = null) {
  const scanRead =
    rec.read_method === "llm_vision" &&
    rec.status === "selected" &&
    !["attested", "corrected"].includes(rec.review_status) &&
    !selfVerified(rec);
  const scan = scanRead && rec.attestable !== false;
  const suggestions = problem?.suggestions?.length
    ? problem.suggestions
    : problem?.suggestion
      ? [{ value: problem.suggestion, reason: "" }]
      : [];
  const still =
    !!problem && (problem.codes || []).some((c) => state.persistent?.has(c));
  return `<div class="field-editor${still ? " still-open" : ""}" id="field-${esc(name)}"><div class="field-head"><label for="input-${esc(name)}">${esc(FIELD[name] || name)}</label>${rec.evidence?.block_id ? `<button class="text small" data-evidence="${esc(name)}">Find on invoice ↗</button>` : ""}</div>${problem ? `<p>${esc(problemCopy(name, problem))}</p>` : ""}<form data-form="field" data-field="${esc(name)}"><div class="field-entry"><input id="input-${esc(name)}" name="value" value="${esc(rec.raw_value || "")}" data-original="${esc(rec.raw_value || "")}" aria-describedby="hint-${esc(name)}" required autocomplete="off"><button type="submit" class="small" ${!problem ? "disabled" : ""}>${problem ? "Save & confirm" : "Save"}</button></div><small id="hint-${esc(name)}">${esc(EXPECTED[name] || "Match the value shown on the invoice.")}</small>${suggestions.length ? `<div class="suggestions">${suggestions.map((s) => `<button type="button" class="text suggestion" data-suggestion="${esc(name)}" data-value="${esc(s.value)}">Use “${esc(s.value)}”</button>${s.reason ? `<span class="suggestion-reason">${esc(s.reason)}</span>` : ""}`).join("")}</div>` : ""}${scanRead && !scan ? `<small class="attest-blocked">This scan reading can’t be confirmed as it is. ${suggestions.length ? "Pick a value above" : "Type the value"}, then Save & confirm.</small>` : ""}</form></div>`;
}
function taskHTML(number, title, body, still = false) {
  return `<section class="task${still ? " still-open" : ""}"><div class="task-heading"><span class="step-number">${number}</span><h3>${title}</h3>${still ? '<span class="badge still-open">Still unresolved</span>' : ""}</div>${body}</section>`;
}
function latestTicket(kind) {
  return (state.tickets || []).find((t) => t.kind === kind) || null; // newest first
}
function ticketForm(kind, label) {
  const copy = SLOT_COPY[kind] || SLOT_COPY.other;
  return `<form data-form="ticket" data-kind="${esc(kind)}"><input type="hidden" name="kind" value="${esc(kind)}"><label>Note for procurement<textarea name="note" placeholder="${esc(copy.placeholder)}"></textarea></label><div class="button-row"><button class="primary small">${esc(label || copy.ask)}</button><small>You can follow the reply in My requests.</small></div></form>`;
}
// The state machine for one request kind: none → open → resolved | declined.
function slotHTML(
  kind,
  { still = false, followUp = "", recheck = false } = {},
) {
  const t = latestTicket(kind);
  if (
    t?.resolved_at &&
    t.resolved_at > (state.detail.finished_at || state.detail.created_at)
  )
    still = false;
  if (!t) return `<div class="slot">${ticketForm(kind)}</div>`;
  const note = (text) => (text ? ` · “${esc(text)}”` : "");
  if (t.status === "open")
    return `<div class="slot waiting"><b>Sent to procurement</b> · ${esc(dateTime(t.created_at))}${note(t.note)}<p>You will see their reply here. You can finish other invoice details, then return to Invoice reviews.</p><button class="text small" data-action="refresh-invoice">Refresh request status</button></div>`;
  if (t.status === "resolved")
    return `<div class="slot done"><b>Done by procurement</b> · ${esc(dateTime(t.resolved_at))}${note(t.resolution_note)}<p>${esc(still ? "This check still failed when you last checked. Send again with more detail, or reject the invoice." : followUp || "Check the invoice again to pick up their change.")}</p>${
      still
        ? ticketForm(kind, "Send again")
        : `${recheck ? '<button class="primary small" data-action="check-again">Check again</button>' : ""}<details class="compact-details"><summary>Still stuck? Send again</summary>${ticketForm(kind, "Send again")}</details>`
    }</div>`;
  return `<div class="slot declined"><b>Declined by procurement</b> · ${esc(dateTime(t.resolved_at))}${note(t.resolution_note)}<p>Address their note and send again, or reject the invoice below.</p>${ticketForm(kind, "Send again")}</div>`;
}
// A blocker that procurement has to fix: what it is, what the reviewer can
// still do here, and the request slot. `collapse` hides an unsent request
// behind a summary when the reviewer has a first-choice action (e.g. pick an
// existing order); a sent request is always visible.
function askHTML(heading, text, kind, opts = {}) {
  const t = latestTicket(kind);
  const inner = `<div class="callout ask${t ? " " + esc(t.status) : ""}"><h3>${esc(heading)}</h3><p>${esc(text)}</p>${opts.extra || ""}${slotHTML(kind, opts)}</div>`;
  return opts.collapse && !t
    ? `<details class="compact-details"><summary>${esc(opts.collapse)}</summary>${inner}</details>`
    : inner;
}
// Requests whose blocker no longer shows (procurement fixed it, or the
// reviewer resolved it another way) still deserve one line of feedback.
function ticketNoticesHTML(shownKinds) {
  const seen = new Set();
  const rows = [];
  for (const t of state.tickets || []) {
    if (shownKinds.has(t.kind) || seen.has(t.kind)) continue;
    seen.add(t.kind);
    const label = TICKET_KINDS[t.kind] || t.kind;
    if (t.status === "resolved")
      rows.push(
        `<div class="slot done compact"><b>Done by procurement</b> · ${esc(label)}${t.resolution_note ? ` · “${esc(t.resolution_note)}”` : ""} · ${esc(dateTime(t.resolved_at))}</div>`,
      );
    else if (t.status === "open")
      rows.push(
        `<div class="slot waiting compact"><b>Open with procurement</b> · ${esc(label)}${t.note ? ` · “${esc(t.note)}”` : ""} · ${esc(dateTime(t.created_at))}</div>`,
      );
  }
  return rows.length
    ? `<div class="task ticket-notices">${rows.join("")}</div>`
    : "";
}
// The invoice's currency as the reviewer has it now: a corrected code wins,
// else what the document established.
// A scan reading confirmed by code: normalises, and either an independent
// reading of the page agrees or a hard cross-check holds. Mirrors
// FieldRecord.self_verified on the server.
function selfVerified(rec) {
  return (
    rec?.read_method === "llm_vision" &&
    rec.status === "selected" &&
    rec.checks?.normalization === "pass" &&
    (rec.checks?.independent_read === "agree" || !!rec.checks?.cross_check)
  );
}
const AUTO_REASON = {
  arithmetic: "the amounts add up exactly",
  vendor_master: "matches an approved supplier",
  po_master: "matches a purchase order on record",
  independent: "two independent readings of the page agree",
};
function autoConfirmedHTML(fields) {
  const done = Object.entries(fields).filter(([, r]) => selfVerified(r) && !["attested", "corrected"].includes(r.review_status));
  if (!done.length) return "";
  return `<details class="compact-details auto-confirmed"><summary>✓ ${done.length} scanned value${done.length === 1 ? "" : "s"} confirmed automatically</summary><ul class="reviewer-items">${done
    .map(([name, r]) => `<li><b>${esc(FIELD[name] || name)}</b> ${esc(r.raw_value)} — ${esc(AUTO_REASON[r.checks.cross_check] || AUTO_REASON.independent)}</li>`)
    .join("")}</ul><p class="muted">Confirmed by code, not by the model’s own confidence. You can still correct any of them under “View or edit other invoice details”.</p></details>`;
}
function invoiceCurrency(rv) {
  const typed = raw("currency").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(typed) ? typed : rv?.context?.currency?.code || "";
}
// Open orders of one supplier the reviewer could select, as <option>s.
function mapPoOptions(supplierId, currency) {
  if (!supplierId) return '<option value="">Choose a supplier first</option>';
  const pos = state.pos.filter(
    (p) => p.supplier_id === supplierId && p.status === "open" && (!currency || p.currency === currency),
  );
  if (!pos.length)
    return `<option value="">No open ${esc(currency || "")} order yet — you can ask procurement in the next step</option>`;
  return `<option value="">Choose the order later</option>${pos
    .map((p) => `<option value="${esc(p.po_id)}">${esc(p.po_id)} · ${esc(money(p.amount_minor - (p.consumed_minor || 0), p.currency))} remaining</option>`)
    .join("")}`;
}
// An unknown name is often a subsidiary, brand or trading name of an approved
// supplier. The reviewer picks that supplier (and its order in the same step);
// it is recorded as their correction of the supplier field.
function mapSupplierHTML(rv, problem) {
  const approved = state.vendors
    .filter((v) => v.status === "approved")
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!approved.length) return "";
  const suggested = approved.find((v) => v.name === problem?.suggestion)?.supplier_id || "";
  const currency = invoiceCurrency(rv);
  const printed = raw("supplier_name").trim();
  return `<div class="callout map-supplier"><h3>Existing supplier under another name?</h3><p>A subsidiary, brand or trading name of an approved supplier: pick the supplier this invoice belongs to and, if you can, its purchase order.</p><form data-form="map-supplier" class="form-grid" data-currency="${esc(currency)}"><label>Approved supplier<select name="supplier_id" data-map-supplier required><option value="">Choose a supplier…</option>${approved
    .map((v) => `<option value="${esc(v.supplier_id)}" ${v.supplier_id === suggested ? "selected" : ""}>${esc(v.name)}${v.aliases?.length ? ` · also ${esc(v.aliases.slice(0, 2).join(", "))}` : ""}</option>`)
    .join("")}</select></label><label>Purchase order<select name="po" data-map-po>${mapPoOptions(suggested, currency)}</select></label><div class="button-row"><button class="primary small">Use this supplier</button><small>Saved as your correction of the supplier${printed ? ` (from “${esc(printed)}”)` : ""}. Procurement can register the name so future invoices match on their own.</small></div></form></div>`;
}
function reviewHTML(rv) {
  const items = rv.diagnosis.items;
  const open = items.filter((i) => i.status !== "resolved");
  const openCodes = new Set(open.map((i) => i.code));
  const fields = rv.fields;
  const problems = rv.diagnosis.field_problems ?? {};
  const poNeedsSelection = open.some((i) => PO_CODES.includes(i.code));
  const persistent = state.persistent ?? new Set();
  const stillCodes = (codes) => (codes || []).some((c) => persistent.has(c));
  const shownKinds = new Set(["other"]);
  let n = 0;
  let sections = "";
  // 1 · supplier — reviewer corrects a misread; procurement onboards a new one
  const supplierProblem = problems.supplier_name;
  if (supplierProblem) {
    let ask = "";
    if (openCodes.has("VENDOR_UNKNOWN")) {
      shownKinds.add("onboard_supplier");
      ask =
        mapSupplierHTML(rv, supplierProblem) +
        askHTML(
          "Genuinely new supplier?",
          "Procurement approves them and raises their purchase order — one request covers both.",
          "onboard_supplier",
          { still: persistent.has("VENDOR_UNKNOWN") },
        );
    }
    sections += taskHTML(
      ++n,
      "Confirm the supplier",
      editor("supplier_name", fields.supplier_name, supplierProblem) + ask,
      stillCodes(supplierProblem.codes),
    );
  }
  // 2 · details — reviewer only
  const fieldNames = new Set(
    Object.keys(problems).filter(
      (name) => !["supplier_name", "po_reference"].includes(name),
    ),
  );
  for (const [name, v] of Object.entries(fields))
    if (
      v.read_method === "llm_vision" &&
      v.status === "selected" &&
      !["attested", "corrected"].includes(v.review_status) &&
      !selfVerified(v) &&
      name !== "supplier_name" &&
      (name !== "po_reference" || !poNeedsSelection)
    )
      fieldNames.add(name);
  if (fieldNames.size) {
    sections += taskHTML(
      ++n,
      "Check the invoice details",
      `<p>Compare each value with the document, correct it if needed, then Save & confirm.</p>${[...fieldNames].map((name) => editor(name, fields[name], problems[name])).join("")}`,
      [...fieldNames].some((name) => stillCodes(problems[name]?.codes)),
    );
  }
  // 3 · purchase order — reviewer picks an existing order; procurement raises,
  //     reopens or re-currencies one
  const poProblem =
    poNeedsSelection ||
    (problems.po_reference &&
      fields.po_reference?.read_method !== "llm_vision");
  if (poProblem) {
    const currency = /^[A-Z]{3}$/.test(raw("currency").trim().toUpperCase())
      ? raw("currency").trim().toUpperCase()
      : rv.context?.currency?.code;
    const candidates = rv.po_candidates.filter(
      (p) => !currency || p.currency === currency,
    );
    const poCode = [
      "PO_CLOSED",
      "CURRENCY_MISMATCH",
      "PO_VENDOR_MISMATCH",
      "NO_PO_MATCH",
    ].find((c) => openCodes.has(c));
    let body = `<p>${esc(problems.po_reference ? problemCopy("po_reference", problems.po_reference) : "Choose the order this invoice belongs to.")}</p>`;
    if (!rv.diagnosis.vendor_resolved) {
      body +=
        '<div class="callout">Confirm the supplier in the step above. Their purchase orders will appear here once procurement approves the supplier.</div>';
    } else {
      if (candidates.length) {
        const fitting = candidates.filter((p) => p.status !== "exceeded");
        body += `<form data-form="pick-po" class="form-grid"><label>Purchase order<select name="po" required><option value="">Choose an order…</option>${candidates
          .map((p) => {
            const live = state.pos.find((x) => x.po_id === p.po_id);
            const remaining = p.remaining_minor ?? p.amount_minor - (live?.consumed_minor || 0);
            const flag =
              p.status === "exceeded"
                ? ` — not enough for this invoice (short ${money(p.short_minor, p.currency)})`
                : p.status === "exception"
                  ? " — within the permitted exception"
                  : "";
            return `<option value="${esc(p.po_id)}" data-status="${esc(p.status || "")}" ${raw("po_reference") === p.po_id ? "selected" : ""}>${esc(p.po_id)} · ${esc(money(remaining, p.currency))} remaining${esc(flag)}</option>`;
          })
          .join("")}</select></label><button>Use this purchase order</button>${
          fitting.length
            ? ""
            : '<p class="budget-note">None of these orders has enough budget for this invoice. Select the right one anyway, then ask procurement to raise its budget — or reject the invoice.</p>'
        }</form>`;
      }
      {
        shownKinds.add("raise_po");
        const text =
          {
            PO_CLOSED:
              "The referenced order is closed. Procurement can reopen it or raise a new one.",
            CURRENCY_MISMATCH:
              "The invoice currency does not match the referenced order. If the currency above is misread, correct it; otherwise procurement has to raise an order in this currency.",
            PO_VENDOR_MISMATCH:
              "The referenced order belongs to a different supplier. Choose the right order above, or ask procurement.",
          }[poCode] ||
          (candidates.length
            ? "If none of the open orders is the one this invoice bills against, procurement can raise one."
            : `No open ${currency || "matching-currency"} order is available for ${raw("supplier_name") || "this supplier"}. Ask procurement to add an authorized order; it will appear here when you return.`);
        body += askHTML(
          candidates.length
            ? "Need a different order?"
            : "No usable purchase order",
          text,
          "raise_po",
          {
            collapse: candidates.length
              ? "None of these orders is right? Ask procurement"
              : "",
            still:
              !!poCode &&
              persistent.has(poCode) &&
              latestTicket("raise_po")?.run_id !== state.detail.run_id,
            followUp: "Choose the new order above, then check again.",
            recheck: false,
          },
        );
      }
    }
    body += `<details class="compact-details"><summary>Enter the purchase order reference manually</summary>${editor("po_reference", fields.po_reference, null)}</details>`;
    sections += taskHTML(
      ++n,
      "Choose the purchase order",
      body,
      open.some((i) => PO_CODES.includes(i.code) && persistent.has(i.code)) ||
        stillCodes(problems.po_reference?.codes),
    );
  }
  // 4 · everything else: budget (procurement), possible duplicate (reviewer
  //     confirms or rejects), conflicts and unsupported documents (final)
  const EXTERNAL = [
    "PO_BUDGET_EXCEEDED",
    "DUP_FINGERPRINT",
    "CONTENT_CONFLICT",
    "UNSUPPORTED_DOCUMENT_TYPE",
    "UNSUPPORTED_AMOUNT_STRUCTURE",
    "VENDOR_BLOCKED",
  ];
  const external = open.filter((i) => EXTERNAL.includes(i.code));
  // forecast: the referenced order cannot take this invoice — say so now, with
  // the request to amend it and the way out (reject), before Check again
  if (rv.budget?.status === "exceeded" && !openCodes.has("PO_BUDGET_EXCEEDED"))
    external.push({ code: "PO_BUDGET_EXCEEDED", label: "Purchase order budget exceeded", forecast: true });
  if (external.length) {
    const blocks = external.map((i) => {
      const still = persistent.has(i.code);
      if (i.code === "PO_BUDGET_EXCEEDED") {
        shownKinds.add("amend_po");
        const b = rv.budget;
        const numbers =
          b && b.gross_minor != null
            ? `${b.po_id} has ${money(b.remaining_minor, b.currency)} left; this invoice is ${money(b.gross_minor, b.currency)}${b.short_minor ? `, ${money(b.short_minor, b.currency)} more than the permitted overage` : ""}. `
            : "";
        const reason = b && b.gross_minor != null
          ? `Invoice exceeds the purchase order budget: ${b.po_id} has ${money(b.remaining_minor, b.currency)} left, the invoice is ${money(b.gross_minor, b.currency)}. Please issue a corrected invoice or reference the right order.`
          : "Invoice exceeds the purchase order budget. Please issue a corrected invoice or reference the right order.";
        return askHTML(
          "Not enough budget on the order",
          `${numbers}Two ways forward: if the spend is authorized, ask procurement to raise the order’s budget below. If the invoice itself is wrong, reject it — the reason goes back to the supplier.`,
          "amend_po",
          {
            still,
            extra: `<div class="budget-choice"><button type="button" class="small danger" data-action="open-reject" data-reason="${esc(reason)}">Reject — ask the supplier for a corrected invoice</button><a href="#pos">View order balances →</a></div>`,
          },
        );
      }
      if (i.code === "VENDOR_BLOCKED") {
        shownKinds.add("unblock_supplier");
        return askHTML(
          "Supplier is blocked",
          "A blocked supplier cannot be approved through this review. If it should be approved again, ask procurement.",
          "unblock_supplier",
          { still },
        );
      }
      if (i.code === "DUP_FINGERPRINT")
        return `<div class="callout${still ? " still" : ""}"><h3>Possible duplicate</h3><p>Another invoice from this supplier has the same amount and date. Compare them. If this is a genuinely separate invoice, say why below and the next check will run the remaining approval rules; if it is the same invoice, reject it.</p><a href="#invoices">Compare invoices in the inbox →</a><form data-form="confirm-distinct" class="slot-form"><label>Why this is a separate invoice<textarea name="note" required minlength="5" placeholder="For example: two deliveries the same day; invoice numbers differ; both on the delivery notes"></textarea></label><div class="button-row"><button class="small">Confirm it is a separate invoice</button><small>Recorded on the audit trail under your name.</small></div></form></div>`;
      if (i.code === "CONTENT_CONFLICT")
        return `<div class="callout${still ? " still" : ""}"><h3>Another version of this invoice was already approved</h3><p>A different amount is recorded for this invoice number. If the total here is misread, correct it under other invoice details. Otherwise finance decides which version stands; reject the wrong one below.</p><a href="#invoices">Compare invoices in the inbox →</a></div>`;
      if (i.code === "UNSUPPORTED_AMOUNT_STRUCTURE")
        return `<div class="callout${still ? " still" : ""}"><h3>Prepayment or adjustment</h3><p>This invoice includes a prepayment or adjustment that this workflow cannot approve. If a value was misread, correct it using the document. Otherwise handle it through finance’s exception process and reject it here with the reason.</p></div>`;
      return `<div class="callout${still ? " still" : ""}"><h3>Not a standard invoice</h3><p>Credit notes and other document types follow your team’s own process. Reject this submission, then upload a standard invoice if needed.</p></div>`;
    });
    sections += taskHTML(
      ++n,
      external.length === 1 && external[0].code === "PO_BUDGET_EXCEEDED"
        ? external[0].forecast
          ? "The order cannot take this invoice"
          : "Resolve the budget"
        : external.length === 1 && external[0].code === "DUP_FINGERPRINT"
          ? "Check for a duplicate"
          : "Resolve the remaining checks",
      blocks.join(""),
      external.some((i) => persistent.has(i.code)),
    );
  }
  if (!sections)
    sections =
      '<div class="task"><p class="saved-mark">✓ No corrections remaining.</p></div>';
  const other = Object.keys(FIELD).filter(
    (name) =>
      !fieldNames.has(name) &&
      !(name === "supplier_name" && supplierProblem) &&
      !(name === "po_reference" && poProblem),
  );
  const stillCount = open.filter((i) => persistent.has(i.code)).length;
  const resolvedCount = items.filter((i) => i.status === "resolved").length;
  const otherTicket = latestTicket("other");
  const waiting = (state.tickets || []).some((t) => t.status === "open");
  return `<section class="card"><div class="section-heading"><h2>${n ? (stillCount ? "What still needs your attention" : "What needs your attention") : "Ready to check again"}</h2><p>${stillCount ? `<span class="still-open-note">${stillCount} item${stillCount === 1 ? "" : "s"} in red ${stillCount === 1 ? "was" : "were"} still unresolved when you last checked.</span> ` : ""}${resolvedCount ? `${resolvedCount} of ${items.length} checks resolved · ` : ""}Changes are saved when you confirm each field.</p></div>${ticketNoticesHTML(shownKinds)}${autoConfirmedHTML(fields) ? `<div class="task">${autoConfirmedHTML(fields)}</div>` : ""}${sections}<div class="task"><details><summary>View or edit other invoice details</summary>${other.map((name) => editor(name, fields[name], null)).join("")}</details></div><div class="review-footer"><p>${waiting ? "Procurement has your request. Finish any corrections above, then return when they reply." : "Check again when your corrections are saved. Passing all checks approves this invoice."}</p>${waiting ? '<a class="button-link primary" href="#invoices">Back to invoice reviews</a><button class="text" data-action="check-again">Check for updates now</button>' : '<button class="primary" data-action="check-again">Check again</button>'}<div id="decision-error"></div><details class="compact-details other-request"${otherTicket ? " open" : ""}><summary>Need something else from procurement?</summary>${slotHTML("other")}</details><details class="rejection"><summary>Can’t resolve this invoice? Reject it</summary><form data-form="reject"><label>Why should this invoice be rejected?<textarea name="reason" required placeholder="For example: Supplier needs to send a corrected invoice"></textarea></label><button class="danger">Reject invoice</button></form></details></div></section>`;
}
// Rejected because the supplier is blocked: the one rejection a reviewer can
// still act on, through procurement.
// A rejection the supplier register can undo. Two causes, two ways back:
// blocked (procurement approves it again) and unknown (the name is a misread
// the reviewer can correct, or a genuinely new supplier procurement onboards).
function supplierRejectHTML(rv, codes) {
  const supplier = raw("supplier_name");
  const unknown = codes.has("VENDOR_UNKNOWN");
  const kind = unknown ? "onboard_supplier" : "unblock_supplier";
  const intro = unknown
    ? "This supplier is not in the supplier register, and this workspace rejects invoices from unknown suppliers. Nothing was approved."
    : "The supplier is blocked, so this invoice was rejected automatically. Only procurement can approve a supplier again.";
  const problem = rv.diagnosis?.field_problems?.supplier_name;
  const correction = unknown && problem ? mapSupplierHTML(rv, problem) : "";
  const ask = unknown
    ? askHTML(
        "Genuinely new supplier?",
        `${supplier || "This supplier"} is not in the register. If the name above is a misread of an approved supplier, correct it and check again. If the supplier is genuinely new, procurement approves it and raises its purchase order — one request covers both.`,
        kind,
        {
          followUp:
            "Check the invoice again. With the supplier in the register, the normal checks run and can approve it.",
        },
      )
    : askHTML(
        "Supplier is blocked",
        `${supplier || "This supplier"} is on the blocked list. If you believe it should be approved again, ask procurement. If not, the rejection stands.`,
        kind,
        {
          followUp:
            "Check the invoice again. With the supplier approved, the normal checks run and can approve it.",
        },
      );
  const footer = unknown
    ? "Once the supplier name is corrected, or procurement has onboarded the supplier, check again."
    : "Once procurement has approved the supplier again, check again.";
  return `<section class="card"><div class="section-heading"><h2>What you can do</h2><p>${esc(intro)}</p></div><div class="task">${correction}${ask}${ticketNoticesHTML(new Set([kind]))}</div><div class="review-footer"><p>${esc(footer)}</p><button class="primary" data-action="check-again">Check again</button><div id="decision-error"></div></div></section>`;
}
// Admin mirror of the slot: the reviewer's open request for this kind, with
// the resolve/decline form, inline in the task that answers it.
// The reply form knows whether the record already satisfies the request
// (server-derived `fulfilled`): then only "complete" is offered, because a
// decline would contradict what the reviewer will see.
// Requests close themselves when the record shows them done (server-side
// settle_requests). The only manual action on a derivable request is to
// decline it with a reason; an "other" request has no record to check, so
// it keeps a human reply.
function requestFooterHTML(tickets, { final = false } = {}) {
  const open = tickets.filter((x) => x.status === "open");
  if (!open.length) return "";
  return open
    .map((x) => {
      const manual = x.kind === "other";
      if (final)
        return `<form data-form="resolve-ticket" data-id="${esc(x.ticket_id)}" class="request-close"><p class="muted">The invoice is final, so “${esc(TICKET_KINDS[x.kind] || x.kind)}” no longer needs anything. Close it with a note for the reviewer.</p><label>Note<textarea name="note" required placeholder="For example: Invoice was rejected; nothing raised."></textarea></label><div class="button-row"><button class="small" name="outcome" value="declined">Close request</button></div></form>`;
      return `<form data-form="resolve-ticket" data-id="${esc(x.ticket_id)}" class="request-close"><p class="muted">${manual ? "This request has no record to check, so it needs your reply." : `“${esc(TICKET_KINDS[x.kind] || x.kind)}” closes itself once the steps above are done.`}</p><label>${manual ? "Reply to the reviewer" : "Reason for declining"}<textarea name="note" required placeholder="${esc(manual ? "What you did, or what the reviewer should do next" : "For example: Not an approved counterparty — reject the invoice.")}"></textarea></label><div class="button-row">${manual ? '<button class="primary small" name="outcome" value="resolved">Reply & close</button>' : ""}<button class="danger small" name="outcome" value="declined">Decline request</button></div></form>`;
    })
    .join("");
}
// Admin counterpart of mapSupplierHTML: register the printed name as another
// name of an approved supplier, so this and future invoices resolve to it.
function aliasFormHTML(printed) {
  const approved = state.vendors
    .filter((v) => v.status === "approved")
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!printed || !approved.length) return "";
  return `<details class="compact-details alias-form"><summary>Existing supplier under another name?</summary><form data-form="add-alias" class="form-grid"><label>Approved supplier<select name="supplier_id" required><option value="">Choose a supplier…</option>${approved
    .map((v) => `<option value="${esc(v.supplier_id)}">${esc(v.name)}${v.aliases?.length ? ` · also ${esc(v.aliases.slice(0, 2).join(", "))}` : ""}</option>`)
    .join("")}</select></label><button class="small">Register “${esc(printed)}” as a name of this supplier</button><small>This invoice and future ones printing that name will resolve to the supplier automatically.</small></form></details>`;
}
function procurementHTML(rv) {
  const codes = new Set(
    rv.diagnosis.items
      .filter((i) => i.status !== "resolved")
      .map((i) => i.code),
  );
  // tasks = what procurement still owes (server-derived) + open requests
  const kinds = new Set(
    (rv.procurement_needs || []).map((a) => a.kind).filter(Boolean),
  );
  for (const t of state.tickets || [])
    if (t.status === "open") kinds.add(t.kind);
  const onboardOpen = latestTicket("onboard_supplier")?.status === "open";
  if (onboardOpen) kinds.add("raise_po"); // a new supplier needs an order too
  const supplier = raw("supplier_name");
  const vendor = state.vendors.find((v) => v.supplier_id === rv.po_supplier_id);
  const currency = /^[A-Z]{3}$/.test(raw("currency").trim().toUpperCase())
    ? raw("currency").trim().toUpperCase()
    : rv.context?.currency?.code || "";
  const matching = rv.po_candidates.filter(
    (p) => !currency || p.currency === currency,
  );
  const po = state.pos.find((p) => p.po_id === raw("po_reference").trim());
  const create = `<form data-form="create-po" class="form-grid two"><label class="full">Purchase order number<input name="po_id" value="${esc(po ? "" : raw("po_reference"))}" placeholder="PO-3010" required></label><label>Currency<input name="currency" value="${esc(currency)}" placeholder="USD" required></label><label>Authorized amount<input name="amount" inputmode="decimal" placeholder="10000.00" required></label><button class="primary full">Add purchase order</button></form>`;
  let body = "",
    n = 0;
  for (const kind of [
    "onboard_supplier",
    "unblock_supplier",
    "raise_po",
    "amend_po",
    "other",
  ]) {
    if (!kinds.has(kind)) continue;
    const t = latestTicket(kind);
    let task =
      t?.status === "open"
        ? `<div class="request-context"><span class="eyebrow">REQUEST FROM REVIEWER · ${esc(date(t.created_at))}</span><p>${esc(t.note || t.kind_label || TICKET_KINDS[kind])}</p></div>`
        : '<p class="muted">This invoice needs a procurement update. No reviewer request is open for this item.</p>';
    if (kind === "onboard_supplier")
      task +=
        vendor?.status === "approved"
          ? `<p class="saved-mark">✓ ${esc(vendor.name)} is an approved supplier.${onboardOpen ? " Now add its purchase order in the next step." : ""}</p>`
          : `<p>Add ${esc(supplier || "the supplier")} once your team has approved them. A misread name should be corrected by the reviewer.${onboardOpen ? " A new supplier has no orders yet, so the next step adds one." : ""}</p><form data-form="onboard" class="form-grid"><label>Supplier legal name<input name="name" value="${esc(supplier)}" required></label><label>Country (optional)<input name="country"></label><button class="primary">Add approved supplier</button></form>${aliasFormHTML(supplier)}`;
    if (kind === "unblock_supplier")
      task +=
        vendor?.status === "blocked"
          ? `<div class="callout"><p>${esc(vendor.name)} is blocked. Confirm your team has approved them before changing their status.</p><button data-action="unblock-supplier" data-id="${esc(vendor.supplier_id)}">Approve supplier again</button></div>`
          : `<p class="saved-mark">${vendor ? "✓ This supplier is approved." : "Check the supplier record."}</p>`;
    if (kind === "raise_po") {
      if (!rv.diagnosis.vendor_resolved)
        task +=
          "<p>Approve the supplier above first. Then you can add its purchase order here.</p>";
      else {
        if (matching.length)
          task += `<div class="available-orders"><h4>Available for ${esc(supplier)} · ${esc(currency)}</h4>${matching
            .map((p) => {
              const live = state.pos.find((x) => x.po_id === p.po_id) || p;
              return `<p><b>${esc(p.po_id)}</b><span>${esc(money(live.amount_minor - (live.consumed_minor || 0), p.currency))} remaining</span></p>`;
            })
            .join(
              "",
            )}<small>The reviewer can select one of these orders.</small></div>`;
        else
          task += `<p>No open ${esc(currency)} purchase order is available for ${esc(supplier)}. Record an authorized order so the reviewer can select it.</p>`;
        if (
          po?.status === "closed" &&
          po.supplier_id === rv.po_supplier_id &&
          (!currency || po.currency === currency)
        )
          task += `<div class="callout"><p>${esc(po.po_id)} is closed.</p><button data-action="context-reopen-po" data-id="${esc(po.po_id)}">Reopen ${esc(po.po_id)}</button></div>`;
        task += matching.length
          ? `<details class="compact-details"><summary>Add a different authorized order</summary>${create}</details>`
          : create;
      }
    }
    if (kind === "amend_po")
      task += po
        ? `<p><b>${esc(po.po_id)}</b> · Invoice total ${esc(currency)} ${esc(raw("invoice_gross_total"))}</p><dl class="budget-summary"><div><dt>Authorized</dt><dd>${esc(money(po.amount_minor, po.currency))}</dd></div><div><dt>Already approved</dt><dd>${esc(money(po.consumed_minor, po.currency))}</dd></div><div><dt>Available</dt><dd>${esc(money(po.amount_minor - po.consumed_minor, po.currency))}</dd></div></dl><form data-form="context-amend-po" data-id="${esc(po.po_id)}" class="form-grid"><label>New authorized total (${esc(po.currency)})<input name="amount" inputmode="decimal" value="${esc((po.amount_minor / 10 ** (EXP[po.currency] ?? 2)).toFixed(EXP[po.currency] ?? 2))}" required></label><small>Use the total approved by your team, including billing already recorded.</small><button>Save authorized amount</button></form>`
        : '<p>The invoice has no matching order. <a href="#pos">Find the purchase order</a> or ask the reviewer to correct its reference.</p>';
    if (kind === "other")
      task +=
        '<p>Use the invoice and the reviewer’s note to decide the next step. <a href="#vendors">Manage suppliers</a> or <a href="#pos">manage purchase orders</a> if needed.</p>';
    body += taskHTML(
      ++n,
      {
        onboard_supplier: "Approve the supplier",
        unblock_supplier: "Review the supplier’s status",
        raise_po: "Provide the purchase order",
        amend_po: "Update the order budget",
        other: "Help the reviewer continue",
      }[kind],
      task,
    );
  }
  const history = (state.tickets || []).filter((t) => t.status !== "open");
  const reviewerItems = rv.diagnosis.items.filter((i) => i.status !== "resolved");
  const upToDate = `<div class="task">${
    reviewerItems.length
      ? `<p>Still with the reviewer:</p><ul class="reviewer-items">${reviewerItems.map((i) => `<li>${esc(LABELS[i.code] || human(i.label))}</li>`).join("")}</ul>`
      : '<p class="saved-mark">✓ The reviewer only has to check the invoice again.</p>'
  }</div>`;
  const footer = requestFooterHTML(state.tickets || []);
  return `<section class="card"><div class="section-heading"><h2>${n ? "Resolve the request" : "Procurement is up to date"}</h2><p>${n ? "Complete the steps below. The request closes itself once the record shows them done, and the reviewer picks the invoice up from there." : "Nothing is owed on this invoice."}</p></div>${body || upToDate}${history.length ? `<div class="task"><details><summary>Closed requests (${history.length})</summary>${history.map(ticketHTML).join("")}</details></div>` : ""}<div class="task"><details><summary>All invoice details</summary>${summaryHTML(rv.fields)}</details></div>${footer ? `<div class="review-footer">${footer}</div>` : ""}</section>`;
}
function terminalRequestsHTML() {
  const open = (state.tickets || []).filter((t) => t.status === "open");
  return `<section class="card"><div class="section-heading"><h2>${open.length ? "Close remaining requests" : "Request history"}</h2><p>This invoice has a final result${open.length ? "; requests left open no longer need anything." : "."}</p></div>${open.map((t) => taskHTML("↗", esc(t.kind_label || TICKET_KINDS[t.kind]), `<p>${esc(t.note)}</p>`)).join("")}${open.length ? `<div class="review-footer">${requestFooterHTML(open, { final: true })}</div>` : ""}${!open.length ? `<div class="task"><details><summary>Previous replies</summary>${state.tickets.map(ticketHTML).join("")}</details></div>` : ""}</section>`;
}
function ticketHTML(t) {
  const status = t.status;
  return `<div class="ticket" id="ticket-${esc(t.ticket_id)}"><div class="ticket-head"><span class="badge ${esc(status)}">${esc(status === "open" ? "Open" : status === "resolved" ? "Resolved" : "Declined")}</span><b>${esc(TICKET_KINDS[t.kind] || t.kind)}</b><span class="who">by ${esc(t.requested_by)}</span><time>${esc(dateTime(t.created_at))}</time></div>${t.note ? `<p>“${esc(t.note)}”</p>` : ""}${
    status !== "open"
      ? `<div class="resolution ${esc(status)}"><b>${esc(t.resolved_by)}</b> · ${esc(dateTime(t.resolved_at))}${t.resolution_note ? ` — ${esc(t.resolution_note)}` : ""}</div>`
      : isAdmin()
        ? '<p class="muted">Open — closes itself when the record shows it done, or decline it below.</p>'
        : '<p style="color:var(--info-fg)">Waiting for procurement. You will see their note here.</p>'
  }</div>`;
}
async function renderDocument(id, generation) {
  try {
    const doc = await api(`/api/runs/${encodeURIComponent(id)}/document`);
    if (generation !== state.generation) return;
    state.doc = doc;
    drawPage();
  } catch (e) {
    if (generation === state.generation)
      $("#document-canvas").innerHTML = errorHTML(
        "The document preview is unavailable. Try loading it again, or use your original PDF to review the details.",
        "retry-preview",
        "Reload preview",
      );
  }
}
function drawPage() {
  const doc = state.doc;
  if (!doc?.pages?.length) {
    $("#document-canvas").innerHTML = "<p>No document preview available.</p>";
    return;
  }
  const pg = doc.pages[state.page - 1];
  $("#page-controls").innerHTML =
    `<button class="icon" data-action="previous-page" aria-label="Previous page" ${state.page === 1 ? "disabled" : ""}>‹</button><span>Page ${state.page} of ${doc.pages.length}</span><button class="icon" data-action="next-page" aria-label="Next page" ${state.page === doc.pages.length ? "disabled" : ""}>›</button>`;
  const field = state.review?.fields?.[state.selectedField];
  const block = doc.blocks.find(
    (b) => b.block_id === field?.evidence?.block_id,
  );
  let overlay = "";
  if (block && block.page === state.page)
    overlay = `<div class="evidence-box" style="left:${Math.max(0, ((block.x0 - 2) / pg.width) * 100)}%;top:${Math.max(0, ((block.top - 2) / pg.height) * 100)}%;width:${Math.min(100, ((block.x1 - block.x0 + 4) / pg.width) * 100)}%;height:${((block.bottom - block.top + 4) / pg.height) * 100}%"></div>`;
  $("#document-canvas").innerHTML =
    `<div class="pdf-page"><img src="/api/runs/${encodeURIComponent(state.detail.run_id)}/page/${state.page}?role=${encodeURIComponent(getToken() || "")}&ws=${encodeURIComponent(getWorkspace())}" alt="Original invoice, page ${state.page}">${overlay}</div>`;
  $("#document-canvas img").addEventListener("error", () => {
    $("#document-canvas").innerHTML = errorHTML(
      "This page could not be displayed. Reload the preview or use your original PDF.",
      "retry-preview",
      "Reload preview",
    );
  });
  $("#document-caption").textContent = block
    ? `${FIELD[state.selectedField] || state.selectedField}: ${field.raw_value}`
    : isAdmin()
      ? "Original document provided by the reviewer."
      : "Select “Find on invoice” beside a field to highlight its location.";
}
function activityText(event) {
  if (event.event_type === "ticket_opened")
    return `Request to procurement opened by ${event.payload.actor}: ${TICKET_KINDS[event.payload.kind] || event.payload.kind}${event.payload.note ? ` — “${event.payload.note}”` : ""}`;
  if (
    event.event_type === "ticket_resolved" ||
    event.event_type === "ticket_declined"
  )
    return `Request ${event.event_type === "ticket_resolved" ? "resolved" : "declined"} by ${event.payload.actor}${event.payload.note ? `: “${event.payload.note}”` : ""}`;
  const p = event.payload ?? {};
  return (
    {
      classified: `Opened ${p.pages} page${p.pages === 1 ? "" : "s"}.`,
      fields: "Read the invoice details.",
      gates: p.arithmetic_ok
        ? "Checked invoice amounts."
        : "Flagged invoice details for review.",
      attempts: "Finished a document-reading attempt.",
      rule_evaluated: "Checked the purchase order budget.",
      decision: p.explanation || "Saved the result.",
      duplicate_submission: "Found a previously uploaded copy of this file.",
      operational_failure: `Could not read the PDF${p.reason ? ` (${p.reason})` : ""}.`,
      document_type: p.forced
        ? "Reviewer asked for this file to be read as an invoice."
        : p.invoice_like
          ? "Checked the document type: looks like an invoice."
          : `Checked the document type: ${p.label || "not an invoice"}. Nothing was sent to the model.`,
      scan_self_check: "Cross-checked the scanned readings.",
      vendor_onboarded: `Added supplier ${p.name || ""}.`,
      po_created: `Added purchase order ${p.po_id || ""}.`,
      budget_exhausted: "Document reading stopped before completion.",
    }[event.event_type] || human(event.event_type).replaceAll("_", " ")
  );
}
function detailsHTML(d, dec, rv) {
  const history = state.runs.filter(
    (r) => r.document_id === d.document_id && r.run_id !== d.run_id,
  );
  return `<details class="card details-section"><summary>Decision details & activity</summary><div class="details-body">${dec?.explanation ? `<h3>Why this decision was made</h3><p style="margin:8px 0 18px">${esc(dec.explanation)}</p>` : ""}${history.length ? `<h3>Earlier submissions & reviews</h3>${history.map((r) => `<div class="activity-row"><time>${esc(dateTime(r.created_at))}</time><a href="#invoice/${encodeURIComponent(r.run_id)}">${esc(statusLabel(r))} · ${esc(r.kind === "review" ? "Review" : "Upload")}</a></div>`).join("")}` : ""}<h3 style="margin-top:18px">Activity for this result</h3>${d.events.map((e) => `<div class="activity-row"><time>${esc(dateTime(e.ts))}</time><p>${esc(activityText(e))}</p></div>`).join("")}<details class="compact-details"><summary>Technical evidence & verification</summary><pre class="technical">${esc(JSON.stringify({ run_id: d.run_id, decision_mode: d.decision_mode, fields: rv?.fields, events: d.events }, null, 2))}</pre></details></div></details>`;
}
// ---- generic modal ---------------------------------------------------------
// One dialog for any list or detail that should not live inline: title,
// optional subtitle, HTML body, optional filter box for long lists. Closes on
// ✕, Esc, backdrop click, or when a link inside it navigates.
function openModal({ title, subtitle = "", body, filter = false }) {
  const dlg = $("#app-modal");
  $("#modal-title").textContent = title;
  const sub = $("#modal-subtitle");
  sub.textContent = subtitle;
  sub.hidden = !subtitle;
  $("#modal-body").innerHTML =
    `${filter ? '<input class="search modal-filter" type="search" placeholder="Filter this list…" aria-label="Filter this list">' : ""}${body}`;
  if (!dlg.open) dlg.showModal();
  dlg.querySelector(".modal-filter")?.focus();
}
function closeModal() {
  const dlg = $("#app-modal");
  if (dlg?.open) dlg.close();
}
// A list of records for the modal: each row carries its own search text.
function recordListHTML(rows, empty) {
  if (!rows.length) return `<p class="muted modal-empty">${esc(empty)}</p>`;
  return `<ul class="record-list">${rows
    .map((r) => `<li class="record-row" data-search="${esc((r.search || "").toLowerCase())}"><div class="record-main">${r.main}</div><div class="record-meta">${r.meta || ""}</div><div class="record-badge">${r.badge || ""}</div></li>`)
    .join("")}</ul>`;
}
function invoiceRow(inv) {
  const amount = inv.posted && inv.amount_minor != null ? money(inv.amount_minor, inv.currency) : inv.amount_raw || "";
  const label = inv.disposition === "approved" ? "Approved" : inv.disposition === "held" ? "Needs review" : "Rejected";
  return {
    main: `<a href="#invoice/${encodeURIComponent(latestDescendant(inv.run_id))}">${esc(inv.invoice_no ? "#" + inv.invoice_no : "Invoice")}</a><small>${esc(inv.supplier_name || "")}${inv.created_at ? ` · ${esc(date(inv.created_at))}` : ""}</small>`,
    meta: esc(amount),
    badge: `<span class="badge ${esc(inv.disposition)}">${label}</span>`,
    search: `${inv.invoice_no || ""} ${inv.supplier_name || ""} ${amount} ${label}`,
  };
}
function orderRow(po) {
  return {
    main: `<a href="#pos/${encodeURIComponent(po.po_id)}">${esc(po.po_id)}</a><small>${esc(money(po.consumed_minor, po.currency))} of ${esc(money(po.amount_minor, po.currency))} used</small>`,
    meta: `${esc(money(po.amount_minor - po.consumed_minor, po.currency))} remaining`,
    badge: `<span class="badge ${po.status === "open" ? "approved" : ""}">${po.status === "open" ? "Open" : "Closed"}</span>`,
    search: `${po.po_id} ${po.currency} ${po.status}`,
  };
}
// Scroll a purchase order row or supplier card into view and flash it.
function focusRecord(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: "center" });
  el.classList.add("highlight");
  setTimeout(() => el.classList.remove("highlight"), 2400);
}
// What happens to an invoice whose supplier is not in the register. Procurement
// owns the register, so procurement owns this rule; a reviewer sees it read-only
// because it explains why their invoice was rejected rather than queued.
function unknownSupplierRuleHTML(workspace) {
  if (!workspace) return "";
  const current = workspace.unknown_supplier_action;
  const choices = workspace.choices?.unknown_supplier_action ?? [];
  // Same rule, two audiences: procurement is choosing it, a reviewer is being
  // told what it means for the invoice in front of them.
  const detail = {
    reject: "The invoice is rejected immediately. Nothing is posted and no request is raised. A reviewer can still correct a misread name, or ask you to onboard the supplier, and check the invoice again.",
    ticket: "The invoice is held and Invoice AI opens an onboarding request for you, with the supplier name and the invoice details already filled in.",
  };
  const reviewerDetail = {
    reject: "Invoices naming a supplier that is not in the register are rejected automatically. Nothing is posted. If the name was misread, correct it on the invoice and check again; if the supplier is genuinely new, ask procurement to onboard it from the invoice, then check again.",
    ticket: "Invoices naming a supplier that is not in the register are held, and Invoice AI raises the onboarding request with procurement for you — no request form to fill in.",
  };
  if (!isAdmin())
    return `<section class="card settings-card"><div class="section-heading"><h2>Invoices from unknown suppliers</h2><p>${esc(reviewerDetail[current] || "")}</p></div><p class="footer-note" style="margin:0">Set by procurement (administrator role). A supplier name that could not be read is always held for you, never rejected.</p></section>`;
  return `<section class="card settings-card"><div class="section-heading"><h2>Invoices from unknown suppliers</h2><p>When an invoice names a supplier that is not in the register below, Invoice AI can reject it outright or hand it to you as an onboarding request.</p></div><div class="setting-options" role="radiogroup" aria-label="Invoices from unknown suppliers">${choices
    .map(
      (c) =>
        `<label class="setting-option${c.value === current ? " selected" : ""}"><input type="radio" name="unknown_supplier_action" value="${esc(c.value)}" data-setting="unknown_supplier_action" ${c.value === current ? "checked" : ""}><span class="setting-option-body"><b>${esc(c.label)}</b><small>${esc(detail[c.value] || "")}</small></span></label>`,
    )
    .join("")}</div><p class="footer-note" style="margin:0">Applies to invoices processed from now on; decisions already taken are not revisited. A supplier name that could not be read is always held for a reviewer, never rejected — an unreadable name is uncertainty, not evidence that a supplier is absent.</p><div id="setting-error"></div></section>`;
}
// Instant apply: a rule with a Save button invites a half-set state, and the
// server is the only place the choice actually lives. On failure the radio is
// put back where it was, so what is shown never outruns what is stored.
async function saveSetting(name, value) {
  const previous = state.settings?.[name];
  const box = $("#setting-error");
  if (box) box.innerHTML = "";
  document.querySelectorAll(`[data-setting="${name}"]`).forEach((input) => {
    input.disabled = true;
    input.closest(".setting-option")?.classList.toggle("selected", input.value === value);
  });
  try {
    state.settings = await api("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [name]: value }),
    });
    notice(value === "reject"
      ? "Invoices from unknown suppliers are now rejected automatically."
      : "Invoices from unknown suppliers are now held, with an onboarding request for you.");
  } catch (err) {
    document.querySelectorAll(`[data-setting="${name}"]`).forEach((input) => {
      input.checked = input.value === previous;
      input.closest(".setting-option")?.classList.toggle("selected", input.value === previous);
    });
    if (box) box.innerHTML = `<p class="error-text">${esc(err.message || "The setting could not be saved.")}</p>`;
  } finally {
    document.querySelectorAll(`[data-setting="${name}"]`).forEach((i) => (i.disabled = false));
  }
}
async function master(kind, generation) {
  const isPO = kind === "pos";
  const [pos, vendors, workspace] = await Promise.all([
    api("/api/pos"),
    api("/api/vendors"),
    // The unknown-supplier rule belongs with the register it depends on, so it
    // is only fetched (and shown) on the Suppliers page.
    isPO ? Promise.resolve(null) : api("/api/settings").catch(() => null),
  ]);
  if (generation !== state.generation) return;
  state.pos = pos;
  state.vendors = vendors;
  state.settings = workspace ?? state.settings;
  $("#main").innerHTML =
    header(
      isPO ? "Purchase orders" : "Suppliers",
      isPO
        ? "Check the authorized budget available for each supplier."
        : "Suppliers your team has approved for invoice processing.",
    ) +
    (isAdmin()
      ? `<details class="card form-card"><summary>${isPO ? "Add an authorized purchase order" : "Add an approved supplier"}</summary><p style="margin-top:10px;font-size:12px">${isPO ? "Enter an existing authorization from procurement." : "Confirm that your team has approved this supplier before adding it here."}</p><form data-form="${isPO ? "master-po" : "master-vendor"}" class="form-grid two">${
          isPO
            ? `<label>Purchase order number<input name="po_id" placeholder="PO-1005" required></label><label>Supplier<select name="supplier_id" required><option value="">Choose a supplier…</option>${vendors
                .filter((v) => v.status === "approved")
                .map(
                  (v) =>
                    `<option value="${esc(v.supplier_id)}">${esc(v.name)}</option>`,
                )
                .join(
                  "",
                )}</select></label><label>Currency<input name="currency" placeholder="USD" required></label><label>Authorized amount<input name="amount" inputmode="decimal" placeholder="10000.00" required></label>`
            : '<label>Supplier legal name<input name="name" required></label><label>Country (optional)<input name="country"></label>'
        }<button class="primary full">${isPO ? "Add purchase order" : "Add supplier"}</button></form></details>`
      : `<p class="footer-note" style="margin-top:0">${isPO ? "Purchase orders are managed by procurement (administrator role). You can check balances here; ask procurement to raise or amend an order." : "Suppliers are managed by procurement (administrator role). You can check who is approved here; ask procurement to onboard a new supplier."}</p>`) +
    (isPO
      ? `<section class="card"><div class="table-scroll"><table><thead><tr><th>Purchase order</th><th>Supplier</th><th>Approved billing</th><th class="amount">Remaining budget</th><th>Status</th></tr></thead><tbody>${pos
          .map(
            (p) =>
              `<tr id="po-${esc(p.po_id)}"><td><div class="cell-stack"><b>${esc(p.po_id)}</b>${p.invoices?.length ? `<button type="button" class="text small linked" data-action="show-po-invoices" data-id="${esc(p.po_id)}">Invoices (${p.invoices.length})</button>` : '<small class="muted-line">No invoices yet</small>'}</div></td><td><a href="#vendors/${encodeURIComponent(p.supplier_id)}">${esc(vendors.find((v) => v.supplier_id === p.supplier_id)?.name || p.supplier_id)}</a></td><td>${esc(money(p.consumed_minor, p.currency))}<small>of ${esc(money(p.amount_minor, p.currency))}</small><div class="budget-track"><span style="width:${Math.max(0, Math.min(100, (p.consumed_minor / Math.max(1, p.amount_minor)) * 100))}%"></span></div></td><td class="amount">${esc(money(p.amount_minor - p.consumed_minor, p.currency))}</td><td><div class="cell-stack"><span class="badge ${p.status === "open" ? "approved" : ""}">${esc(p.status === "open" ? "Open" : "Closed")}</span>${isAdmin() ? `<button type="button" class="text small linked" data-action="manage-po" data-id="${esc(p.po_id)}">Manage</button>` : ""}</div></td></tr>`,
          )
          .join(
            "",
          )}</tbody></table></div>${!pos.length ? '<div class="empty"><p>No purchase orders yet. Add an authorized order to get started.</p></div>' : ""}</section><p class="footer-note">Held and rejected invoices use no budget. ${isAdmin() ? "Amending an order can never lower it below the billing already approved against it." : "Only procurement (administrator role) can raise, amend or close purchase orders."}</p>`
      : unknownSupplierRuleHTML(workspace) + `<div class="supplier-grid">${vendors
          .map((v) => {
            const referenced = (v.total_pos || 0) + (v.invoices || 0) > 0;
            return `<section class="card supplier-card" id="vendor-${esc(v.supplier_id)}"><h2 style="font-size:15px">${esc(v.name)}</h2><p>${esc(v.country || "Country not specified")}</p><div class="linked-row">${(() => { const n = pos.filter((p) => p.supplier_id === v.supplier_id).length; return n ? `<button type="button" class="text small linked" data-action="show-vendor-pos" data-id="${esc(v.supplier_id)}">Purchase orders (${n})</button>` : '<small class="muted-line">No purchase orders yet</small>'; })()}${v.invoices ? `<a class="linked" href="#invoices/${encodeURIComponent(v.name)}">Invoices (${v.invoices}) →</a>` : ""}</div><span class="badge ${v.status === "approved" ? "approved" : "blocked"}">${esc(v.status === "approved" ? "Approved supplier" : "Blocked")}</span><p class="meta">${referenced ? `${v.invoices || 0} invoice${v.invoices === 1 ? "" : "s"} · ${v.total_pos || 0} purchase order${v.total_pos === 1 ? "" : "s"} on record` : "No invoices or purchase orders yet"}</p>${v.aliases?.length ? `<p class="meta">Also known as: ${esc(v.aliases.join(", "))}</p>` : ""}${isAdmin() ? `<details class="manage-actions"><summary>Manage supplier</summary><div class="supplier-actions"><button class="small" data-action="edit-vendor" data-id="${esc(v.supplier_id)}" aria-expanded="false">Edit</button>${v.status === "approved" ? `<button class="small" data-action="block-vendor" data-id="${esc(v.supplier_id)}">Block</button>` : `<button class="small" data-action="unblock-vendor" data-id="${esc(v.supplier_id)}">Approve again</button>`}<button class="small danger" data-action="delete-vendor" data-id="${esc(v.supplier_id)}" ${referenced ? 'title="Suppliers with invoices or purchase orders cannot be deleted — block them instead"' : ""}>Delete</button></div><form class="edit-vendor" data-form="edit-vendor" data-id="${esc(v.supplier_id)}" hidden><label>Supplier legal name<input name="name" value="${esc(v.name)}" required></label><label>Country<input name="country" value="${esc(v.country || "")}" placeholder="US"></label><label>Other names (subsidiaries, brands — comma-separated)<input name="aliases" value="${esc((v.aliases || []).join(", "))}" placeholder="White Group, WG Trading"></label><div class="button-row"><button class="primary small">Save changes</button><button type="button" class="small" data-action="edit-vendor" data-id="${esc(v.supplier_id)}">Cancel</button></div><small>Renaming keeps the old name recognised, so invoices that still print it will match.</small></form></details>` : ""}</section>`;
          })
          .join(
            "",
          )}</div><p class="footer-note">${isAdmin() ? "Blocking a supplier rejects its future invoices without deleting history. Deleting is only possible for suppliers with no invoices or purchase orders." : "Only procurement (administrator role) can onboard, edit or block suppliers."}</p>`);
}
async function queue(generation) {
  const [items, tickets, runs, vendors, pos] = await Promise.all([
    isAdmin() ? api("/api/queue/procurement") : Promise.resolve([]),
    api("/api/tickets?status=all"),
    api("/api/runs"),
    api("/api/vendors"),
    api("/api/pos"),
  ]);
  state.vendors = vendors;
  state.pos = pos;
  if (generation !== state.generation) return;
  state.runs = runs;
  state.allTickets = tickets;
  state.detectedNeeds = InvoiceWorkflow.unrequestedNeeds(items, tickets, runs);
  $("#queue-count").textContent =
    tickets.filter((t) => t.status === "open").length || "";
  $("#main").innerHTML =
    header(
      isAdmin() ? "Requests" : "My requests",
      isAdmin()
        ? "Help reviewers move forward. Update the supplier or order, then reply."
        : "Follow what you’ve asked procurement to update, and pick up their replies.",
      isAdmin()
        ? '<button data-action="reload">Refresh requests</button>'
        : '<button class="primary" data-action="new-request">New request</button>',
    ) +
    `<section class="card"><div class="inbox-tools"><div class="filters" id="request-filters" aria-label="Filter requests"></div><input class="search" id="request-search" aria-label="Search requests" placeholder="Search supplier, order or note" value="${esc(state.requestSearch)}"></div><div id="request-list"></div></section>${isAdmin() ? `<details class="card detected-needs"><summary>Invoices that may need help (${state.detectedNeeds.length})</summary><p>No open request covers these items. Open an invoice to see what’s needed.</p>${state.detectedNeeds.map((it) => `<div class="request-row"><div><b>${esc(it.supplier_name || "Supplier not read")}</b><small>${esc(it.filename)}</small><p>${it.asks.map((a) => esc(a.text)).join(" · ")}</p></div><a class="button-link" href="#invoice/${encodeURIComponent(latestDescendant(it.run_id))}">View invoice →</a></div>`).join("") || "<p>No additional invoices need procurement.</p>"}</details>` : ""}`;
  renderRequests();
}
function renderRequests() {
  const tickets = state.allTickets;
  $("#request-filters").innerHTML = [
    ["open", isAdmin() ? "To do" : "Waiting"],
    ["resolved", "Completed"],
    ["declined", "Declined"],
    ["all", "All"],
  ]
    .map(
      ([key, label]) =>
        `<button class="filter ${state.requestFilter === key ? "active" : ""}" data-request-filter="${key}" aria-pressed="${state.requestFilter === key}">${label}<span>${tickets.filter((t) => key === "all" || t.status === key).length}</span></button>`,
    )
    .join("");
  const q = state.requestSearch.toLowerCase();
  const list = tickets.filter(
    (t) =>
      (state.requestFilter === "all" || t.status === state.requestFilter) &&
      [
        t.supplier_name,
        t.filename,
        t.po_reference,
        t.note,
        t.resolution_note,
        t.kind_label,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q),
  );
  $("#request-list").innerHTML =
    list
      .map(
        (t) =>
          `<article class="request-row"><div class="request-main"><div class="request-title"><h2>${esc(t.supplier_name || "Supplier not read")}</h2><span class="badge ${esc(t.status)}">${t.status === "open" ? (isAdmin() ? "To do" : "With procurement") : t.status === "resolved" ? "Completed" : "Declined"}</span></div><p>${esc(t.kind_label || TICKET_KINDS[t.kind])}${t.po_reference ? ` · ${esc(t.po_reference)}` : ""}${t.standalone && t.amount_minor != null ? ` · ${esc(money(t.amount_minor, t.currency))}` : ""}</p><small>${t.requested_by === "invoice-ai" ? "AI-created · " : ""}${esc(t.standalone ? "Raised from My requests" : t.filename)} · ${esc(date(t.created_at))}</small>${t.note ? `<p class="request-note">${esc(t.note)}</p>` : ""}${t.status === "open" && t.fulfilled ? `<p class="saved-mark">✓ ${esc(t.fact)} Closing automatically.</p>` : ""}${t.status !== "open" ? `<div class="request-answer"><b>Procurement’s reply</b><p>${esc(t.resolution_note || "No note was included.")}</p></div>` : ""}</div>${
            t.standalone
              ? isAdmin() && t.status === "open"
                ? `<button class="button-link primary" data-action="resolve-standalone" data-id="${esc(t.ticket_id)}">Resolve request</button>`
                : t.kind === "raise_po" && t.supplier_id
                  ? `<a class="button-link" href="#vendors/${encodeURIComponent(t.supplier_id)}">View supplier →</a>`
                  : `<a class="button-link" href="#vendors">Suppliers →</a>`
              : `<a class="button-link ${t.status === "open" && isAdmin() ? "primary" : ""}" href="#invoice/${encodeURIComponent(latestDescendant(t.run_id))}">${isAdmin() ? (t.status === "open" ? "Resolve request" : "View invoice") : t.status === "resolved" ? "Open invoice" : "View request"} →</a>`
          }</article>`,
      )
      .join("") ||
    `<div class="empty"><h2>${q ? "No matching requests" : state.requestFilter === "open" ? "No requests waiting" : "No requests here yet"}</h2><p>${q ? "Try a different supplier, order number or note." : isAdmin() ? "AI-created requests and reviewer requests will appear here." : "Ask from an invoice, or use New request above for a supplier or purchase order you know you will need."}</p><a href="#invoices">${isAdmin() ? "View invoice history" : "Go to invoice reviews"} →</a></div>`;
}
async function refreshQueueCount() {
  if (!isAdmin()) return;
  try {
    const tickets = await api("/api/tickets?status=open");
    $("#queue-count").textContent = tickets.length || "";
  } catch (e) {
    $("#queue-count").textContent = "";
  }
}
async function activity(generation) {
  const events = await api("/api/audit");
  if (generation !== state.generation) return;
  $("#main").innerHTML =
    header(
      "Activity log",
      "A record of invoice checks, review decisions and supplier updates.",
    ) +
    `<section class="card card-pad">${events.length ? events.map((e) => `<div class="activity-row"><time>${esc(dateTime(e.ts))}</time><div><a href="#invoice/${encodeURIComponent(e.run_id)}">${esc(e.filename || "Invoice")}</a><p>${esc(activityText(e))}</p></div></div>`).join("") : '<div class="empty"><p>Activity will appear after you upload an invoice.</p></div>'}</section>`;
}
const PROBE_ICON = {
  confirmed: "✅",
  not_reproduced: "⚠️",
  unexpected: "❌",
  error: "❌",
  skipped: "—",
};
const PROBE_LABEL = {
  confirmed: "Verified",
  not_reproduced: "Not reproducible",
  unexpected: "Differs from this row",
  error: "Probe error",
  skipped: "Not run",
};
// Mirrors Observation.line() in tools/edge_case_probe.py: what the run did.
function observedLine(o) {
  const bits = [];
  if (o.http_status != null) bits.push(`HTTP ${o.http_status}`);
  if (o.route) bits.push(o.route + (o.codes?.length ? ` [${o.codes.join(", ")}]` : ""));
  if (o.run_status && o.run_status !== "completed") bits.push(`run ${o.run_status}`);
  if (o.failure_reason) bits.push(`reason “${o.failure_reason}”`);
  if (o.doc_type) bits.push(`type “${o.doc_type}”`);
  if (o.model_calls != null)
    bits.push(`${o.model_calls} model call${o.model_calls === 1 ? "" : "s"}`);
  if (o.posted != null) bits.push(o.posted ? "posted" : "nothing posted");
  if (o.error) bits.push(`error ${o.error}`);
  return bits.join(" · ");
}
function probeCell(probe) {
  if (!probe)
    return '<span class="probe-none">Not run</span>';
  const icon = PROBE_ICON[probe.verdict] || "?";
  const label = PROBE_LABEL[probe.verdict] || probe.verdict;
  const when = probe.ran_at ? ` <span class="probe-when">${esc(date(probe.ran_at))}</span>` : "";
  const runs = (probe.observations || [])
    .map(
      (o) =>
        `<li><span class="probe-observed">${esc(observedLine(o))}</span>${o.note ? `<span class="probe-note">${esc(o.note)}</span>` : ""}${o.result_file ? `<button class="link-button" data-action="open-result" data-result="${esc(o.result_file)}" data-fixture="${esc(o.fixture)}">Open saved result →</button>` : `<span class="probe-none">${esc(o.fixture)} — refused before a result existed</span>`}</li>`,
    )
    .join("");
  return `<div class="probe probe-${esc(probe.verdict)}"><span class="probe-verdict">${icon} ${esc(label)}${when}</span>${runs ? `<ul class="probe-runs">${runs}</ul>` : ""}${probe.note ? `<p class="probe-caveat">${esc(probe.note)}</p>` : ""}</div>`;
}
// The saved result of a probe upload, rendered from the record on disk. No
// upload, no reading, no decision is made here — this is what happened then.
async function openResult(name, fixture) {
  let data;
  try {
    data = await api(`/api/edge-cases/result/${encodeURIComponent(name)}`);
  } catch (e) {
    notice("That saved result is not on the server. Re-run tools/edge_case_probe.py to rebuild it.");
    return;
  }
  const run = data.run || {};
  const api_response = data.api_response || {};
  const detail = api_response.detail || {};
  const codes = api_response.codes || run.snapshot?.codes || detail.codes || [];
  const docType = (data.events || [])
    .filter((e) => e.event_type === "document_type")
    .at(-1)?.payload;
  const fields = data.fields || {};
  const fieldRows = Object.entries(fields)
    .map(
      ([nm, rec]) =>
        `<tr><td>${esc(human(nm))}</td><td>${esc(rec.raw_value ?? "—")}</td><td>${esc(rec.status)}</td><td>${esc(
          Object.entries(rec.checks || {})
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ") || "—",
        )}</td></tr>`,
    )
    .join("");
  const events = (data.events || [])
    .map(
      (e) =>
        `<div class="activity-row"><time>${esc(e.stage || "")}</time><p>${esc(activityText(e))}</p></div>`,
    )
    .join("");
  const badgeFor = { approved: "approved", held: "held", rejected: "rejected" };
  const state = run.run_status === "failed" ? "failed" : run.disposition || "queued";
  openModal({
    title: "Saved result",
    subtitle: `${fixture} · uploaded as ${data.uploaded_as || fixture} · recorded run ${run.run_id || "—"}`,
    body: `<div class="saved-result"><div class="saved-head"><span class="badge ${esc(badgeFor[state] || state)}">${esc(
      { approved: "Approved", held: "Needs review", rejected: "Rejected", failed: "Couldn’t process" }[state] || state,
    )}</span>${codes.length ? codes.map((c) => `<span class="code-chip">${esc(c)}</span>`).join("") : ""}</div>${
      api_response.explanation || detail.error
        ? `<p class="saved-explanation">${esc(api_response.explanation || detail.error)}</p>`
        : ""
    }<dl class="saved-facts"><div><dt>HTTP status</dt><dd>${esc(String(data.http_status ?? "—"))}</dd></div><div><dt>Route</dt><dd>${esc(api_response.route || "—")}</dd></div><div><dt>Run status</dt><dd>${esc(run.run_status || "—")}</dd></div><div><dt>Failure reason</dt><dd>${esc(run.failure_reason || "—")}</dd></div><div><dt>Posted to the ledger</dt><dd>${api_response.posted ? "yes" : "no"}</dd></div><div><dt>Model calls</dt><dd>${esc(String(data.model_calls ?? "—"))}</dd></div><div><dt>Pages</dt><dd>${esc(String((data.events || []).find((e) => e.event_type === "classified")?.payload?.pages ?? "—"))}</dd></div></dl>${
      docType
        ? `<h3>Document type</h3><p class="saved-doctype"><b>${esc(docType.label || docType.kind)}</b>${docType.forced ? " (read as an invoice on the reviewer’s instruction)" : ""}</p><ul>${(docType.reasons || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
        : ""
    }${
      fieldRows
        ? `<h3>What the reader returned</h3><div class="edge-table-wrap"><table class="edge-table"><thead><tr><th>Field</th><th>Value read</th><th>Status</th><th>Code checks</th></tr></thead><tbody>${fieldRows}</tbody></table></div>`
        : '<h3>What the reader returned</h3><p class="muted">Nothing — no field revision was saved, so there is no review form to fill in.</p>'
    }${events ? `<h3>Activity recorded for this run</h3>${events}` : ""}</div>`,
  });
}
async function edgeCases(generation) {
  const data = await api("/api/edge-cases");
  if (generation !== state.generation) return;
  const L = data.limits;
  const cases = data.groups.flatMap((g) => g.cases);
  const total = cases.length;
  const handled = cases.filter((c) => c.status === "handled").length;
  const verdicts = {};
  for (const c of cases) {
    const v = c.probe?.verdict || "skipped";
    verdicts[v] = (verdicts[v] || 0) + 1;
  }
  const probe = data.probe || {};
  const chip = (c) =>
    c.status === "handled"
      ? '<span class="badge approved">Handled</span>'
      : '<span class="badge held">Known limitation</span>';
  $("#main").innerHTML =
    header(
      "Edge cases: faulty and non-invoice PDFs",
      "Everything we check before a document reaches the review desk, what happens when a check fails, and what happened when we last ran each case.",
    ) +
    `<div class="edge-content"><section class="card edge-intro"><div class="edge-stats"><div><strong>${total}</strong><span>cases catalogued</span></div><div><strong>${handled}</strong><span>detected automatically</span></div><div><strong>${verdicts.confirmed || 0}</strong><span>verified by running them</span></div><div><strong>${total - handled}</strong><span>documented limitations</span></div></div><p>Rule of thumb: a file that is not an invoice never opens a review form. It is refused at upload, marked <b>Couldn’t process</b> with the exact reason, or <b>Rejected</b> as an unsupported document, all before any model call and with no financial effect.</p>${probe.generated_at ? `<p class="probe-banner"><b>Verified ${esc(dateTime(probe.generated_at))}</b> against the live reader <code>${esc(probe.model || "")}</code>. Each case below was run for real: a fixture file was uploaded to a fresh workspace, and the route, reason codes, failure reason and number of model calls were read back from the run. Open any row’s saved result to see the decision, reason codes, document-type verdict, every field the reader returned and the full activity trail — read from the record, with nothing re-run. Everything is kept under <code>evidence/edge-cases/</code>.</p>` : '<p class="probe-banner">No verification run recorded yet. Run <code>venv/bin/python tools/edge_case_probe.py</code> to fill in the Verified column.</p>'}<dl class="edge-limits"><div><dt>Upload size</dt><dd>${L.max_upload_mb} MB</dd></div><div><dt>Pages</dt><dd>${L.max_pages}</dd></div><div><dt>Scan threshold</dt><dd>&lt; ${L.scan_text_threshold_chars} chars of text</dd></div><div><dt>Garbled text</dt><dd>&lt; ${Math.round(L.garbled_alnum_ratio * 100)}% letters/digits</dd></div><div><dt>Model budget</dt><dd>${L.model_calls_per_document} calls · ${L.model_retries_per_document} retries · ${L.model_wall_seconds}s · ${L.model_token_cap.toLocaleString()} tokens</dd></div></dl></section>${data.groups
      .map(
        (g) => `<section class="card edge-group" id="edge-${esc(g.id)}"><h2>${esc(g.title)}</h2><p class="edge-summary">${esc(g.summary)}</p><div class="edge-table-wrap"><table class="edge-table"><thead><tr><th>Case</th><th>How it is detected</th><th>What happens</th><th>What you see / do next</th><th>Status</th><th>Verified</th></tr></thead><tbody>${g.cases
          .map(
            (c) => `<tr id="edge-${esc(c.id)}"><td><b>${esc(c.title)}</b></td><td>${esc(c.detection)}</td><td>${esc(c.outcome)}</td><td>${esc(c.next_step)}</td><td>${chip(c)}${c.test ? `<small class="edge-test" title="Automated test covering this case">${esc(c.test)}</small>` : ""}</td><td>${probeCell(c.probe)}</td></tr>`,
          )
          .join("")}</tbody></table></div></section>`,
      )
      .join("")}<a href="#invoices">← Back to invoices</a></div>`;
}
function help() {
  $("#main").innerHTML =
    header(
      "A simpler way to review invoices",
      "Upload, check, and act only where your help is needed.",
    ) +
    `<div class="help-content"><section class="card"><h2>Your invoice journey</h2><ol><li><b>Upload a PDF.</b> We read the details and check the supplier, purchase order and amounts.</li><li><b>See the result.</b> Eligible invoices are approved automatically. Invoices that need your help appear under Needs attention.</li><li><b>Resolve the highlighted items.</b> Compare the details with the original, save corrections, and select a purchase order. AI independently verifies scan readings where possible. Confirm only the values that remain uncertain.</li><li><b>Check again.</b> All rules run again. Passing invoices are approved; anything unresolved gets a next step.</li></ol><h3>What the statuses mean</h3><p><b>Approved:</b> The amount was added to the approved purchase order balance. An exception label means a permitted small budget overage.</p><p><b>Needs review:</b> Nothing was approved. Open the invoice for corrections or next steps.</p><p><b>Rejected:</b> No amount was added. The invoice explains why, including duplicates and blocked suppliers.</p><p><b>Couldn’t process:</b> The document could not be read. Retry an interrupted reading or upload a replacement PDF.</p></section><section class="card"><h2>If you can’t resolve an invoice</h2><p>Keep it pending while you ask your supplier or procurement team for the missing information. Reject it with a reason if it should not proceed.</p><p>Anything that needs master data — a new or blocked supplier, a missing or too-small purchase order — is automatically sent to procurement when a verified supplier or PO is missing. Additional requests can be raised from the invoice. A same-day match can be confirmed as a separate invoice with a recorded reason; exact duplicates are final. The demo never reverses an approval or sends a payment.</p><p>Each invoice keeps its original document, earlier attempts, decision explanation and technical evidence under <b>Decision details & activity</b>.</p></section><section class="card"><h2>Roles</h2><p><b>Invoice reviewer</b> uploads, corrects, approves and rejects. <b>Procurement admin</b> manages suppliers and purchase orders and works the procurement queue, but cannot approve — the person who creates the budget is never the person who releases money against it. Every action is recorded with the role that performed it, and the server enforces the split on every request.</p><p>There is no sign-in: use <b>Switch to procurement</b> / <b>Switch to invoice review</b> in the top bar to change role. The server still enforces what each role may do.</p></section><section class="card"><h2>Your workspace</h2><p>This demo is public, so each browser gets its own workspace. The invoices you upload, the purchase-order budgets you spend and the settings you change are yours alone — nobody else testing right now can see them, and they cannot spend your budgets.</p><p class="muted" id="workspace-line">Checking your workspace…</p><h3>Reset</h3><p>Reset removes every invoice, review and approval in <b>your</b> workspace and restores the example suppliers and purchase orders, so you can run a scenario again from the start. It does not touch anyone else's. This cannot be undone.</p><button class="danger" data-action="reset">Reset my workspace</button><div id="reset-error"></div></section><a href="#invoices">← Back to invoices</a></div>`;
  describeWorkspace();
}
async function describeWorkspace() {
  const line = $("#workspace-line");
  if (!line) return;
  try {
    const w = await api("/api/workspace");
    const counts = w.counts || {};
    line.textContent = w.shared
      ? "This browser is using the shared demo workspace, because it could not store an id. Anyone else without an id shares it with you."
      : `Your workspace holds ${counts.invoices} invoice${counts.invoices === 1 ? "" : "s"}, ${counts.suppliers} suppliers and ${counts.orders} purchase orders. It is kept for this browser only.`;
  } catch (e) {
    line.textContent = "Your workspace could not be read just now.";
  }
}
async function withAction(container, fn) {
  if (state.busy) return;
  state.busy = true;
  const buttons = [...container.querySelectorAll("button")].map((b) => [
    b,
    b.disabled,
  ]);
  buttons.forEach(([b]) => (b.disabled = true));
  container.querySelector(".action-error")?.remove();
  try {
    await fn();
  } catch (e) {
    formError(container, e);
  } finally {
    state.busy = false;
    buttons.forEach(([b, disabled]) => {
      if (b.isConnected) b.disabled = disabled;
    });
  }
}
async function reviewPost(path, body) {
  return post(
    `/api/runs/${encodeURIComponent(state.detail.run_id)}/review/${path}`,
    body,
  );
}
async function refreshDetail(exclude = []) {
  const id = state.detail.run_id;
  const notes = [...document.querySelectorAll("form[data-form] textarea")]
    .filter((i) => i.value)
    .map((i) => [
      i.form.dataset.form,
      i.form.dataset.id || i.form.dataset.kind || "",
      i.name,
      i.value,
    ]);
  const drafts = [...document.querySelectorAll("[data-original]")]
    .filter(
      (i) =>
        i.value.trim() !== i.dataset.original &&
        !exclude.includes(i.id.replace("input-", "")),
    )
    .map((i) => [i.id, i.value]);
  await detail(id, state.generation);
  for (const [type, key, name, value] of notes) {
    const form = [...document.querySelectorAll("form[data-form]")].find(
      (f) =>
        f.dataset.form === type &&
        (f.dataset.id || f.dataset.kind || "") === key,
    );
    const input = form?.elements.namedItem(name);
    if (input) input.value = value;
  }
  for (const [inputId, value] of drafts) {
    const i = document.getElementById(inputId);
    if (i) {
      i.value = value;
      i.dispatchEvent(new Event("input", { bubbles: true }));
      i.closest("details")?.setAttribute("open", "");
    }
  }
}
async function submitForm(form) {
  const type = form.dataset.form;
  const body = Object.fromEntries(new FormData(form));
  await withAction(form, async () => {
    if (type === "context-amend-po") {
      await api(`/api/pos/${encodeURIComponent(form.dataset.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: body.amount.trim() }),
      });
      await refreshDetail();
      refreshQueueCount();
      notice("Order updated. Reply to the reviewer to finish the request.");
    } else if (type === "field") {
      const field = form.dataset.field;
      const rec = state.review.fields[field] || {};
      const value = body.value.trim();
      const unchangedScan =
        rec.read_method === "llm_vision" &&
        rec.status === "selected" &&
        !selfVerified(rec) &&
        value === (rec.raw_value || "").trim() &&
        !["attested", "corrected"].includes(rec.review_status);
      if (unchangedScan)
        // the reviewer confirms the reading as it stands: recorded as an attestation
        await reviewPost("attest", {
          fields: [field],
          expected_seq: state.review.revision_seq,
        });
      else
        await reviewPost("correct", {
          field,
          value,
          expected_seq: state.review.revision_seq,
        });
      await refreshDetail([field]);
      notice(unchangedScan ? `${FIELD[field] || field} confirmed.` : `${FIELD[field] || field} saved.`);
    } else if (type === "standalone-request") {
      const res = await post("/api/requests", {
        kind: body.kind,
        subject: (body.subject || "").trim() || null,
        supplier_id: body.supplier_id || null,
        amount: (body.amount || "").trim() || null,
        currency: (body.currency || "").trim().toUpperCase() || null,
        note: (body.note || "").trim(),
      });
      closeModal();
      notice(res.existing ? "That request is already open with procurement." : "Request sent to procurement.");
      await route();
    } else if (type === "onboard" && form.dataset.standalone) {
      const res = await post("/api/vendors", { name: body.name.trim(), country: (body.country || "").trim() || null });
      const ticketId = document.querySelector("#app-modal form[data-form=resolve-ticket]")?.dataset.id;
      closeModal();
      notice(res.settled?.length ? "Supplier added. The request is complete." : "Supplier added. Now add its order.");
      await route();
      if (!res.settled?.length && ticketId) document.querySelector(`[data-action=resolve-standalone][data-id="${ticketId}"]`)?.click();
    } else if (type === "create-po" && form.dataset.standalone) {
      const res = await post("/api/pos", { ...body, supplier_id: form.dataset.supplier });
      closeModal();
      notice(res.settled?.length ? "Purchase order added. The request is complete." : "Purchase order added.");
      await route();
    } else if (type === "add-alias" && form.dataset.standalone) {
      const res = await api(`/api/vendors/${encodeURIComponent(body.supplier_id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ add_aliases: [form.dataset.subject] }),
      });
      closeModal();
      notice(res.settled?.length ? `“${form.dataset.subject}” registered under ${res.name}. The request is complete.` : `“${form.dataset.subject}” registered under ${res.name}.`);
      await route();
    } else if (type === "map-supplier") {
      const vendor = state.vendors.find((v) => v.supplier_id === body.supplier_id);
      if (!vendor) throw new ApiError("Choose a supplier from the list.");
      const first = await reviewPost("correct", {
        field: "supplier_name",
        value: vendor.name,
        expected_seq: state.review.revision_seq,
      });
      if (body.po)
        await reviewPost("correct", {
          field: "po_reference",
          value: body.po,
          expected_seq: first.revision_seq,
        });
      await refreshDetail(["supplier_name", "po_reference"]);
      notice(
        body.po
          ? `Supplier set to ${vendor.name}; ${body.po} selected.`
          : `Supplier set to ${vendor.name}. Choose its purchase order next.`,
      );
    } else if (type === "pick-po") {
      await reviewPost("correct", {
        field: "po_reference",
        value: body.po,
        expected_seq: state.review.revision_seq,
      });
      await refreshDetail(["po_reference"]);
      notice("Purchase order selected.");
    } else if (type === "onboard") {
      const res = await post("/api/vendors", {
        name: body.name.trim(),
        country: (body.country || "").trim() || null,
        run_id: state.detail.run_id,
      });
      if (!isAdmin() && body.name.trim() !== raw("supplier_name"))
        await reviewPost("correct", {
          field: "supplier_name",
          value: body.name.trim(),
          expected_seq: state.review.revision_seq,
        });
      await refreshDetail(["supplier_name"]);
      refreshQueueCount();
      notice(
        isAdmin()
          ? res.settled?.length ? "Supplier added. The request is complete — the reviewer can continue." : "Supplier added. Now add its purchase order."
          : "Supplier added. You can now choose a purchase order.",
      );
    } else if (type === "add-alias") {
      const printed = raw("supplier_name").trim();
      const res = await api(`/api/vendors/${encodeURIComponent(body.supplier_id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ add_aliases: [printed], run_id: state.detail.run_id }),
      });
      await refreshDetail();
      refreshQueueCount();
      notice(
        res.settled?.length
          ? `“${printed}” registered under ${res.name}. The request is complete — the reviewer can continue.`
          : `“${printed}” registered under ${res.name}.`,
      );
    } else if (type === "create-po") {
      const res = await post("/api/pos", {
        ...body,
        supplier_id: state.review.po_supplier_id,
        run_id: state.detail.run_id,
      });
      if (!isAdmin())
        await reviewPost("correct", {
          field: "po_reference",
          value: body.po_id,
          expected_seq: state.review.revision_seq,
        });
      await refreshDetail(["po_reference"]);
      refreshQueueCount();
      notice(
        isAdmin()
          ? res.settled?.length ? "Purchase order added. The request is complete — the reviewer can continue." : "Purchase order added."
          : "Purchase order added and selected.",
      );
    } else if (type === "reject") {
      const id = state.detail.run_id;
      const key = `${id}:reject:${body.reason}`;
      state.decisionKeys[key] ??= crypto.randomUUID();
      const result = await reviewPost("reject", {
        reason: body.reason,
        idempotency_key: state.decisionKeys[key],
      });
      notice("Invoice rejected. Your reason has been recorded.");
      location.hash = `invoice/${result.run_id}`;
    } else if (type === "ticket") {
      const result = await post("/api/tickets", {
        run_id: state.detail.run_id,
        kind: body.kind,
        note: (body.note || "").trim(),
      });
      notice(
        result.existing
          ? "That request is already open with procurement."
          : "Request sent to procurement.",
      );
      await refreshDetail();
    } else if (type === "confirm-distinct") {
      await reviewPost("confirm-distinct", {
        note: body.note.trim(),
        expected_seq: state.review.revision_seq,
      });
      await refreshDetail();
      notice(
        "Recorded as a separate invoice. Check again to run the remaining checks.",
      );
    } else if (type === "resolve-ticket") {
      closeModal();
      const outcome = form.dataset.outcome || "resolved";
      await post(
        `/api/tickets/${encodeURIComponent(form.dataset.id)}/resolve`,
        {
          outcome,
          note: (body.note || "").trim(),
        },
      );
      notice(
        outcome === "resolved"
          ? "Reply sent. The reviewer can now continue."
          : "Request declined.",
      );
      refreshQueueCount();
      await route();
    } else if (type === "amend-po") {
      const id = form.dataset.id;
      await api(`/api/pos/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: body.amount.trim() }),
      });
      closeModal();
      notice(`${id} amended.`);
      await route();
    } else if (type === "edit-vendor") {
      const id = form.dataset.id;
      await api(`/api/vendors/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: body.name.trim(),
          country: body.country.trim(),
          aliases: (body.aliases || "").split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      notice("Supplier updated.");
      await route();
    } else if (type === "master-po" || type === "master-vendor") {
      await post(type === "master-po" ? "/api/pos" : "/api/vendors", body);
      notice(
        type === "master-po" ? "Purchase order added." : "Supplier added.",
      );
      await route();
    }
  });
}
async function handleAction(action, button) {
  if (action === "refresh-invoice") {
    await withAction(button.closest(".slot"), async () => {
      await refreshDetail();
      notice("Request status refreshed.");
    });
    return;
  }
  if (action === "context-reopen-po") {
    await withAction(button.closest(".callout"), async () => {
      await api(`/api/pos/${encodeURIComponent(button.dataset.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "open" }),
      });
      await refreshDetail();
      notice("Order reopened. Send the reviewer a reply.");
    });
    return;
  }
  if (action === "unblock-supplier") {
    const id = button.dataset.id;
    await withAction(button.closest(".callout"), async () => {
      await api(`/api/vendors/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      notice("Supplier approved again. The reviewer can check the invoice.");
      await route();
    });
    return;
  }
  if (action === "switch-role") {
    if (
      unsaved() &&
      !(await confirmAction(
        "Leave unsaved changes?",
        "Changes still in the input fields will be discarded.",
        "Switch role",
      ))
    )
      return;
    await switchRole(isAdmin() ? "reviewer" : "admin");
    return;
  }
  if (action === "retry-session") {
    await ensureSession();
    await route();
    return;
  }
  if (action === "amend-po") {
    const form = button.closest("td").querySelector("form.po-amend");
    form.hidden = !form.hidden;
    button.setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) form.querySelector("input").focus();
    return;
  }
  if (action === "close-po" || action === "reopen-po") {
    closeModal();
    const id = button.dataset.id;
    await withAction(button.closest("td"), async () => {
      await api(`/api/pos/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: action === "close-po" ? "closed" : "open",
        }),
      });
      notice(
        action === "close-po"
          ? `${id} closed. New invoices against it will hold.`
          : `${id} reopened.`,
      );
      await route();
    });
    return;
  }
  if (action === "delete-po") {
    closeModal();
    const id = button.dataset.id;
    if (
      !(await confirmAction(
        "Delete this purchase order?",
        "Orders with approved billing recorded against them cannot be deleted — close them instead.",
        "Delete order",
      ))
    )
      return;
    await withAction(button.closest("td"), async () => {
      await api(`/api/pos/${encodeURIComponent(id)}`, { method: "DELETE" });
      notice(`${id} deleted.`);
      await route();
    });
    return;
  }
  if (action === "edit-vendor") {
    const card = $(`#vendor-${CSS.escape(button.dataset.id)}`);
    const form = card?.querySelector("form.edit-vendor");
    if (!form) return;
    form.hidden = !form.hidden;
    card
      .querySelector('[data-action="edit-vendor"]')
      .setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) form.querySelector("input").focus();
    return;
  }
  if (action === "block-vendor" || action === "unblock-vendor") {
    const id = button.dataset.id;
    const card = $(`#vendor-${CSS.escape(id)}`);
    const blocking = action === "block-vendor";
    if (
      blocking &&
      !(await confirmAction(
        "Block this supplier?",
        "New invoices from a blocked supplier are rejected automatically. Existing approvals and history are kept. You can approve the supplier again later.",
        "Block supplier",
      ))
    )
      return;
    await withAction(card, async () => {
      await api(`/api/vendors/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: blocking ? "blocked" : "approved" }),
      });
      notice(blocking ? "Supplier blocked." : "Supplier approved again.");
      await route();
    });
    return;
  }
  if (action === "delete-vendor") {
    const id = button.dataset.id;
    const card = $(`#vendor-${CSS.escape(id)}`);
    if (
      !(await confirmAction(
        "Delete this supplier?",
        "This removes the supplier from the approved list. Suppliers with invoices or purchase orders on record cannot be deleted — block them instead.",
        "Delete supplier",
      ))
    )
      return;
    await withAction(card, async () => {
      await api(`/api/vendors/${encodeURIComponent(id)}`, { method: "DELETE" });
      notice("Supplier deleted.");
      await route();
    });
    return;
  }
  if (action === "welcome-tab") { welcome.tab = button.dataset.tab; renderWelcomeIntake(); return; }
  if (action === "welcome-source") { welcome.source = button.dataset.kind; renderWelcomeIntake(); return; }
  if (action === "welcome-dataset") { welcome.dataset = button.dataset.dataset; renderWelcomeBatches(); return; }
  if (action === "welcome-connect") { cloudImportModal(welcome.source); return; }
  if (action === "clear-staged") { welcome.files = []; renderWelcomeIntake(); return; }
  if (action === "process-staged") { upload(welcome.files); return; }
  if (action === "upload") {
    $("#file-input").click();
    return;
  }
  if (action === "sample-select-all") {
    const boxes = button.closest("form").querySelectorAll("input[name=names]");
    const all = [...boxes].some((b) => b.checked);
    boxes.forEach((b, i) => (b.checked = !all && i < 25));
    updateSampleSelection(button.closest("form"));
    button.textContent = all ? (boxes.length > 25 ? "Select first 25" : "Select all") : "Clear selection";
    return;
  }
  if (action === "cloud-import") {
    cloudImportModal();
    return;
  }
  if (action === "browse-source") {
    browseSource(button.dataset.kind);
    return;
  }
  if (action === "reset-folder") {
    saveFolderSettings(button.closest("form"), { reset: true });
    return;
  }
  if (action === "import-folder-all") {
    importFolderAll();
    return;
  }
  if (action === "inbox") {
    location.hash = "invoices";
    return;
  }
  if (action === "reload") {
    await route();
    return;
  }
  if (action === "clear-filters") {
    state.filter = "all";
    state.search = "";
    $("#search").value = "";
    renderRows();
    return;
  }
  if (action === "toggle-preview") {
    const open = $(".document-panel").classList.toggle("expanded");
    button.textContent = open ? "Hide document" : "Show document";
    button.setAttribute("aria-expanded", String(open));
    return;
  }
  if (action === "previous-page" || action === "next-page") {
    state.page += action === "next-page" ? 1 : -1;
    drawPage();
    return;
  }
  if (action === "retry-preview") {
    await renderDocument(state.detail.run_id, state.generation);
    return;
  }
  if (action === "open-result") {
    await openResult(button.dataset.result, button.dataset.fixture);
    return;
  }
  if (action === "retry-reading" || action === "read-as-invoice") {
    const id = state.detail.run_id;
    const query = action === "read-as-invoice" ? "?as_invoice=true" : "";
    beginLive(state.detail.filename, () =>
      post(
        `/api/runs/${encodeURIComponent(id)}/retry${query}`,
        {},
        { timeout: 180000 },
      ),
    );
    return;
  }
  if (action === "new-request") {
    const approved = state.vendors.filter((v) => v.status === "approved").sort((a, b) => a.name.localeCompare(b.name));
    openModal({
      title: "New request to procurement",
      subtitle: "Not tied to an invoice. It closes itself once the supplier and its order exist.",
      body: `<form data-form="standalone-request" class="form-grid modal-form"><label>What do you need?<select name="kind" data-request-kind><option value="onboard_supplier">Onboard a new supplier</option><option value="raise_po">Raise a purchase order for a supplier</option></select></label><label data-when="onboard_supplier">Supplier name<input name="subject" placeholder="Exactly as it appears on their invoices" required></label><label data-when="raise_po" hidden>Supplier<select name="supplier_id"><option value="">Choose a supplier…</option>${approved.map((v) => `<option value="${esc(v.supplier_id)}">${esc(v.name)}</option>`).join("")}</select></label><div class="form-grid two" style="margin:0"><label>Order the supplier needs — amount<input name="amount" inputmode="decimal" placeholder="12000.00" required></label><label>Currency<input name="currency" placeholder="USD" maxlength="3" style="text-transform:uppercase" required></label></div><small class="muted">A supplier without a purchase order cannot be invoiced, so every request names the order it needs. The request closes once both exist.</small><label>Note for procurement<textarea name="note" placeholder="Why it is needed, amount and currency for an order, contract or contact details"></textarea></label><button class="primary small">Send request</button></form>`,
    });
    return;
  }
  if (action === "resolve-standalone") {
    const t = (state.allTickets || []).find((x) => x.ticket_id === button.dataset.id);
    if (!t) return;
    const approved = state.vendors.filter((v) => v.status === "approved").sort((a, b) => a.name.localeCompare(b.name));
    const vendor = state.vendors.find((v) => v.supplier_id === t.supplier_id);
    const subjectLower = (t.subject || "").trim().toLowerCase();
    const existing = t.kind === "onboard_supplier"
      ? state.vendors.find((v) => v.status === "approved" && (v.name.toLowerCase() === subjectLower || (v.aliases || []).includes(subjectLower)))
      : null;
    const orderFor = (sid, name) => `<form data-form="create-po" data-standalone="1" data-supplier="${esc(sid)}" class="form-grid modal-form"><p class="muted">Order for <b>${esc(name)}</b>.</p>`;
    const work =
      t.kind === "onboard_supplier"
        ? existing
          ? `<p class="saved-mark">✓ Step 1 done: ${esc(existing.name)} is an approved supplier.</p><p class="muted">Step 2: add the order the reviewer asked for.</p>${orderFor(existing.supplier_id, existing.name)}`
          : `<p class="muted">Step 1: approve the supplier. Step 2 (the order) follows in this same request.</p><form data-form="onboard" data-standalone="1" class="form-grid modal-form"><label>Supplier legal name<input name="name" value="${esc(t.subject || "")}" required></label><label>Country (optional)<input name="country"></label><button class="primary small">Add approved supplier</button></form><details class="compact-details"><summary>Existing supplier under another name?</summary><form data-form="add-alias" data-standalone="1" data-subject="${esc(t.subject || "")}" class="form-grid"><label>Approved supplier<select name="supplier_id" required><option value="">Choose a supplier…</option>${approved.map((v) => `<option value="${esc(v.supplier_id)}">${esc(v.name)}</option>`).join("")}</select></label><button class="small">Register “${esc(t.subject || "")}” as a name of this supplier</button></form></details>`
        : orderFor(t.supplier_id || "", vendor?.name || t.subject || "").replace(/$/, "");
    const orderFields = `<label>Purchase order number<input name="po_id" placeholder="PO-3010" required></label><label>Currency<input name="currency" value="${esc(t.currency || "")}" placeholder="USD" required></label><label>Authorized amount<input name="amount" inputmode="decimal" value="${esc(t.amount_minor != null ? (t.amount_minor / 10 ** (EXP[t.currency] ?? 2)).toFixed(EXP[t.currency] ?? 2) : "")}" placeholder="10000.00" required></label><small class="muted">Requested: ${esc(t.amount_minor != null ? money(t.amount_minor, t.currency) : "no amount given")}. Anything lower keeps the request open.</small><button class="primary small">Add purchase order</button></form>`;
    const workHTML = work.endsWith("</b>.</p>") ? work + orderFields : work;
    openModal({
      title: t.kind_label || TICKET_KINDS[t.kind],
      subtitle: `${t.subject || ""}${t.note ? ` · “${t.note}”` : ""} · asked by ${t.requested_by}`,
      body: `${workHTML}<div class="modal-actions">${requestFooterHTML([t])}</div>`,
    });
    return;
  }
  if (action === "close-modal") {
    closeModal();
    return;
  }
  if (action === "manage-po") {
    const po = state.pos.find((p) => p.po_id === button.dataset.id);
    if (!po) return;
    const vendor = state.vendors.find((v) => v.supplier_id === po.supplier_id);
    const exp = EXP[po.currency] ?? 2;
    openModal({
      title: `Manage ${po.po_id}`,
      subtitle: `${vendor?.name || po.supplier_id} · ${money(po.consumed_minor, po.currency)} approved of ${money(po.amount_minor, po.currency)} · ${po.status === "open" ? "Open" : "Closed"}`,
      body: `<form data-form="amend-po" data-id="${esc(po.po_id)}" class="form-grid modal-form"><label>Authorized amount (${esc(po.currency)})<input name="amount" inputmode="decimal" value="${esc((po.amount_minor / 10 ** exp).toFixed(exp))}" required></label><small>Can never go below the ${esc(money(po.consumed_minor, po.currency))} already approved against it.</small><button class="primary small">Save amount</button></form><div class="modal-actions"><button type="button" class="small" data-action="${po.status === "open" ? "close-po" : "reopen-po"}" data-id="${esc(po.po_id)}">${po.status === "open" ? "Close order" : "Reopen order"}</button>${po.consumed_minor ? `<span class="muted modal-hint">Cannot be deleted: ${esc(money(po.consumed_minor, po.currency))} is already approved against it. Close it instead.</span>` : `<button type="button" class="small danger" data-action="delete-po" data-id="${esc(po.po_id)}">Delete order</button>`}</div>`,
    });
    return;
  }
  if (action === "show-po-invoices") {
    const po = state.pos.find((p) => p.po_id === button.dataset.id);
    const vendor = state.vendors.find((v) => v.supplier_id === po?.supplier_id);
    const rows = (po?.invoices || []).map(invoiceRow);
    openModal({
      title: `${po?.po_id || "Purchase order"} · invoices`,
      subtitle: `${vendor?.name || ""} · ${rows.length} invoice${rows.length === 1 ? "" : "s"} · ${money((po?.amount_minor || 0) - (po?.consumed_minor || 0), po?.currency || "USD")} remaining`,
      body: recordListHTML(rows, "No invoices reference this order yet."),
      filter: rows.length > 8,
    });
    return;
  }
  if (action === "show-vendor-pos") {
    const vendor = state.vendors.find((v) => v.supplier_id === button.dataset.id);
    const rows = state.pos.filter((p) => p.supplier_id === button.dataset.id).map(orderRow);
    openModal({
      title: `${vendor?.name || "Supplier"} · purchase orders`,
      subtitle: `${rows.length} order${rows.length === 1 ? "" : "s"} on record`,
      body: recordListHTML(rows, "No purchase orders for this supplier yet."),
      filter: rows.length > 8,
    });
    return;
  }
  if (action === "open-reject") {
    const rej = document.querySelector(".review-footer details.rejection");
    if (rej) {
      rej.open = true;
      const box = rej.querySelector("textarea");
      if (box && !box.value.trim() && button.dataset.reason) box.value = button.dataset.reason;
      rej.scrollIntoView({ block: "center", behavior: "smooth" });
      box?.focus();
    }
    return;
  }
  if (action === "check-again") {
    const container = $(".review-footer");
    if (unsaved()) {
      formError(
        container,
        new Error(
          "Save your edited fields before checking again. Your unsaved values are still in the form.",
        ),
      );
      return;
    }
    await withAction(container, async () => {
      const id = state.detail.run_id;
      const key = `${id}:approve:${state.review.revision_seq}`;
      state.decisionKeys[key] ??= crypto.randomUUID();
      const result = await reviewPost("approve", {
        idempotency_key: state.decisionKeys[key],
      });
      notice(
        result.posted
          ? "Invoice approved."
          : result.route === "REJECT"
            ? "Invoice rejected. See the reason below."
            : "Still on hold — the items shown in red are still unresolved.",
      );
      location.hash = `invoice/${result.run_id}`;
    });
    return;
  }
  if (action === "reset") {
    if (
      !(await confirmAction(
        "Reset your workspace?",
        "This permanently removes every invoice, review and approval in your own workspace, and restores the example suppliers and purchase orders. Nobody else's workspace is affected.",
        "Reset my workspace",
      ))
    )
      return;
    await withAction(button.closest("section"), async () => {
      await post("/api/admin/reset");
      state.live = null;
      notice("Your workspace is back to its starting state.");
      location.hash = "invoices";
    });
  }
}
document.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  const submitter = e.submitter;
  if (submitter?.name === "outcome") form.dataset.outcome = submitter.value;
  if (form.dataset.form === "source-import") {
    submitSourceImport(form);
    return;
  }
  if (form.dataset.form === "folder-settings") {
    saveFolderSettings(form);
    return;
  }
  if (form.dataset.form === "sample-batch") {
    runSamplesBatch(
      [...form.querySelectorAll("input[name=names]:checked")].map((i) => i.value),
    );
    return;
  }
  submitForm(form);
});
document.addEventListener("change", (e) => {
  const sel = e.target;
  if (sel.dataset?.setting) { saveSetting(sel.dataset.setting, sel.value); return; }
  if (sel.matches('[data-form="sample-batch"] input[name=names]')) { updateSampleSelection(sel.closest("form")); return; }
  if (sel instanceof HTMLSelectElement && sel.hasAttribute("data-request-kind")) {
    sel.closest("form").querySelectorAll("[data-when]").forEach((el) => {
      const on = el.dataset.when === sel.value;
      el.hidden = !on;
      el.querySelectorAll("input, select").forEach((i) => (i.required = on));
    });
    return;
  }
  if (!(sel instanceof HTMLSelectElement) || !sel.hasAttribute("data-map-supplier")) return;
  const form = sel.closest("form");
  const po = form?.querySelector("select[data-map-po]");
  if (po) po.innerHTML = mapPoOptions(sel.value, form.dataset.currency || "");
});
document.addEventListener("input", (e) => {
  if (e.target.classList?.contains("modal-filter")) {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll("#app-modal .record-row").forEach((row) => {
      row.hidden = !!q && !row.dataset.search.includes(q);
    });
  }
});
document.addEventListener("click", (e) => {
  const dlg = document.getElementById("app-modal");
  if (!dlg?.open) return;
  if (e.target === dlg) closeModal();                     // backdrop
  else if (e.target.closest("#app-modal a[href^='#']")) closeModal(); // navigating away
});
document.addEventListener("input", (e) => {
  if (e.target.id === "request-search") {
    state.requestSearch = e.target.value;
    renderRequests();
  }
  if (e.target.id === "search") {
    state.search = e.target.value;
    renderRows();
  }
  if (e.target.matches("[data-original]")) {
    const button = e.target.form?.querySelector("button[type=submit]");
    if (button) {
      const changed = e.target.value.trim() !== e.target.dataset.original;
      button.disabled = !changed && button.textContent === "Save";
    }
  }
});
document.addEventListener("click", async (e) => {
  const opener = e.target.closest("[data-resolve-open]");
  if (opener && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    openResolve(opener.dataset.resolveOpen, { batchId: opener.dataset.resolveBatch || null });
    return;
  }
  const button = e.target.closest("button");
  if (button?.dataset.action) {
    e.preventDefault();
    handleAction(button.dataset.action, button);
    return;
  }
  if (button?.dataset.requestFilter) {
    state.requestFilter = button.dataset.requestFilter;
    renderRequests();
    return;
  }
  if (button?.dataset.filter) {
    state.filter = button.dataset.filter;
    renderRows();
    return;
  }
  if (button?.dataset.sample) {
    const sample = button.dataset.sample;
    if (isZipName(sample)) {
      runSamplesBatch([sample]);
      return;
    }
    beginLive(sample, () =>
      post(
        `/api/samples/${encodeURIComponent(sample)}/run`,
        {},
        { timeout: 180000 },
      ),
    );
    return;
  }
  if (button?.dataset.suggestion) {
    const input = $(`#input-${CSS.escape(button.dataset.suggestion)}`);
    input.value = button.dataset.value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    return;
  }
  if (button?.dataset.evidence) {
    state.selectedField = button.dataset.evidence;
    const block = state.doc?.blocks.find(
      (b) =>
        b.block_id ===
        state.review.fields[state.selectedField]?.evidence?.block_id,
    );
    if (block) {
      $(".document-panel").classList.add("expanded");
      const toggle = $(".mobile-document-toggle");
      if (toggle) {
        toggle.textContent = "Hide document";
        toggle.setAttribute("aria-expanded", "true");
      }
      state.page = block.page;
      drawPage();
      $(".evidence-box")?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    } else
      notice(
        "This field has no text location. Compare it with the original invoice.",
      );
    return;
  }
  const anchor = e.target.closest('a[href^="#"]');
  if (anchor && anchor.getAttribute("href") === "#main") {
    e.preventDefault();
    $("#main").focus();
    return;
  }
  if (anchor && state.busy) {
    e.preventDefault();
    notice("Please wait while your changes are saved.");
    return;
  }
  if (anchor && anchor.hash !== location.hash && unsaved()) {
    e.preventDefault();
    if (
      await confirmAction(
        "Leave unsaved changes?",
        "Saved corrections are kept. Changes still in the input fields will be discarded.",
        "Leave page",
      )
    )
      location.hash = anchor.hash;
  }
});
document.addEventListener("keydown", (e) => {
  if (!e.target.matches('[data-action="welcome-tab"]') || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  welcome.tab = e.key === "Home" ? "upload" : e.key === "End" ? "storage" : welcome.tab === "upload" ? "storage" : "upload";
  renderWelcomeIntake();
  document.querySelector(`[data-action="welcome-tab"][data-tab="${welcome.tab}"]`).focus();
});
// A label is clickable but not keyboard-activatable on its own.
document.addEventListener("keydown", (e) => {
  const label = e.target.closest?.('label[for="file-input"]');
  if (label && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    label.click();
  }
});
$("#file-input").addEventListener("change", (e) => {
  if (state.route === "home") stageWelcomeFiles(e.target.files);
  else upload(e.target.files);
  e.target.value = "";
});
document.addEventListener("dragover", (e) => {
  const zone = e.target.closest("#drop-zone");
  if (zone) {
    e.preventDefault();
    zone.classList.add("dragover");
  }
});
document.addEventListener("dragleave", (e) =>
  e.target.closest("#drop-zone")?.classList.remove("dragover"),
);
document.addEventListener("drop", (e) => {
  const zone = e.target.closest("#drop-zone");
  if (zone) {
    e.preventDefault();
    zone.classList.remove("dragover");
    if (state.route === "home") stageWelcomeFiles(e.dataTransfer.files);
    else upload(e.dataTransfer.files);
  }
});
window.addEventListener("beforeunload", (e) => {
  if (unsaved()) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("hashchange", route);
window.addEventListener("popstate", () => { if (!location.hash) route(); });
followSystemTheme();
ensureSession().then(() => {
  route();
  refreshQueueCount();
});
setInterval(async () => {
  if (!state.user || !["invoices", "dashboard"].includes(state.route) || state.busy) return;
  try {
    const [runs, tickets] = await Promise.all([
      api("/api/runs"),
      api("/api/tickets?status=all"),
    ]);
    if (["invoices", "dashboard"].includes(state.route) && ($("#invoice-table") || $("#ai-dashboard"))) {
      if (
        JSON.stringify(state.runs) !== JSON.stringify(runs) ||
        JSON.stringify(state.allTickets) !== JSON.stringify(tickets)
      ) {
        state.runs = runs;
        state.allTickets = tickets;
        if (state.route === "dashboard") renderDashboard(currentRows());
        else renderRows();
      }
      const warning = $("#upload-error");
      if (warning?.textContent.includes("inbox could not refresh"))
        warning.innerHTML = "";
    }
  } catch (e) {
    if ($("#upload-error") && !$("#upload-error").innerHTML)
      $("#upload-error").innerHTML = errorHTML(
        "The inbox could not refresh. The invoices below may be out of date.",
        "reload",
        "Refresh inbox",
      );
  }
}, 7000);

// ---- quick resolve ---------------------------------------------------------
// One held invoice at a time, one decision at a time, keyboard first. The
// decision model comes from resolve.js, built from the same review payload the
// detail page uses; every confirm is one of the existing review calls, and
// Approve is the same server-side re-evaluation as "Check again". The detail
// page stays the deep view (activity, evidence, tickets) — this is the fast lane.
const RESOLVE_ICON = { ok: "✓", warn: "!", wait: "…", none: "–", dot: "·", bad: "✕" };

function resolvable(r) {
  return !isAdmin() && r.run_status === "completed" && r.disposition === "held"
    && ["review", "ready"].includes(workState(r).key);
}
// The queue is the inbox's own order (low-confidence holds first), or the
// batch's order when opened from a batch. Only the latest attempt of each
// invoice is ever a candidate.
function resolveQueue(context) {
  if (context.kind === "batch" && state.batch?.data?.items) {
    const ids = state.batch.data.items.filter((it) => it.run_id).map((it) => latestDescendant(it.run_id));
    return [...new Set(ids)].filter((id) => {
      const run = state.runs.find((r) => r.run_id === id);
      return run && resolvable(run);
    });
  }
  const rows = currentRows().sort((a, b) =>
    Number(b.confidence?.band === "low" && b.disposition === "held") - Number(a.confidence?.band === "low" && a.disposition === "held"));
  return rows.filter(resolvable).map((r) => r.run_id);
}
async function openResolve(runId, opts = {}) {
  if (isAdmin()) { location.hash = `invoice/${runId}`; return; }
  const dlg = $("#resolve-dialog");
  const batchId = opts.batchId || null;
  let context;
  if (batchId && state.batch?.data?.batch_id === batchId) {
    const zip = state.batch.data.items.map((it) => it.source).find((src) => src?.startsWith("zip:"));
    context = { kind: "batch", batchId, label: zip ? zip.slice(4) : state.batch.label || "Batch" };
  } else if (state.route.startsWith("invoice/")) context = { kind: "detail", label: "Invoice details" };
  else context = { kind: "inbox", label: "Invoice reviews" };
  state.resolve = {
    context, queue: [], index: 0, runId, loading: true, busy: false, error: null,
    detail: null, review: null, tickets: [], doc: null, page: 1, decisions: [], steps: [],
    active: -1, choice: {}, deferred: new Set(), result: null, rejecting: false, rejectReason: "",
    finished: false, drafts: {}, highlight: null, afterClose: null,
  };
  if (!dlg.open) dlg.showModal();
  resolveRender();
  try {
    // tickets too: resolvable() needs them to tell "with procurement" from "yours"
    const [runs, vendors, pos, tickets] = await Promise.all([
      api("/api/runs"), api("/api/vendors"), api("/api/pos"), api("/api/tickets?status=all")]);
    if (!state.resolve) return;
    state.runs = runs; state.vendors = vendors; state.pos = pos; state.allTickets = tickets;
    const latest = latestDescendant(runId);
    const queue = resolveQueue(context);
    if (!queue.includes(latest)) queue.unshift(latest);
    state.resolve.queue = queue;
    state.resolve.index = queue.indexOf(latest);
    await resolveLoad(latest);
  } catch (e) {
    if (state.resolve) { state.resolve.loading = false; state.resolve.error = e.message; resolveRender(); }
  }
}
async function resolveLoad(runId) {
  const r = state.resolve; if (!r) return;
  Object.assign(r, {
    runId, loading: true, busy: false, error: null, result: null, rejecting: false, rejectReason: "",
    detail: null, review: null, tickets: [], doc: null, page: 1, decisions: [], steps: [], active: -1,
    choice: {}, deferred: new Set(), drafts: {}, highlight: null,
  });
  resolveRender();
  try {
    const d = await api(`/api/runs/${encodeURIComponent(runId)}`);
    if (state.resolve !== r || r.runId !== runId) return;
    const [rv, tickets, doc] = await Promise.all([
      api(`/api/runs/${encodeURIComponent(runId)}/review`).catch((e) => { if (e.status === 404) return null; throw e; }),
      api(`/api/tickets?status=all&document_id=${encodeURIComponent(d.document_id)}`),
      api(`/api/runs/${encodeURIComponent(runId)}/document`).catch(() => null),
    ]);
    if (state.resolve !== r || r.runId !== runId) return;
    Object.assign(r, { detail: d, review: rv, tickets, doc, loading: false });
    if (!rv) r.error = "No completed reading is available for this invoice — open its details to retry.";
    else if (d.disposition !== "held") {
      r.error = d.disposition === "approved" ? "This invoice is already approved." : d.disposition === "rejected" ? "This invoice was rejected." : "This invoice is still being processed.";
      r.review = null;
    }
    resolveBuild();
    resolveAdvance(null);
  } catch (e) {
    if (state.resolve !== r || r.runId !== runId) return;
    r.loading = false; r.error = e.message;
  }
  resolveRender();
}
function resolveBuild() {
  const r = state.resolve;
  if (!r.review) { r.decisions = []; return; }
  const openTickets = InvoiceWorkflow.latestRequests(r.tickets, r.detail.document_id)
    .filter((t) => t.status === "open").map((t) => t.kind);
  const pageText = (r.doc?.blocks || []).map((b) => b.text).join(" ");
  r.decisions = InvoiceResolve.buildDecisions(r.review, {
    vendors: state.vendors, openTickets, pageText, money, decimals: (c) => EXP[c] ?? 2, expected: EXPECTED, problemCopy,
  });
  // pills keep their place for the whole invoice: a confirmed decision shows as done, not gone
  for (const d of r.decisions) if (!r.steps.some((s) => s.key === d.key)) r.steps.push({ key: d.key, step: d.step });
  for (const d of r.decisions) {
    if (!d.options.some((o) => o.id === r.choice[d.key])) {
      const rec = d.options.find((o) => o.recommended);
      r.choice[d.key] = rec ? rec.id : null;
    }
  }
}
// Next decision to show, walking the pills in order from the one just handled:
// open and not deferred first, then anything open, then whatever is blocked or
// with procurement. -1 means nothing left to decide.
function resolveAdvance(afterKey) {
  const r = state.resolve; const ds = r.decisions;
  const order = r.steps.map((s) => s.key);
  const start = afterKey ? order.indexOf(afterKey) : -1;
  const pick = (pred) => {
    for (let k = 1; k <= order.length; k++) {
      const i = ds.findIndex((d) => d.key === order[(start + k) % order.length]);
      if (i > -1 && pred(ds[i])) return i;
    }
    return -1;
  };
  let i = pick((d) => d.status === "open" && !r.deferred.has(d.key));
  if (i < 0) i = pick((d) => d.status === "open");
  if (i < 0) i = pick((d) => d.status === "blocked" || d.status === "waiting");
  r.active = i;
}
function resolveCounts() {
  const ds = state.resolve?.decisions || [];
  return { open: ds.filter((d) => d.status === "open" || d.status === "blocked").length,
           waiting: ds.filter((d) => d.status === "waiting").length };
}
function resolveCanApprove() {
  const r = state.resolve;
  if (!r || r.busy || r.result || r.rejecting || r.loading || !r.review) return false;
  const c = resolveCounts();
  return c.open === 0 && c.waiting === 0;
}
// Forward from the current position, then wrapping round to anything skipped
// or deferred earlier — "next" means the next invoice still waiting on you,
// wherever it sits in the list. Only the current one is never offered.
function resolveNextEntry() {
  const r = state.resolve; if (!r || !r.queue.length) return null;
  for (let k = 1; k < r.queue.length; k++) {
    const i = (r.index + k) % r.queue.length;
    const id = latestDescendant(r.queue[i]);
    const run = state.runs.find((x) => x.run_id === id);
    if (run && resolvable(run)) return { i, id };
  }
  return null;
}
async function resolveNext() {
  const r = state.resolve; if (!r || r.busy) return;
  const n = resolveNextEntry();
  if (!n) { r.finished = true; r.result = null; r.rejecting = false; resolveRender(); return; }
  r.index = n.i; r.queue[n.i] = n.id;
  await resolveLoad(n.id);
}
// Every queued invoice (the current one included) still waiting on the reviewer.
function resolveRemaining() {
  const r = state.resolve; if (!r) return [];
  return r.queue.map((q, i) => ({ i, id: latestDescendant(q) }))
    .filter(({ id }) => { const run = state.runs.find((x) => x.run_id === id); return run && resolvable(run); });
}
function closeResolve(hash) {
  const r = state.resolve;
  if (r) r.afterClose = hash || (r.context.kind === "detail" ? `invoice/${r.result?.runId || r.runId}` : null);
  $("#resolve-dialog").close();
}

// ---- rendering --------------------------------------------------------------
function resolveRender() {
  const r = state.resolve; const dlg = $("#resolve-dialog");
  if (!r || !dlg) return;
  // what the reviewer typed survives a re-render (option change, error, save)
  for (const el of dlg.querySelectorAll("input:not([type=radio]), textarea, select")) if (el.name) r.drafts[el.name] = el.value;
  dlg.innerHTML = resolveHTML();
  for (const el of dlg.querySelectorAll("input:not([type=radio]), textarea, select")) if (el.name && r.drafts[el.name] != null) el.value = r.drafts[el.name];
  (dlg.querySelector("[data-autofocus]") || dlg).focus();
}
function resolveHTML() {
  const r = state.resolve;
  const next = resolveNextEntry();
  const pos = r.queue.length ? `invoice ${r.index + 1} of ${r.queue.length}` : "";
  const bar = `<header class="resolve-bar"><button type="button" class="resolve-back" data-resolve="close">← ${esc(r.context.label)}</button>${r.detail ? `<span class="resolve-sep" aria-hidden="true">|</span><code class="resolve-file">${esc(r.detail.filename)}</code>` : ""}${pos ? `<span class="resolve-sep" aria-hidden="true">·</span><span class="resolve-pos">${esc(pos)}</span>` : ""}<span class="resolve-spacer"></span><button type="button" class="resolve-next" data-resolve="next" ${next && !r.busy && !r.loading ? "" : "disabled"}>Next invoice →</button></header>`;
  let body;
  if (r.finished) {
    // skipped or deferred invoices are still yours; say so rather than "caught up"
    const left = resolveRemaining();
    body = left.length
      ? `<div class="resolve-empty"><span class="fi wait big" aria-hidden="true">…</span><h2>End of the list</h2><p>${left.length === 1 ? "One invoice you skipped still needs" : `${left.length} invoices you skipped still need`} a decision. ${left.length === 1 ? "It stays" : "They stay"} in your inbox; anything with procurement returns there when they reply.</p><div class="button-row" style="justify-content:center"><button type="button" class="primary" data-resolve="restart" data-autofocus>Review skipped →</button><button type="button" data-resolve="close">Back to ${esc(r.context.label)}</button></div></div>`
      : `<div class="resolve-empty"><span class="fi ok big" aria-hidden="true">✓</span><h2>You’re caught up</h2><p>Every invoice in this ${r.context.kind === "batch" ? "batch" : "list"} that needed a decision has one. Anything with procurement returns to your inbox when they reply.</p><button type="button" class="primary" data-resolve="close" data-autofocus>Back to ${esc(r.context.label)}</button></div>`;
  }
  else if (r.loading)
    body = `<div class="resolve-body"><section class="resolve-doc"><div class="skeleton" role="status">Loading the invoice…</div></section><aside class="resolve-side"><div class="skeleton" role="status" style="margin:24px">Working out what needs a decision…</div></aside></div>`;
  else if (!r.review)
    body = `<div class="resolve-empty"><h2>Nothing to decide here</h2><p>${esc(r.error || "This invoice has no open decisions.")}</p><div class="button-row" style="justify-content:center"><button type="button" class="primary" data-resolve="next" ${next ? "" : "disabled"} data-autofocus>Next invoice →</button><a class="button-link" href="#invoice/${encodeURIComponent(r.runId)}" data-resolve="open-detail" data-id="${esc(r.runId)}">Open invoice details</a></div></div>`;
  else
    body = `<div class="resolve-body"><section class="resolve-doc" aria-label="Invoice document">${resolveDocHTML()}</section><aside class="resolve-side" aria-label="Decisions">${resolveSideHTML()}</aside></div>`;
  return bar + body;
}
function resolveDocHTML() {
  const r = state.resolve; const doc = r.doc;
  if (!doc?.pages?.length) return `<div class="resolve-doc-empty"><p>No document preview is available for this invoice.</p></div>`;
  const pg = doc.pages[r.page - 1];
  const active = r.decisions[r.active];
  const flagged = new Map();
  for (const d of r.decisions) for (const f of d.fields) flagged.set(f, d === active ? "active" : "flag");
  if (r.highlight && !flagged.has(r.highlight)) flagged.set(r.highlight, "pin");
  const boxes = [...flagged].map(([f, cls]) => {
    const fld = r.review.fields?.[f];
    const b = doc.blocks.find((x) => x.block_id === fld?.evidence?.block_id);
    if (!b || b.page !== r.page) return "";
    const d = r.decisions.find((x) => x.fields.includes(f));
    const style = `left:${Math.max(0, ((b.x0 - 3) / pg.width) * 100)}%;top:${Math.max(0, ((b.top - 3) / pg.height) * 100)}%;width:${Math.min(100, ((b.x1 - b.x0 + 6) / pg.width) * 100)}%;height:${((b.bottom - b.top + 6) / pg.height) * 100}%`;
    return `<button type="button" class="evidence-box ${cls}" style="${style}" data-resolve="box" data-field="${esc(f)}"${d ? ` data-decision="${esc(d.key)}"` : ""} aria-label="${esc(FIELD[f] || f)}: ${esc(fld.raw_value || "")}" title="${esc(FIELD[f] || f)}"></button>`;
  }).join("");
  const controls = doc.pages.length > 1
    ? `<div class="resolve-pages"><button type="button" class="icon" data-resolve="page" data-dir="-1" aria-label="Previous page" ${r.page === 1 ? "disabled" : ""}>‹</button><span>Page ${r.page} of ${doc.pages.length}</span><button type="button" class="icon" data-resolve="page" data-dir="1" aria-label="Next page" ${r.page === doc.pages.length ? "disabled" : ""}>›</button></div>`
    : "";
  return `${controls}<div class="resolve-canvas"><div class="pdf-page"><img src="/api/runs/${encodeURIComponent(r.runId)}/page/${r.page}?role=${encodeURIComponent(getToken() || "")}&ws=${encodeURIComponent(getWorkspace())}" alt="Original invoice, page ${r.page}">${boxes}</div></div>`;
}
function resolveSideHTML() {
  const r = state.resolve; const ds = r.decisions; const c = resolveCounts();
  const rows = InvoiceResolve.fieldStates(r.review, ds);
  const matched = rows.filter((x) => x.icon === "ok").length;
  const active = ds[r.active] || null;
  const stepIndex = active ? r.steps.findIndex((s) => s.key === active.key) : -1;
  const heading = r.result ? (r.result.kind === "approved" ? "Approved" : "Rejected")
    : active ? `Decision ${stepIndex + 1} of ${r.steps.length}` : c.waiting ? "With procurement" : "Ready to approve";
  const head = `<div class="resolve-head"><h2>${esc(heading)}</h2><span class="resolve-meta">${c.open} left · ${matched} field${matched === 1 ? "" : "s"} matched</span></div>`;
  const pills = r.steps.length
    ? `<ol class="resolve-steps">${r.steps.map((s, i) => {
        const d = ds.find((x) => x.key === s.key);
        const done = !d;
        const cls = done ? "done" : d === active ? "active" : d.status;
        return `<li><button type="button" class="resolve-step ${cls}" data-resolve="step" data-key="${esc(s.key)}" ${done ? "disabled" : ""} aria-current="${d === active ? "step" : "false"}"><span class="n" aria-hidden="true">${done ? "✓" : i + 1}</span>${esc(s.step)}</button></li>`;
      }).join("")}</ol>`
    : "";
  const card = r.result ? resolveResultHTML() : active ? resolveCardHTML(active) : resolveReadyHTML(c);
  const list = `<ul class="resolve-fields">${rows.map((row) =>
    `<li class="resolve-field ${row.icon}${active?.fields.includes(row.name) ? " active" : ""}"><button type="button" data-resolve="row" data-field="${esc(row.name)}"${row.decision ? ` data-decision="${esc(row.decision)}"` : ""}><span class="fi ${row.icon}" aria-hidden="true">${RESOLVE_ICON[row.icon]}</span><span class="fl">${esc(row.label)}</span><code class="fv">${esc(row.value || "—")}</code><span class="fs">${esc(row.text)}</span></button></li>`).join("")}</ul>`;
  return head + pills + `<div class="resolve-scroll">${card}${list}</div>` + resolveFooterHTML(c);
}
function resolveCardHTML(d) {
  const r = state.resolve;
  const opt = d.options.find((o) => o.id === r.choice[d.key]) || null;
  const head = `<div class="rc-head"><span class="fi ${d.status === "open" ? "warn" : "wait"}" aria-hidden="true">${d.status === "open" ? "!" : "…"}</span><span class="rc-title">${esc(d.title)}</span>${d.value ? `<code class="rc-value">${esc(d.value)}</code>` : ""}</div>`;
  if (d.status === "blocked") {
    const dep = r.decisions.find((x) => x.key === d.blockedBy);
    return `<section class="resolve-card blocked">${head}<p class="rc-why">${esc(d.why)}</p><div class="rc-actions">${dep ? `<button type="button" class="primary" data-resolve="step" data-key="${esc(dep.key)}" data-autofocus>Go to ${esc(dep.step.toLowerCase())} →</button>` : ""}<button type="button" class="text" data-resolve="later">Decide later</button></div></section>`;
  }
  const ticket = d.waitingOn ? r.tickets.find((t) => t.kind === d.waitingOn && t.status === "open") : null;
  const waiting = ticket
    ? `<div class="rc-waiting">Request sent to procurement${ticket.requested_by === "invoice-ai" ? " by Invoice AI" : ""} · ${esc(dateTime(ticket.created_at))}. ${d.options.length ? "You can still pick an option below, or move on." : "Move on — this invoice returns to your inbox when they reply."}</div>`
    : "";
  const options = d.options.map((o, i) => resolveOptionHTML(d, o, i, o.id === r.choice[d.key])).join("");
  const label = !opt ? "Choose an option"
    : opt.action.type === "ticket" ? "Send request & next"
    : opt.action.type === "reject" ? "Reject invoice…"
    : opt.action.type === "confirm-distinct" ? "Confirm & next"
    : opt.inputs || opt.select ? "Save & next"
    : `Confirm & next · ${opt.label.length > 34 ? opt.label.slice(0, 32) + "…" : opt.label}`;
  return `<section class="resolve-card ${d.status}">${head}<p class="rc-why">${esc(d.why)}</p>${waiting}${options ? `<div class="rc-options" role="radiogroup" aria-label="${esc(d.title)} options">${options}</div>` : ""}${d.evidence ? `<p class="rc-evidence"><b>Evidence:</b> ${esc(d.evidence)}</p>` : ""}${r.error ? `<p class="error-text" role="alert">${esc(r.error)}</p>` : ""}<div class="rc-actions">${d.options.length ? `<button type="button" class="primary rc-confirm" data-resolve="confirm" ${opt && !r.busy ? "" : "disabled"}>${r.busy ? "Saving…" : esc(label)} <kbd>↵</kbd></button>` : ""}<button type="button" class="text" data-resolve="later">Decide later</button></div></section>`;
}
function resolveOptionHTML(d, o, i, selected) {
  const controls = !selected ? "" : [
    ...(o.inputs || []).map((inp, k) => `<label class="rc-input"><span>${esc(FIELD[inp.field] || inp.field)}</span><input name="in-${esc(inp.field)}" value="${esc(inp.value || "")}" placeholder="${esc(EXPECTED[inp.field] || "")}" autocomplete="off"${k === 0 ? " data-autofocus" : ""}></label>`),
    o.select ? `<select name="sel-${esc(d.key)}" class="rc-select" data-autofocus><option value="">${esc(o.select.placeholder || "Choose…")}</option>${o.select.choices.map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join("")}</select>` : "",
    o.note ? `<textarea name="note-${esc(d.key)}" class="rc-note" rows="2" placeholder="${esc(o.note.placeholder || "")}" data-autofocus></textarea>` : "",
  ].join("");
  return `<label class="rc-option${selected ? " selected" : ""}${o.recommended ? " recommended" : ""}"><input type="radio" name="opt-${esc(d.key)}" value="${esc(o.id)}" data-resolve="option" data-key="${esc(d.key)}" ${selected ? "checked" : ""}><span class="rc-option-body"><span class="rc-option-head"><b>${esc(o.label)}</b><kbd class="rc-key" aria-hidden="true">${i + 1}</kbd></span>${o.recommended ? `<span class="rc-rec">AI recommends</span>` : ""}${o.detail ? `<small>${esc(o.detail)}</small>` : ""}${controls}</span></label>`;
}
function resolveReadyHTML(c) {
  const r = state.resolve; const s = r.review.display || {};
  const po = r.review.fields?.po_reference?.raw_value;
  if (c.waiting)
    return `<section class="resolve-card waiting"><div class="rc-head"><span class="fi wait" aria-hidden="true">…</span><span class="rc-title">With procurement</span></div><p class="rc-why">Nothing left for you on this invoice until procurement replies. It returns to your inbox as “Ready to recheck”.</p>${r.error ? `<p class="error-text" role="alert">${esc(r.error)}</p>` : ""}</section>`;
  return `<section class="resolve-card ready"><div class="rc-head"><span class="fi ok" aria-hidden="true">✓</span><span class="rc-title">All decisions made</span></div><p class="rc-why">Approve runs every check again and posts ${esc(s.invoice_gross_total || "the total")}${po ? ` against ${esc(po)}` : ""}. Anything still failing comes back here as a new decision.</p>${r.error ? `<p class="error-text" role="alert">${esc(r.error)}</p>` : ""}<div class="rc-actions"><button type="button" class="primary" data-resolve="approve" ${r.busy ? "disabled" : ""} data-autofocus>${r.busy ? "Checking…" : "Approve invoice"} <kbd>⌘↵</kbd></button></div></section>`;
}
function resolveResultHTML() {
  const r = state.resolve; const ok = r.result.kind === "approved";
  return `<section class="resolve-card result ${ok ? "approved" : "rejected"}"><div class="rc-head"><span class="fi ${ok ? "ok" : "bad"}" aria-hidden="true">${ok ? "✓" : "✕"}</span><span class="rc-title">${ok ? "Invoice approved" : "Invoice rejected"}</span></div><p class="rc-why">${esc(r.result.text)}</p><p class="rc-evidence"><a href="#invoice/${encodeURIComponent(r.result.runId)}" data-resolve="open-detail" data-id="${esc(r.result.runId)}">Open invoice details →</a></p></section>`;
}
function resolveFooterHTML(c) {
  const r = state.resolve; const next = resolveNextEntry();
  if (r.result)
    return `<footer class="resolve-foot"><button type="button" class="primary resolve-primary" data-resolve="next" ${next ? "" : "disabled"} data-autofocus>${next ? "Next invoice <kbd>↵</kbd>" : "No more invoices to resolve"}</button><div class="resolve-foot-row"><button type="button" data-resolve="close">Back to ${esc(r.context.label)}</button></div></footer>`;
  if (r.rejecting)
    return `<footer class="resolve-foot rejecting"><label class="resolve-reason">Why should this invoice be rejected?<textarea name="reject-reason" rows="2" data-autofocus>${esc(r.rejectReason || "")}</textarea></label>${r.error ? `<p class="error-text" role="alert">${esc(r.error)}</p>` : ""}<div class="resolve-foot-row"><button type="button" class="danger" data-resolve="reject-confirm" ${r.busy ? "disabled" : ""}>${r.busy ? "Rejecting…" : "Reject invoice"}</button><button type="button" data-resolve="reject-cancel">Cancel</button></div><p class="resolve-hint">The reason goes back to the supplier and onto the audit trail. ↵ confirms.</p></footer>`;
  const can = resolveCanApprove();
  const primary = c.open ? `${c.open} decision${c.open === 1 ? "" : "s"} left to approve`
    : c.waiting ? `Waiting on procurement · ${c.waiting} request${c.waiting === 1 ? "" : "s"}`
    : r.busy ? "Checking…" : "Approve invoice";
  return `<footer class="resolve-foot"><button type="button" class="primary resolve-primary" data-resolve="approve" ${can ? "" : "disabled"}>${esc(primary)} <kbd>⌘↵</kbd></button><div class="resolve-foot-row"><button type="button" data-resolve="skip" ${r.busy ? "disabled" : ""}>Skip invoice</button><button type="button" class="danger-outline" data-resolve="reject" ${r.busy ? "disabled" : ""}>Reject</button></div><p class="resolve-hint">${c.waiting && !c.open ? "Procurement has your request. Move on — this invoice returns to your inbox when they reply." : "Decisions can be made in any order. Dependent fields (purchase order, total) update automatically."}</p></footer>`;
}

// ---- actions ------------------------------------------------------------------
// A decision can be acted on while it is open, and also while it is with
// procurement — the card still offers the orders that exist (and mapping to an
// approved supplier), which is often faster than waiting for the reply.
const resolveActionable = (d) => !!d && (d.status === "open" || d.status === "waiting") && d.options.length > 0;
async function resolveConfirm() {
  const r = state.resolve; const d = r?.decisions[r.active];
  if (!resolveActionable(d) || r.busy) return;
  const opt = d.options.find((o) => o.id === r.choice[d.key]); if (!opt) return;
  const dlg = $("#resolve-dialog");
  const read = (name) => dlg.querySelector(`[name="${name}"]`)?.value?.trim() ?? "";
  const action = { ...opt.action };
  try {
    if (opt.select) { action.value = read(`sel-${d.key}`); if (!action.value) throw new Error("Choose a supplier from the list."); }
    if (opt.inputs && action.type === "correct") { action.value = read(`in-${opt.inputs[0].field}`); if (!action.value) throw new Error("Type the value as shown on the invoice."); }
    if (action.type === "correct-many") {
      action.values = {};
      for (const inp of opt.inputs) { const v = read(`in-${inp.field}`); if (v && v !== (inp.value || "")) action.values[inp.field] = v; }
      if (!Object.keys(action.values).length) throw new Error("Change at least one amount, or pick a correction above.");
    }
    if (opt.note) { action.note = read(`note-${d.key}`); if (action.note.length < 5) throw new Error("Say why this is a separate invoice — a few words, for the audit trail."); }
  } catch (e) { r.error = e.message; resolveRender(); return; }
  if (action.type === "reject") {
    r.rejecting = true; r.rejectReason = action.reason || ""; r.error = null; delete r.drafts["reject-reason"];
    resolveRender(); return;
  }
  r.busy = true; r.error = null; resolveRender();
  try {
    const id = r.runId; let seq = r.review.revision_seq;
    const rp = (path, body) => post(`/api/runs/${encodeURIComponent(id)}/review/${path}`, body);
    if (action.type === "correct") await rp("correct", { field: action.field, value: action.value, expected_seq: seq });
    else if (action.type === "correct-many")
      for (const [field, value] of Object.entries(action.values)) { const out = await rp("correct", { field, value, expected_seq: seq }); seq = out.revision_seq; }
    else if (action.type === "attest") await rp("attest", { fields: action.fields, expected_seq: seq });
    else if (action.type === "confirm-distinct") await rp("confirm-distinct", { note: action.note, expected_seq: seq });
    else if (action.type === "ticket") await post("/api/tickets", { run_id: id, kind: action.kind, note: action.note || "" });
    r.drafts = {}; r.deferred.delete(d.key);
    await resolveReload();
    if (state.resolve !== r) return;
    resolveAdvance(d.key);
    notice(action.type === "ticket" ? "Request sent to procurement." : `${d.title} saved.`);
  } catch (e) { r.error = e.message; }
  finally { if (state.resolve === r) { r.busy = false; resolveRender(); } }
}
async function resolveReload() {
  const r = state.resolve; const id = r.runId;
  const [rv, tickets] = await Promise.all([
    api(`/api/runs/${encodeURIComponent(id)}/review`),
    api(`/api/tickets?status=all&document_id=${encodeURIComponent(r.detail.document_id)}`),
  ]);
  if (state.resolve !== r || r.runId !== id) return;
  r.review = rv; r.tickets = tickets;
  resolveBuild();
}
async function resolveApprove() {
  const r = state.resolve; if (!resolveCanApprove()) return;
  r.busy = true; r.error = null; resolveRender();
  try {
    const id = r.runId;
    const key = `${id}:approve:${r.review.revision_seq}`;
    state.decisionKeys[key] ??= crypto.randomUUID();
    const result = await post(`/api/runs/${encodeURIComponent(id)}/review/approve`, { idempotency_key: state.decisionKeys[key] });
    state.runs = await api("/api/runs");
    if (state.resolve !== r) return;
    const newId = result.run_id || id;
    r.queue[r.index] = newId;
    if (result.posted) {
      const s = r.review.display || {};
      r.result = { kind: "approved", runId: newId,
        text: `${s.invoice_gross_total || "The invoice total"} was posted against ${r.review.fields?.po_reference?.raw_value || "the purchase order"}.` };
      r.busy = false; resolveRender(); return;
    }
    if (result.route === "REJECT") {
      r.result = { kind: "rejected", runId: newId, text: result.explanation || "The invoice was rejected." };
      r.busy = false; resolveRender(); return;
    }
    // still held: the full re-check surfaced more — follow the new attempt
    notice("Still on hold — the remaining items are shown.");
    await resolveLoad(newId);
  } catch (e) {
    if (state.resolve !== r) return;
    r.error = e.message; r.busy = false; resolveRender();
  }
}
async function resolveRejectConfirm() {
  const r = state.resolve; if (!r || r.busy || !r.review) return;
  const reason = $("#resolve-dialog").querySelector('[name="reject-reason"]')?.value.trim() || "";
  if (reason.length < 5) { r.error = "Give a reason — it goes back to the supplier and onto the audit trail."; resolveRender(); return; }
  r.busy = true; r.error = null; resolveRender();
  try {
    const id = r.runId;
    const key = `${id}:reject:${r.review.revision_seq}`;
    state.decisionKeys[key] ??= crypto.randomUUID();
    const result = await post(`/api/runs/${encodeURIComponent(id)}/review/reject`, { idempotency_key: state.decisionKeys[key], reason });
    state.runs = await api("/api/runs");
    if (state.resolve !== r) return;
    r.queue[r.index] = result.run_id || id;
    r.rejecting = false;
    r.result = { kind: "rejected", runId: result.run_id || id, text: `Rejected: ${reason}` };
  } catch (e) { r.error = e.message; }
  finally { if (state.resolve === r) { r.busy = false; resolveRender(); } }
}

// ---- events -------------------------------------------------------------------
$("#resolve-dialog").addEventListener("click", (e) => {
  const el = e.target.closest("[data-resolve]");
  const r = state.resolve;
  if (!el || !r || el.tagName === "INPUT") return;
  const act = el.dataset.resolve;
  if (act === "close") { e.preventDefault(); closeResolve(); }
  else if (act === "next" || act === "skip") resolveNext();
  else if (act === "restart") { const first = resolveRemaining()[0]; if (first) { r.finished = false; r.index = first.i; r.queue[first.i] = first.id; resolveLoad(first.id); } }
  else if (act === "step") { const i = r.decisions.findIndex((d) => d.key === el.dataset.key); if (i > -1) { r.active = i; r.error = null; resolveRender(); } }
  else if (act === "confirm") resolveConfirm();
  else if (act === "later") { const d = r.decisions[r.active]; if (d) { r.deferred.add(d.key); resolveAdvance(d.key); r.error = null; resolveRender(); } }
  else if (act === "approve") resolveApprove();
  else if (act === "reject") { r.rejecting = true; r.rejectReason = ""; r.error = null; resolveRender(); }
  else if (act === "reject-cancel") { r.rejecting = false; r.error = null; resolveRender(); }
  else if (act === "reject-confirm") resolveRejectConfirm();
  else if (act === "row" || act === "box") {
    const i = r.decisions.findIndex((d) => d.key === el.dataset.decision);
    if (i > -1) { r.active = i; r.error = null; }
    r.highlight = el.dataset.field; resolveRender();
  }
  else if (act === "page") { r.page = Math.min(Math.max(1, r.page + Number(el.dataset.dir)), r.doc?.pages?.length || 1); resolveRender(); }
  else if (act === "open-detail") { e.preventDefault(); closeResolve(`invoice/${el.dataset.id}`); }
});
$("#resolve-dialog").addEventListener("change", (e) => {
  const el = e.target; const r = state.resolve;
  if (!r || el.dataset?.resolve !== "option") return;
  r.choice[el.dataset.key] = el.value; r.error = null; resolveRender();
});
$("#resolve-dialog").addEventListener("close", () => {
  const r = state.resolve; state.resolve = null;
  if (r?.afterClose) location.hash = r.afterClose;
  route();
});
// Keys: ↵ confirms the highlighted option (or approves when nothing is left,
// or moves on after a result); ⌘↵ approves; ↑↓ and 1–9 pick options. Buttons,
// links and textareas keep their native Enter.
document.addEventListener("keydown", (e) => {
  const r = state.resolve; const dlg = $("#resolve-dialog");
  if (!r || !dlg?.open) return;
  const t = e.target;
  const inField = !!t.matches?.("input, textarea, select");
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); resolveApprove(); return; }
  if (e.key === "Enter") {
    if (t.matches?.("textarea, button, a, summary, select")) return;
    e.preventDefault();
    if (r.result) { resolveNext(); return; }
    if (r.rejecting) { resolveRejectConfirm(); return; }
    const d = r.decisions[r.active];
    if (resolveActionable(d)) { resolveConfirm(); return; }
    resolveApprove(); return;
  }
  if (inField || r.result || r.rejecting) return;
  const d = r.decisions[r.active];
  if (!resolveActionable(d)) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const ids = d.options.map((o) => o.id); const cur = ids.indexOf(r.choice[d.key]);
    const next = e.key === "ArrowDown" ? Math.min(ids.length - 1, cur + 1) : Math.max(0, cur - 1);
    r.choice[d.key] = ids[next]; r.error = null; resolveRender(); return;
  }
  if (/^[1-9]$/.test(e.key) && d.options[Number(e.key) - 1]) {
    e.preventDefault();
    r.choice[d.key] = d.options[Number(e.key) - 1].id; r.error = null; resolveRender();
  }
});
