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
  busy: false,
  decisionKeys: {},
  user: null,
  authConfig: null,
};
const TOKEN_KEY = "access_code";
const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch (e) {
    return null;
  }
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
  document
    .querySelectorAll(".admin-only")
    .forEach((el) => (el.hidden = !isAdmin()));
}
function signOut() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (e) {}
  state.user = null;
  state.live = null;
  applyRoleUI();
}
async function ensureSession() {
  if (!getToken()) return null;
  try {
    state.user = await api("/api/auth/me");
  } catch (e) {
    state.user = null;
  }
  applyRoleUI();
  return state.user;
}
const TICKET_KINDS = {
  unblock_supplier: "Approve a blocked supplier again",
  onboard_supplier: "Onboard a new supplier",
  raise_po: "Raise a purchase order",
  amend_po: "Amend a purchase order budget",
  other: "Other procurement request",
};
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
    ask: "Ask procurement to onboard this supplier",
    placeholder: "Contract, contact or registration details procurement can verify",
  },
  unblock_supplier: {
    ask: "Ask procurement to approve this supplier again",
    placeholder: "Why this supplier should be approved again — contract, contact, reason it was blocked…",
  },
  raise_po: {
    ask: "Ask procurement to raise or reopen the order",
    placeholder: "Who authorized this spend, the amount and currency, any quote or contract reference",
  },
  amend_po: {
    ask: "Ask procurement to amend the order budget",
    placeholder: "Why the invoice exceeds the order — approved change, price revision, reference",
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
async function api(path, options = {}) {
  const timeout = options.timeout ?? 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const token = getToken();
    const headers = { ...(options.headers || {}) };
    if (token && !path.startsWith("/api/auth/login"))
      headers.Authorization = `Bearer ${token}`;
    const response = await fetch(path, {
      ...options,
      headers,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (response.status === 401 && !path.startsWith("/api/auth/login")) {
      signOut();
      renderLanding();
      throw new ApiError(
        "Your session ended. Sign in again with your access code.",
        401,
      );
    }
    if (!response.ok) {
      const detail = data?.detail;
      const msg =
        typeof detail === "string"
          ? detail
          : Array.isArray(detail)
            ? detail.map((x) => `${x.loc.at(-1)}: ${x.msg}`).join(". ")
            : detail?.error || "The request could not be completed.";
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
    error.status === 409
      ? "This invoice has changed since you opened it. Reload the latest result, then check your changes."
      : error.message,
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
  return [...document.querySelectorAll("[data-original]")].some(
    (i) => i.value.trim() !== i.dataset.original,
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
function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem("theme", theme);
    } catch (e) {}
  }
  const button = $("#theme-toggle");
  if (button) {
    const dark = theme === "dark";
    button.setAttribute("aria-pressed", String(dark));
    button.querySelector(".theme-toggle-label").textContent = dark
      ? "Light"
      : "Dark";
    button.title = dark ? "Switch to light theme" : "Switch to dark theme";
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#0f151c" : "#f7f8fa";
}
async function renderLanding() {
  state.route = "landing";
  applyRoleUI();
  $("#breadcrumb").textContent = "Accounts payable / Sign in";
  let cfg = state.authConfig;
  if (!cfg) {
    try {
      cfg = state.authConfig = await api("/api/auth/config");
    } catch (e) {
      $("#main").innerHTML = errorHTML(e.message, "reload", "Try again");
      return;
    }
  }
  $("#main").innerHTML = `<div class="landing"><h1>Who is signing in?</h1><p>Each role has its own access code. The server decides what a role may do — the screen only reflects it.</p><div class="role-cards">${cfg.roles
    .map(
      (r) => `<section class="card role-card"><h2>${esc(r.label)}</h2><p style="margin:0;color:var(--muted)">${esc(r.description)}</p><ul class="can">${
        r.role === "admin"
          ? "<li>Work the procurement queue: onboard suppliers, raise or amend purchase orders</li><li>Edit, block or delete suppliers; amend, close or delete orders</li><li>Read any invoice and its audit trail</li><li>Reset the demo workspace</li><li><b>Cannot upload, approve or reject invoices</b></li>"
          : "<li>Upload invoices and review holds</li><li>Correct details, confirm scans, choose a purchase order</li><li>Approve or reject</li><li><b>Cannot change suppliers or purchase orders</b> — those go to procurement</li>"
      }</ul><form data-form="login" data-role="${esc(r.role)}"><label>Access code<input name="code" type="password" autocomplete="current-password" value="${esc(cfg.dev_codes?.[r.role] || "")}" required></label><button class="primary">Continue as ${esc(r.label.toLowerCase())}</button></form></section>`,
    )
    .join("")}</div>${
    cfg.dev_mode
      ? '<div class="dev-hint"><b>Demo mode.</b> The server is running with default access codes, so they are pre-filled here. In a deployed environment set <code>ADMIN_ACCESS_CODE</code> and <code>REVIEWER_ACCESS_CODE</code>; codes are then never shown and are checked in constant time on every request.</div>'
      : ""
  }</div>`;
}
async function route() {
  const generation = ++state.generation;
  if (!state.user) {
    await renderLanding();
    return;
  }
  const route = location.hash.slice(1) || "invoices";
  if (route === "queue" && !isAdmin()) {
    location.hash = "invoices";
    return;
  }
  state.route = route;
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const active =
      a.dataset.nav ===
      (route.startsWith("invoice/") || route === "processing"
        ? "invoices"
        : route);
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("#breadcrumb").textContent =
    "Accounts payable / " +
    (route.startsWith("invoice/")
      ? "Invoice details"
      : {
          invoices: "Invoices",
          pos: "Purchase orders",
          vendors: "Suppliers",
          activity: "Activity log",
          help: "Help",
          processing: "Processing",
          queue: "Procurement queue",
        }[route] || "Invoices");
  $("#main").innerHTML = '<div class="skeleton" role="status">Loading…</div>';
  try {
    if (route === "invoices") await inbox(generation);
    else if (route.startsWith("invoice/"))
      await detail(decodeURIComponent(route.slice(8)), generation);
    else if (route === "processing") renderLive();
    else if (route === "pos" || route === "vendors")
      await master(route, generation);
    else if (route === "activity") await activity(generation);
    else if (route === "queue") await queue(generation);
    else if (route === "help") help();
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
  const runs = await api("/api/runs");
  if (generation !== state.generation) return;
  state.runs = runs;
  $("#main").innerHTML =
    header(
      "Invoices",
      "Upload an invoice. We’ll check it and flag anything that needs you.",
    ) +
    `
${
      isAdmin()
        ? '<section class="card card-pad" style="margin-bottom:18px"><p style="margin:0"><b>Procurement view.</b> Invoice reviewers upload and decide invoices. You can open any invoice to see what it needs, and act on the <a href="#queue">procurement queue</a> — suppliers to onboard, purchase orders to raise or amend.</p></section>'
        : `<section class="upload-zone" id="drop-zone" aria-label="Drop an invoice PDF"><div class="upload-icon" aria-hidden="true">↥</div><div><h2>Drop an invoice here</h2><p>One PDF at a time · up to 10 MB and 10 pages</p></div><button data-action="upload">Choose a PDF</button></section><div id="upload-error"></div>
<details class="sample-details"><summary>Just exploring? Try a sample invoice</summary><div class="samples" id="samples">Loading samples…</div></details>`
    }
<section class="card"><div class="inbox-head"><h2>Your invoices</h2><div class="inbox-tools"><div class="filters" aria-label="Filter invoices"></div><input class="search" type="search" id="search" aria-label="Search invoices" placeholder="Search supplier or invoice…" value="${esc(state.search)}"></div></div><div id="invoice-table"></div></section>
<p class="footer-note">Latest result for each review · earlier attempts remain in the invoice’s history. <a href="#help">How approval works</a></p>`;
  renderRows();
  loadSamples();
}
function renderRows() {
  const rows = currentRows();
  const needs = rows.filter((r) =>
    ["held", "failed"].includes(statusKey(r)),
  ).length;
  $("#nav-count").textContent = needs || "";
  const filters = [
    ["all", "All invoices", rows.length],
    ["attention", "Needs attention", needs],
    [
      "approved",
      "Approved",
      rows.filter((r) => statusKey(r) === "approved").length,
    ],
    [
      "rejected",
      "Rejected",
      rows.filter((r) => statusKey(r) === "rejected").length,
    ],
  ];
  $(".filters").innerHTML = filters
    .map(
      ([key, label, count]) =>
        `<button class="filter ${state.filter === key ? "active" : ""}" data-filter="${key}" aria-pressed="${state.filter === key}">${label}<span>${count}</span></button>`,
    )
    .join("");
  const filtered = rows.filter(
    (r) =>
      (state.filter === "all" ||
        (state.filter === "attention"
          ? ["held", "failed"].includes(statusKey(r))
          : statusKey(r) === state.filter)) &&
      [r.filename, ...Object.values(r.summary ?? {})]
        .join(" ")
        .toLowerCase()
        .includes(state.search.toLowerCase()),
  );
  $("#invoice-table").innerHTML = filtered.length
    ? `<div class="table-scroll"><table><thead><tr><th>Invoice</th><th class="amount">Amount</th><th>Status</th><th class="col-date">Updated</th><th><span class="muted">Next step</span></th></tr></thead><tbody>${filtered
        .map((r) => {
          const s = r.summary ?? {};
          const key = statusKey(r);
          return `<tr><td><a class="invoice-link" href="#invoice/${encodeURIComponent(r.run_id)}">${esc(s.supplier_name || r.filename || "Invoice")}</a><small class="invoice-sub">${esc(s.invoice_number ? `#${s.invoice_number} · ${r.filename}` : r.filename === s.supplier_name ? "" : s.supplier_name ? "Invoice number not found" : "Supplier not yet confirmed")}</small></td><td class="amount">${s.invoice_gross_total ? `${esc(s.currency || "")} ${esc(s.invoice_gross_total)}` : "—"}</td><td>${badge(r)}</td><td class="col-date"><small>${esc(date(r.finished_at || r.created_at))}</small></td><td><a class="row-action" href="#invoice/${encodeURIComponent(r.run_id)}">${isAdmin() ? (key === "held" ? "See what it needs" : "View details") : key === "held" ? "Review invoice" : key === "failed" ? "Resolve issue" : key === "running" || key === "queued" ? "View progress" : "View details"} →</a></td></tr>`;
        })
        .join("")}</tbody></table></div>`
    : `<div class="empty"><h3>${!rows.length ? "Your invoice inbox is ready" : "No invoices here"}</h3><p>${!rows.length ? "Upload your first PDF to get started." : state.search ? "Try another supplier, invoice number or filename." : "Invoices with this status will appear here."}</p>${rows.length ? '<button class="text" data-action="clear-filters">Show all invoices</button>' : ""}</div>`;
}
async function loadSamples() {
  if (!$("#samples")) return;
  try {
    state.samples = await api("/api/samples");
    if ($("#samples"))
      $("#samples").innerHTML = state.samples.length
        ? state.samples
            .map(
              (s) =>
                `<button class="small" data-sample="${esc(s.name)}" title="${esc(s.blurb)}">${esc(s.name.replaceAll("_", " ").replace(".pdf", ""))}</button>`,
            )
            .join("")
        : "No samples available. Choose a PDF from your computer.";
  } catch (e) {
    if ($("#samples"))
      $("#samples").textContent =
        "Samples are unavailable. You can still upload a PDF.";
  }
}
function intakeError(message) {
  const target = $("#upload-error") || $("#live-errors") || $("#main");
  target.innerHTML = errorHTML(message, "upload", "Choose a PDF");
}
async function upload(file) {
  if (!file) return;
  if (state.live && !state.live.finished) {
    notice("An invoice is already processing. You can follow its progress.");
    location.hash = "processing";
    return;
  }
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    intakeError("Choose a PDF invoice. Other file types aren’t supported.");
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
      )}</div><div id="live-errors">${l.error ? errorHTML(l.error, "inbox", "Back to invoices") : ""}</div>${stopped && l.detail ? `<div class="reading-result">${badge(l.detail)}<p>${l.detail.disposition === "approved" ? "This invoice is approved. No further review is needed." : l.detail.disposition === "held" ? "We need your help with a few details. Open the invoice to see what to do next." : l.detail.run_status === "failed" ? "We couldn’t read this PDF. Open the invoice for recovery options." : "Open the result to see why this invoice was rejected."}</p><a class="button-link primary" href="#invoice/${encodeURIComponent(l.runId)}">${l.detail.disposition === "held" ? "Review invoice" : "View result"} →</a></div>` : !stopped ? '<p class="reading-foot">You can leave this page. The result will appear in your inbox.</p>' : ""}</section></div>`;
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
    api(`/api/tickets?status=all&document_id=${encodeURIComponent(d.document_id)}`).catch(() => []),
  ]);
  state.tickets = tickets;
  if (generation !== state.generation) return;
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
    Object.entries(fields).map(([name, rec]) => [name, rec.raw_value]),
  );
  const curr = s.currency || rv?.context?.currency?.code || "";
  const child = runs.find((r) => r.parent_run_id === id);
  const postedRelated = runs.find(
    (r) => r.document_id === d.document_id && r.disposition === "approved",
  );
  const decisionCodes = new Set(dec?.codes ?? []);
  const blockedOnly =
    key === "rejected" && decisionCodes.size > 0 && [...decisionCodes].every((c) => c === "VENDOR_BLOCKED");
  const canReview =
    key === "held" && !!rv && !child && !postedRelated && !isAdmin();
  const canProcure = key === "held" && !!rv && !child && !postedRelated && isAdmin();
  const canRecheckRejected = blockedOnly && !!rv && !child && !postedRelated && !isAdmin();
  const adminPanel =
    isAdmin() && (key === "held" || blockedOnly) && !!rv && !child && !postedRelated
      ? adminRequestsHTML(rv, decisionCodes, canProcure ? adminInlineKinds(rv) : new Set())
      : "";
  const title = noReading
    ? "We couldn’t finish reading this invoice"
    : key === "held"
      ? open.length
        ? rechecked && persistent.size
          ? "Still on hold after checking"
          : "A few details need your review"
        : "Your changes are ready to check"
      : key === "approved"
        ? "Invoice approved"
        : key === "rejected"
          ? "Invoice rejected"
          : "Invoice could not be processed";
  const description = noReading
    ? failureHelp(d)
    : key === "held"
      ? canReview
        ? rechecked && persistent.size
          ? "You checked this invoice again. The items shown in red are still unresolved; everything else passed. Nothing has been approved yet."
          : "Work through the items below, then check the invoice again. Nothing has been approved yet."
        : canProcure
          ? "The reviewer is waiting on procurement for the items below. Once done, the reviewer checks the invoice again — approval stays with them."
          : "This is an earlier result. Open the latest result to continue."
      : key === "approved"
        ? `Added to the approved purchase order balance${d.decision_mode === "automatic_exception" ? " using the permitted budget exception" : ""}. ${d.decision_mode === "reviewer" ? "Approved after review." : "No further action is needed."}`
        : rejectionHelp(dec);
  $("#main").innerHTML =
    `<a href="#invoices" class="back-link">← All invoices</a><div class="page-heading detail-title"><div><h1>${esc(s.supplier_name || d.filename)}</h1><p>${esc(s.invoice_number ? "Invoice #" + s.invoice_number + " · " : "")}${esc(d.filename)} · ${esc(date(d.created_at))}</p></div>${uploadButton("Upload another")}</div>${child ? `<div class="success-message">This invoice has a newer result. <a href="#invoice/${encodeURIComponent(latestDescendant(id))}">Open latest result →</a></div>` : ""}<section class="card outcome ${key}${rechecked && persistent.size ? " rechecked" : ""}"><div class="outcome-head">${badge(d)}${rechecked && persistent.size ? `<span class="badge still-open">${persistent.size} still unresolved</span>` : ""}<h2>${title}</h2></div><p>${esc(description)}</p>${Object.keys(fields).length ? `<dl class="invoice-summary"><div><dt>Invoice total</dt><dd>${esc(curr)} ${esc(s.invoice_gross_total || "Not confirmed")}</dd></div><div><dt>Invoice date</dt><dd>${esc(s.invoice_date || "Not confirmed")}</dd></div><div><dt>Purchase order</dt><dd>${esc(s.po_reference || "Not selected")}</dd></div><div><dt>Supplier</dt><dd>${esc(s.supplier_name || "Not confirmed")}</dd></div></dl>` : ""}${noReading && !isAdmin() ? `<div class="button-row" style="margin-top:16px">${!child ? '<button class="primary" data-action="retry-reading">Try reading again</button>' : ""}<button data-action="upload">Upload a replacement PDF</button></div><div id="retry-error"></div>` : ""}${key === "rejected" ? duplicateLink(d, dec) : ""}</section>${adminPanel}<div class="review-layout"><div class="review-panel">${canReview ? reviewHTML(rv) : canProcure ? procurementHTML(rv) : canRecheckRejected ? blockedHTML(rv) : summaryHTML(fields)}<div id="review-notice" role="status"></div></div><section class="card document-panel" aria-label="Invoice document"><div class="document-header"><h2>Original invoice</h2><button class="mobile-document-toggle small" data-action="toggle-preview" aria-expanded="false">Show document</button><div class="page-controls" id="page-controls"></div></div><div class="document-canvas" id="document-canvas"><p>Loading document…</p></div><div class="document-caption" id="document-caption">Compare these details with your invoice.</div></section></div>${detailsHTML(d, dec, rv)}<p class="footer-note">Approval records an amount against a purchase order. This demo does not send payments.</p>`;
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
function rejectionHelp(dec) {
  const codes = dec?.codes ?? [];
  if (codes.includes("DUP_FILE_HASH"))
    return "The same PDF was already submitted. Open the earlier result to review its status; this submission added no amount.";
  if (codes.includes("DUP_INVOICE_NO"))
    return "This invoice number has already been approved for this supplier. No second amount was added.";
  if (codes.includes("VENDOR_BLOCKED"))
    return "This supplier is blocked, so the invoice was rejected automatically. If the supplier should be approved again, ask procurement below, then check again once they have.";
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
    return "Check this value against the scan. Correct it if needed, then confirm the reading.";
  return human(problem.why);
}
function editor(name, rec = {}, problem = null) {
  const scanRead =
    rec.read_method === "llm_vision" &&
    rec.status === "selected" &&
    !["attested", "corrected"].includes(rec.review_status);
  const scan = scanRead && rec.attestable !== false;
  const suggestions = problem?.suggestions?.length
    ? problem.suggestions
    : problem?.suggestion
      ? [{ value: problem.suggestion, reason: "" }]
      : [];
  const still =
    !!problem &&
    (problem.codes || []).some((c) => state.persistent?.has(c));
  return `<div class="field-editor${still ? " still-open" : ""}" id="field-${esc(name)}"><div class="field-head"><label for="input-${esc(name)}">${esc(FIELD[name] || name)}</label>${rec.evidence?.block_id ? `<button class="text small" data-evidence="${esc(name)}">Find on invoice ↗</button>` : ""}</div>${problem ? `<p>${esc(problemCopy(name, problem))}</p>` : ""}<form data-form="field" data-field="${esc(name)}"><div class="field-entry"><input id="input-${esc(name)}" name="value" value="${esc(rec.raw_value || "")}" data-original="${esc(rec.raw_value || "")}" aria-describedby="hint-${esc(name)}" required autocomplete="off"><button type="submit" class="small" ${!problem ? "disabled" : ""}>${problem ? "Save & confirm" : "Save"}</button></div><small id="hint-${esc(name)}">${esc(EXPECTED[name] || "Match the value shown on the invoice.")}</small>${suggestions.length ? `<div class="suggestions">${suggestions.map((s) => `<button type="button" class="text suggestion" data-suggestion="${esc(name)}" data-value="${esc(s.value)}">Use “${esc(s.value)}”</button>${s.reason ? `<span class="suggestion-reason">${esc(s.reason)}</span>` : ""}`).join("")}</div>` : ""}${scan ? `<label class="confirm-field"><input type="checkbox" data-attest="${esc(name)}"><span>I checked <b>${esc(rec.raw_value)}</b> against the scanned invoice.</span></label>` : scanRead ? `<small class="attest-blocked">This scan reading can’t be confirmed as it is. ${suggestions.length ? "Pick a value above" : "Type the value"}, then Save & confirm.</small>` : ""}</form></div>`;
}
function taskHTML(number, title, body, still = false) {
  return `<section class="task${still ? " still-open" : ""}"><div class="task-heading"><span class="step-number">${number}</span><h3>${title}</h3>${still ? '<span class="badge still-open">Still unresolved</span>' : ""}</div>${body}</section>`;
}
function latestTicket(kind) {
  return (state.tickets || []).find((t) => t.kind === kind) || null; // newest first
}
function ticketForm(kind, label) {
  const copy = SLOT_COPY[kind] || SLOT_COPY.other;
  return `<form data-form="ticket" data-kind="${esc(kind)}"><input type="hidden" name="kind" value="${esc(kind)}"><label>Note for procurement<textarea name="note" placeholder="${esc(copy.placeholder)}"></textarea></label><div class="button-row"><button class="primary small">${esc(label || copy.ask)}</button><small>Tracked request · appears in procurement’s queue · recorded on this invoice</small></div></form>`;
}
// The state machine for one request kind: none → open → resolved | declined.
function slotHTML(kind, { still = false, followUp = "", recheck = true } = {}) {
  const t = latestTicket(kind);
  if (!t) return `<div class="slot">${ticketForm(kind)}</div>`;
  const note = (text) => (text ? ` · “${esc(text)}”` : "");
  if (t.status === "open")
    return `<div class="slot waiting"><b>Sent to procurement</b> · ${esc(dateTime(t.created_at))}${note(t.note)}<p>You will see their reply here. The invoice stays pending until then.</p></div>`;
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
      rows.push(`<div class="slot done compact"><b>Done by procurement</b> · ${esc(label)}${t.resolution_note ? ` · “${esc(t.resolution_note)}”` : ""} · ${esc(dateTime(t.resolved_at))}</div>`);
    else if (t.status === "open")
      rows.push(`<div class="slot waiting compact"><b>Open with procurement</b> · ${esc(label)}${t.note ? ` · “${esc(t.note)}”` : ""} · ${esc(dateTime(t.created_at))}</div>`);
  }
  return rows.length ? `<div class="task ticket-notices">${rows.join("")}</div>` : "";
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
      ask = askHTML(
        "Not an approved supplier",
        "If the name is misread, correct it above. If this is a genuinely new supplier, procurement has to onboard them before the invoice can be approved.",
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
      name !== "supplier_name" &&
      (name !== "po_reference" || !poNeedsSelection)
    )
      fieldNames.add(name);
  const scanPending = Object.values(fields).some(
    (v) => v.read_method === "llm_vision" && v.status === "selected" && !["attested", "corrected"].includes(v.review_status),
  );
  if (fieldNames.size) {
    sections += taskHTML(
      ++n,
      "Check the invoice details",
      `<p>Confirm these values against the document. Save each correction as you go.</p>${[...fieldNames].map((name) => editor(name, fields[name], problems[name])).join("")}${scanPending ? '<button class="small" data-action="confirm-scan" style="margin-top:16px">Confirm checked values</button>' : ""}`,
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
    const poCode = ["PO_CLOSED", "CURRENCY_MISMATCH", "PO_VENDOR_MISMATCH", "NO_PO_MATCH"].find((c) => openCodes.has(c));
    let body = `<p>${esc(problems.po_reference ? problemCopy("po_reference", problems.po_reference) : "Choose the order this invoice belongs to.")}</p>`;
    if (!rv.diagnosis.vendor_resolved) {
      body += '<div class="callout">Confirm or add the supplier first (step above). Their purchase orders will appear here.</div>';
    } else {
      if (candidates.length)
        body += `<form data-form="pick-po" class="form-grid"><label>Purchase order<select name="po" required><option value="">Choose an order…</option>${candidates
          .map((p) => {
            const live = state.pos.find((x) => x.po_id === p.po_id);
            return `<option value="${esc(p.po_id)}" ${raw("po_reference") === p.po_id ? "selected" : ""}>${esc(p.po_id)} · ${esc(money(p.amount_minor - (live?.consumed_minor || 0), p.currency))} remaining</option>`;
          })
          .join("")}</select></label><button>Use this purchase order</button></form>`;
      if (!candidates.length || (poCode && poCode !== "NO_PO_MATCH")) {
        shownKinds.add("raise_po");
        const text =
          {
            PO_CLOSED: "The referenced order is closed. Procurement can reopen it or raise a new one.",
            CURRENCY_MISMATCH: "The invoice currency does not match the referenced order. If the currency above is misread, correct it; otherwise procurement has to raise an order in this currency.",
            PO_VENDOR_MISMATCH: "The referenced order belongs to a different supplier. Choose the right order above, or ask procurement.",
          }[poCode] ||
          (candidates.length
            ? "If none of the open orders is the one this invoice bills against, procurement can raise one."
            : "No open purchase order matches this supplier and currency. If the invoice is right, procurement has to raise one before it can be approved.");
        body += askHTML(
          candidates.length ? "Need a different order?" : "No usable purchase order",
          text,
          "raise_po",
          {
            collapse: candidates.length ? "None of these orders is right? Ask procurement" : "",
            still: !!poCode && persistent.has(poCode),
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
  if (external.length) {
    const blocks = external.map((i) => {
      const still = persistent.has(i.code);
      if (i.code === "PO_BUDGET_EXCEEDED") {
        shownKinds.add("amend_po");
        return askHTML(
          "Over the order’s budget",
          "Approving would exceed what the purchase order authorizes. If the total or the order is misread, correct it above. If the invoice is right, procurement has to amend the order.",
          "amend_po",
          { still, extra: '<a href="#pos">View order balances →</a>' },
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
        return `<div class="callout${still ? " still" : ""}"><h3>Possible duplicate</h3><p>Another invoice from this supplier has the same amount and date. Compare them. If this is a genuinely separate invoice, say why below and the next check will approve it; if it is the same invoice, reject it.</p><a href="#invoices">Compare invoices in the inbox →</a><form data-form="confirm-distinct" class="slot-form"><label>Why this is a separate invoice<textarea name="note" required minlength="5" placeholder="For example: two deliveries the same day; invoice numbers differ; both on the delivery notes"></textarea></label><div class="button-row"><button class="small">Confirm it is a separate invoice</button><small>Recorded on the audit trail under your name.</small></div></form></div>`;
      if (i.code === "CONTENT_CONFLICT")
        return `<div class="callout${still ? " still" : ""}"><h3>Another version of this invoice was already approved</h3><p>A different amount is recorded for this invoice number. If the total here is misread, correct it under other invoice details. Otherwise finance decides which version stands; reject the wrong one below.</p><a href="#invoices">Compare invoices in the inbox →</a></div>`;
      if (i.code === "UNSUPPORTED_AMOUNT_STRUCTURE")
        return `<div class="callout${still ? " still" : ""}"><h3>Prepayment or adjustment</h3><p>This invoice includes a prepayment or adjustment that this workflow cannot approve. If a value was misread, correct it using the document. Otherwise handle it through finance’s exception process and reject it here with the reason.</p></div>`;
      return `<div class="callout${still ? " still" : ""}"><h3>Not a standard invoice</h3><p>Credit notes and other document types follow your team’s own process. Reject this submission, then upload a standard invoice if needed.</p></div>`;
    });
    sections += taskHTML(
      ++n,
      external.length === 1 && external[0].code === "PO_BUDGET_EXCEEDED"
        ? "Resolve the budget"
        : external.length === 1 && external[0].code === "DUP_FINGERPRINT"
          ? "Check for a duplicate"
          : "Resolve the remaining checks",
      blocks.join(""),
      external.some((i) => persistent.has(i.code)),
    );
  }
  if (!sections)
    sections =
      '<div class="task"><p class="saved-mark">✓ Your corrections are saved.</p><p>Check the invoice again to confirm it now meets the approval rules.</p></div>';
  const other = Object.keys(FIELD).filter(
    (name) =>
      !fieldNames.has(name) &&
      !(name === "supplier_name" && supplierProblem) &&
      !(name === "po_reference" && poProblem),
  );
  const stillCount = open.filter((i) => persistent.has(i.code)).length;
  const resolvedCount = items.filter((i) => i.status === "resolved").length;
  const otherTicket = latestTicket("other");
  return `<section class="card"><div class="section-heading"><h2>${n ? (stillCount ? "What still needs your attention" : "What needs your attention") : "Ready to check again"}</h2><p>${stillCount ? `<span class="still-open-note">${stillCount} item${stillCount === 1 ? "" : "s"} in red ${stillCount === 1 ? "was" : "were"} still unresolved when you last checked.</span> ` : ""}${resolvedCount ? `${resolvedCount} of ${items.length} checks resolved · ` : ""}Changes are saved when you confirm each field.</p></div>${ticketNoticesHTML(shownKinds)}${sections}<div class="task"><details><summary>View or edit other invoice details</summary>${other.map((name) => editor(name, fields[name], null)).join("")}</details></div><div class="review-footer"><p>When you’re done, check again. The invoice will be approved automatically if all checks pass.</p><button class="primary" data-action="check-again">Check again</button><div id="decision-error"></div>${scanPending ? '<button class="text" data-action="confirm-scan" style="margin-top:10px">Confirm checked scan values</button>' : ""}<details class="compact-details other-request"${otherTicket ? " open" : ""}><summary>Need something else from procurement?</summary>${slotHTML("other")}</details><details class="rejection"><summary>Can’t resolve this invoice? Reject it</summary><form data-form="reject"><label>Why should this invoice be rejected?<textarea name="reason" required placeholder="For example: Supplier needs to send a corrected invoice"></textarea></label><button class="danger">Reject invoice</button></form></details></div></section>`;
}
// Rejected because the supplier is blocked: the one rejection a reviewer can
// still act on, through procurement.
function blockedHTML(rv) {
  const supplier = raw("supplier_name");
  return `<section class="card"><div class="section-heading"><h2>What you can do</h2><p>The supplier is blocked, so this invoice was rejected automatically. Only procurement can approve a supplier again.</p></div><div class="task">${askHTML(
    "Supplier is blocked",
    `${supplier || "This supplier"} is on the blocked list. If you believe it should be approved again, ask procurement. If not, the rejection stands.`,
    "unblock_supplier",
    { followUp: "Check the invoice again. With the supplier approved, the normal checks run and can approve it." },
  )}${ticketNoticesHTML(new Set(["unblock_supplier"]))}</div><div class="review-footer"><p>Once procurement has approved the supplier again, check again.</p><button class="primary" data-action="check-again">Check again</button><div id="decision-error"></div></div></section>`;
}
// Admin mirror of the slot: the reviewer's open request for this kind, with
// the resolve/decline form, inline in the task that answers it.
function adminSlotHTML(kind) {
  const t = latestTicket(kind);
  if (!t || t.status !== "open") return "";
  return `<div class="slot waiting"><b>Reviewer asked</b> · ${esc(t.requested_by)} · ${esc(dateTime(t.created_at))}${t.note ? ` · “${esc(t.note)}”` : ""}<form data-form="resolve-ticket" data-id="${esc(t.ticket_id)}"><label>Note for the reviewer<textarea name="note" placeholder="What you did, or why this is declined"></textarea></label><div class="button-row"><button class="primary small" name="outcome" value="resolved">Mark done</button><button class="small danger" name="outcome" value="declined">Decline</button></div></form></div>`;
}
function adminInlineKinds(rv) {
  const kinds = new Set();
  for (const i of rv.diagnosis.items)
    if (i.status !== "resolved" && KIND_FOR_CODE[i.code] && i.code !== "VENDOR_BLOCKED")
      kinds.add(KIND_FOR_CODE[i.code]);
  return kinds;
}
function procurementHTML(rv) {
  const open = rv.diagnosis.items.filter((i) => i.status !== "resolved");
  const codes = new Set(open.map((i) => i.code));
  const fields = rv.fields;
  const supplier = raw("supplier_name");
  const currency = /^[A-Z]{3}$/.test(raw("currency").trim().toUpperCase())
    ? raw("currency").trim().toUpperCase()
    : rv.context?.currency?.code || "";
  let n = 0;
  let body = "";
  if (codes.has("VENDOR_UNKNOWN"))
    body += taskHTML(
      ++n,
      "Onboard the supplier",
      `<p>The invoice names <b>${esc(supplier || "an unreadable supplier")}</b>, which is not an approved supplier. If your team has approved them, add them here. If the name is a misread, the reviewer corrects it instead.</p><form data-form="onboard" class="form-grid"><label>Supplier legal name<input name="name" value="${esc(supplier)}" required></label><label>Country (optional)<input name="country"></label><button class="primary">Add approved supplier</button></form>${adminSlotHTML("onboard_supplier")}`,
    );
  if (codes.has("NO_PO_MATCH") || codes.has("PO_CLOSED") || codes.has("CURRENCY_MISMATCH") || codes.has("PO_VENDOR_MISMATCH")) {
    const canCreate = rv.diagnosis.vendor_resolved;
    body += taskHTML(
      ++n,
      "Raise or fix the purchase order",
      canCreate
        ? `<p>${esc(codes.has("PO_CLOSED") ? "The referenced order is closed." : codes.has("CURRENCY_MISMATCH") ? "The invoice currency does not match the referenced order." : codes.has("PO_VENDOR_MISMATCH") ? "The referenced order belongs to a different supplier." : rv.po_candidates.length ? `An open order already exists for this supplier (${rv.po_candidates.map((p) => p.po_id).join(", ")}) — the reviewer can select it without procurement. Raise a new order only if this invoice bills against different authorized spend.` : "No open purchase order matches this invoice.")} ${rv.po_candidates.length ? "" : "If procurement has authorized this spend, record the order here; the reviewer will then select it."}</p><form data-form="create-po" class="form-grid two"><label class="full">Purchase order number<input name="po_id" placeholder="PO-1005" value="${esc((raw("po_reference").match(/[A-Z0-9]*PO-[A-Za-z0-9]+/) || [])[0] || "")}" required></label><label>Currency<input name="currency" placeholder="USD" value="${esc(currency)}" required></label><label>Authorized amount<input name="amount" inputmode="decimal" placeholder="10000.00" required></label><button class="primary full">Add purchase order</button></form>${rv.po_candidates.length ? `<p style="margin-top:10px">Existing open orders for this supplier: ${rv.po_candidates.map((p) => esc(p.po_id)).join(", ")}. <a href="#pos">Amend or reopen orders →</a></p>` : ""}${adminSlotHTML("raise_po")}`
        : `<p>The supplier must be approved first (step above); its purchase orders can be raised after that.</p>${adminSlotHTML("raise_po")}`,
    );
  }
  if (codes.has("PO_BUDGET_EXCEEDED"))
    body += taskHTML(
      ++n,
      "Amend the authorized amount",
      `<p>Approving this invoice would exceed the purchase order budget. If the spend is authorized, amend the order on the <a href="#pos">Purchase orders</a> page (it can never be lowered below billing already approved). The reviewer then checks again.</p>${adminSlotHTML("amend_po")}`,
    );
  if (!body)
    body =
      '<div class="task"><p>Nothing here needs procurement. The remaining items (field corrections, scan confirmation, duplicates) are for the invoice reviewer.</p></div>';
  return `<section class="card"><div class="section-heading"><h2>What procurement can do here</h2><p>Actions are recorded on this invoice’s audit trail as ${esc(state.user?.actor || "procurement")}. Approval itself stays with the invoice reviewer.</p></div>${body}<div class="task"><details><summary>Invoice details as read</summary>${summaryHTML(fields)}</details></div></section>`;
}
function ticketHTML(t) {
  const status = t.status;
  return `<div class="ticket" id="ticket-${esc(t.ticket_id)}"><div class="ticket-head"><span class="badge ${esc(status)}">${esc(status === "open" ? "Open" : status === "resolved" ? "Resolved" : "Declined")}</span><b>${esc(TICKET_KINDS[t.kind] || t.kind)}</b><span class="who">by ${esc(t.requested_by)}</span><time>${esc(dateTime(t.created_at))}</time></div>${t.note ? `<p>“${esc(t.note)}”</p>` : ""}${
    status !== "open"
      ? `<div class="resolution ${esc(status)}"><b>${esc(t.resolved_by)}</b> · ${esc(dateTime(t.resolved_at))}${t.resolution_note ? ` — ${esc(t.resolution_note)}` : ""}</div>`
      : isAdmin()
        ? `<form data-form="resolve-ticket" data-id="${esc(t.ticket_id)}"><label>Note for the reviewer<textarea name="note" placeholder="What you did, or why this is declined"></textarea></label><div class="button-row"><button class="primary small" name="outcome" value="resolved">Mark resolved</button><button class="small danger" name="outcome" value="declined">Decline</button></div></form>`
        : '<p style="color:var(--info-fg)">Waiting for procurement. You will see their note here.</p>'
  }</div>`;
}
// Admin only. Open requests already answered inline (see adminSlotHTML) are
// left out; what remains is the blocked-supplier action, requests of kinds
// with no task on this page, and the history of answered ones.
function adminRequestsHTML(rv, codes, inlineKinds) {
  const tickets = (state.tickets || []).filter(
    (t) => !(t.status === "open" && inlineKinds.has(t.kind)),
  );
  const supplier = raw("supplier_name");
  const vendor = state.vendors.find((v) => v.supplier_id === rv.po_supplier_id);
  const blockedVendorId =
    rv.po_supplier_id && (vendor ? vendor.status === "blocked" : codes.has("VENDOR_BLOCKED"))
      ? rv.po_supplier_id
      : null;
  if (!tickets.length && !blockedVendorId) return "";
  const openCount = tickets.filter((t) => t.status === "open").length;
  return `<section class="card request-panel" style="margin-bottom:18px"><div class="section-heading"><h2>${openCount ? "Requests from the reviewer" : "Request history"}</h2><p>${openCount ? "Resolve or decline each request with a note; the reviewer sees it on the invoice." : "Earlier requests on this invoice and how they were answered."}</p></div>${
    blockedVendorId
      ? `<div class="task"><div class="callout"><h3>Blocked supplier</h3><p><b>${esc(supplier)}</b> is blocked, so this invoice was rejected automatically. If the reviewer’s request is legitimate, approve the supplier again, then mark the request done so they can check the invoice again.</p><button class="small" data-action="unblock-supplier" data-id="${esc(blockedVendorId)}">Approve supplier again</button></div></div>`
      : ""
  }${tickets.length ? `<div class="task">${tickets.map(ticketHTML).join("")}</div>` : ""}</section>`;
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
    `<div class="pdf-page"><img src="/api/runs/${encodeURIComponent(state.detail.run_id)}/page/${state.page}?access_code=${encodeURIComponent(getToken() || "")}" alt="Original invoice, page ${state.page}">${overlay}</div>`;
  $("#document-canvas img").addEventListener("error", () => {
    $("#document-canvas").innerHTML = errorHTML(
      "This page could not be displayed. Reload the preview or use your original PDF.",
      "retry-preview",
      "Reload preview",
    );
  });
  $("#document-caption").textContent = block
    ? `${FIELD[state.selectedField] || state.selectedField}: ${field.raw_value}`
    : "Select “Find on invoice” beside a field to highlight its location.";
}
function activityText(event) {
  if (event.event_type === "ticket_opened")
    return `Request to procurement opened by ${event.payload.actor}: ${TICKET_KINDS[event.payload.kind] || event.payload.kind}${event.payload.note ? ` — “${event.payload.note}”` : ""}`;
  if (event.event_type === "ticket_resolved" || event.event_type === "ticket_declined")
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
      operational_failure: "Could not read the PDF.",
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
async function master(kind, generation) {
  const [pos, vendors] = await Promise.all([
    api("/api/pos"),
    api("/api/vendors"),
  ]);
  if (generation !== state.generation) return;
  state.pos = pos;
  state.vendors = vendors;
  const isPO = kind === "pos";
  $("#main").innerHTML =
    header(
      isPO ? "Purchase orders" : "Suppliers",
      isPO
        ? "Check the authorized budget available for each supplier."
        : "Suppliers your team has approved for invoice processing.",
    ) +
    (isAdmin() ? `<details class="card form-card"><summary>${isPO ? "Add an authorized purchase order" : "Add an approved supplier"}</summary><p style="margin-top:10px;font-size:12px">${isPO ? "Enter an existing authorization from procurement." : "Confirm that your team has approved this supplier before adding it here."}</p><form data-form="${isPO ? "master-po" : "master-vendor"}" class="form-grid two">${
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
    }<button class="primary full">${isPO ? "Add purchase order" : "Add supplier"}</button></form></details>` : `<p class="footer-note" style="margin-top:0">${isPO ? "Purchase orders are managed by procurement (administrator role). You can check balances here; ask procurement to raise or amend an order." : "Suppliers are managed by procurement (administrator role). You can check who is approved here; ask procurement to onboard a new supplier."}</p>`) +
    (isPO
      ? `<section class="card"><div class="table-scroll"><table><thead><tr><th>Purchase order</th><th>Supplier</th><th>Approved billing</th><th class="amount">Remaining budget</th><th>Status</th></tr></thead><tbody>${pos.map((p) => `<tr><td><b>${esc(p.po_id)}</b></td><td>${esc(vendors.find((v) => v.supplier_id === p.supplier_id)?.name || p.supplier_id)}</td><td>${esc(money(p.consumed_minor, p.currency))}<small>of ${esc(money(p.amount_minor, p.currency))}</small><div class="budget-track"><span style="width:${Math.max(0, Math.min(100, (p.consumed_minor / Math.max(1, p.amount_minor)) * 100))}%"></span></div></td><td class="amount">${esc(money(p.amount_minor - p.consumed_minor, p.currency))}</td><td><span class="badge ${p.status === "open" ? "approved" : ""}">${esc(p.status === "open" ? "Open" : "Closed")}</span>${
        isAdmin()
          ? `<div class="po-actions" style="margin-top:8px"><button class="small" data-action="amend-po" data-id="${esc(p.po_id)}" aria-expanded="false">Amend</button><button class="small" data-action="${p.status === "open" ? "close-po" : "reopen-po"}" data-id="${esc(p.po_id)}">${p.status === "open" ? "Close" : "Reopen"}</button><button class="small danger" data-action="delete-po" data-id="${esc(p.po_id)}" ${p.consumed_minor ? 'title="Orders with approved billing cannot be deleted — close them instead"' : ""}>Delete</button></div><form class="po-amend" data-form="amend-po" data-id="${esc(p.po_id)}" hidden><input name="amount" inputmode="decimal" value="${esc((p.amount_minor / 10 ** (EXP[p.currency] ?? 2)).toFixed(EXP[p.currency] ?? 2))}" aria-label="New authorized amount" required><button class="primary small">Save</button></form>`
          : ""
      }</td></tr>`).join("")}</tbody></table></div>${!pos.length ? '<div class="empty"><p>No purchase orders yet. Add an authorized order to get started.</p></div>' : ""}</section><p class="footer-note">Held and rejected invoices use no budget. ${isAdmin() ? "Amending an order can never lower it below the billing already approved against it." : "Only procurement (administrator role) can raise, amend or close purchase orders."}</p>`
      : `<div class="supplier-grid">${vendors
          .map((v) => {
            const referenced = (v.total_pos || 0) + (v.invoices || 0) > 0;
            return `<section class="card supplier-card" id="vendor-${esc(v.supplier_id)}"><h2 style="font-size:15px">${esc(v.name)}</h2><p>${esc(v.country || "Country not specified")} · ${v.open_pos || 0} open purchase order${v.open_pos === 1 ? "" : "s"}</p><span class="badge ${v.status === "approved" ? "approved" : "blocked"}">${esc(v.status === "approved" ? "Approved supplier" : "Blocked")}</span><p class="meta">${referenced ? `${v.invoices || 0} invoice${v.invoices === 1 ? "" : "s"} · ${v.total_pos || 0} purchase order${v.total_pos === 1 ? "" : "s"} on record` : "No invoices or purchase orders yet"}</p>${isAdmin() ? `<div class="supplier-actions"><button class="small" data-action="edit-vendor" data-id="${esc(v.supplier_id)}" aria-expanded="false">Edit</button>${v.status === "approved" ? `<button class="small" data-action="block-vendor" data-id="${esc(v.supplier_id)}">Block</button>` : `<button class="small" data-action="unblock-vendor" data-id="${esc(v.supplier_id)}">Approve again</button>`}<button class="small danger" data-action="delete-vendor" data-id="${esc(v.supplier_id)}" ${referenced ? 'title="Suppliers with invoices or purchase orders cannot be deleted — block them instead"' : ""}>Delete</button></div><form class="edit-vendor" data-form="edit-vendor" data-id="${esc(v.supplier_id)}" hidden><label>Supplier legal name<input name="name" value="${esc(v.name)}" required></label><label>Country<input name="country" value="${esc(v.country || "")}" placeholder="US"></label><div class="button-row"><button class="primary small">Save changes</button><button type="button" class="small" data-action="edit-vendor" data-id="${esc(v.supplier_id)}">Cancel</button></div><small>Renaming keeps the old name recognised, so invoices that still print it will match.</small></form>` : ""}</section>`;
          })
          .join("")}</div><p class="footer-note">${isAdmin() ? "Blocking a supplier rejects its future invoices without deleting history. Deleting is only possible for suppliers with no invoices or purchase orders." : "Only procurement (administrator role) can onboard, edit or block suppliers."}</p>`);
}
async function queue(generation) {
  const [items, tickets] = await Promise.all([
    api("/api/queue/procurement"),
    api("/api/tickets?status=open"),
  ]);
  if (generation !== state.generation) return;
  $("#queue-count").textContent = items.length + tickets.length || "";
  const byRequester = {};
  for (const t of tickets) (byRequester[t.requested_by] ??= []).push(t);
  const requestsHTML = tickets.length
    ? Object.entries(byRequester)
        .map(
          ([who, list]) => `<div class="requester-group"><h3>From ${esc(who)} · ${list.length} open</h3>${list
            .map(
              (t) => `<div class="ticket"><div class="ticket-head"><span class="badge open">Open</span><b>${esc(t.kind_label)}</b><time>${esc(dateTime(t.created_at))}</time></div><p><b>${esc(t.supplier_name || "Supplier not read")}</b> · ${esc(t.filename)}${t.po_reference ? ` · ref ${esc(t.po_reference)}` : ""}${t.note ? `<br>“${esc(t.note)}”` : ""}</p><div class="button-row" style="margin-top:10px"><a class="button-link primary" href="#invoice/${encodeURIComponent(t.run_id)}">Open invoice & resolve →</a></div></div>`,
            )
            .join("")}</div>`,
        )
        .join("")
    : '<div class="empty"><p>No open requests from reviewers.</p></div>';
  $("#main").innerHTML =
    header(
      "Procurement queue",
      "Held invoices that need a procurement action before the reviewer can continue.",
    ) +
    `<section class="card card-pad"><h2 style="font-size:15px;margin:0 0 4px">Requests from reviewers</h2><p style="margin:0;color:var(--muted);font-size:13px">Tracked tickets raised on specific invoices. Resolve them from the invoice page.</p>${requestsHTML}</section><section class="card card-pad" style="margin-top:18px"><h2 style="font-size:15px;margin:0 0 4px">Detected needs</h2><p style="margin:0 0 6px;color:var(--muted);font-size:13px">Held invoices whose blockers need procurement even without a request.</p>${
      items.length
        ? items
            .map(
              (it) => `<div class="queue-row"><div><b>${esc(it.supplier_name || "Supplier not read")}</b><br><small>${esc(it.filename)}${it.po_reference ? ` · ref ${esc(it.po_reference)}` : ""}</small></div><div>Needs procurement to:<ul>${it.asks.map((a) => `<li>${esc(a.text)}</li>`).join("")}</ul></div><a class="button-link primary" href="#invoice/${encodeURIComponent(it.run_id)}">Open & resolve →</a></div>`,
            )
            .join("")
        : '<div class="empty"><p>Nothing is waiting on procurement. Held invoices that need a supplier or purchase order action will appear here.</p></div>'
    }</section><p class="footer-note">Resolving here (onboard a supplier, raise or amend an order) is recorded on the invoice’s audit trail. The reviewer then checks the invoice again.</p>`;
}
async function refreshQueueCount() {
  if (!isAdmin()) return;
  try {
    const [items, tickets] = await Promise.all([
      api("/api/queue/procurement"),
      api("/api/tickets?status=open"),
    ]);
    $("#queue-count").textContent = items.length + tickets.length || "";
  } catch (e) {}
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
function help() {
  $("#main").innerHTML =
    header(
      "A simpler way to review invoices",
      "Upload, check, and act only where your help is needed.",
    ) +
    `<div class="help-content"><section class="card"><h2>Your invoice journey</h2><ol><li><b>Upload a PDF.</b> We read the details and check the supplier, purchase order and amounts.</li><li><b>See the result.</b> Eligible invoices are approved automatically. Invoices that need your help appear under Needs attention.</li><li><b>Resolve the highlighted items.</b> Compare the details with the original, save corrections, and select a purchase order. For scans, confirm the values you’ve checked.</li><li><b>Check again.</b> All rules run again. Passing invoices are approved; anything unresolved gets a next step.</li></ol><h3>What the statuses mean</h3><p><b>Approved:</b> The amount was added to the approved purchase order balance. An exception label means a permitted small budget overage.</p><p><b>Needs review:</b> Nothing was approved. Open the invoice for corrections or next steps.</p><p><b>Rejected:</b> No amount was added. The invoice explains why, including duplicates and blocked suppliers.</p><p><b>Couldn’t process:</b> The document could not be read. Retry an interrupted reading or upload a replacement PDF.</p></section><section class="card"><h2>If you can’t resolve an invoice</h2><p>Keep it pending while you ask your supplier or procurement team for the missing information. Reject it with a reason if it should not proceed.</p><p>Anything that needs master data — a new or blocked supplier, a missing or too-small purchase order — is sent to procurement from the task itself and answered there. A same-day match can be confirmed as a separate invoice with a recorded reason; exact duplicates are final. The demo never reverses an approval or sends a payment.</p><p>Each invoice keeps its original document, earlier attempts, decision explanation and technical evidence under <b>Decision details & activity</b>.</p></section><section class="card"><h2>Roles</h2><p><b>Invoice reviewer</b> uploads, corrects, approves and rejects. <b>Procurement admin</b> manages suppliers and purchase orders and works the procurement queue, but cannot approve — the person who creates the budget is never the person who releases money against it. Every action is recorded with the role that performed it, and the server enforces the split on every request.</p><p>Use <b>Switch role</b> in the top bar to sign in as the other role.</p></section>${isAdmin() ? '<section class="card"><h2>Demo settings</h2><p>Reset removes all invoices, reviews and approvals in this demo and restores the example suppliers and purchase orders. This cannot be undone.</p><button class="danger" data-action="reset">Reset demo workspace</button><div id="reset-error"></div></section>' : ""}<a href="#invoices">← Back to invoices</a></div>`;
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
  const drafts = [...document.querySelectorAll("[data-original]")]
    .filter(
      (i) =>
        i.value.trim() !== i.dataset.original &&
        !exclude.includes(i.id.replace("input-", "")),
    )
    .map((i) => [i.id, i.value]);
  const checks = [...document.querySelectorAll("[data-attest]:checked")].map(
    (i) => [i.dataset.attest, raw(i.dataset.attest)],
  );
  await detail(id, state.generation);
  for (const [inputId, value] of drafts) {
    const i = document.getElementById(inputId);
    if (i) {
      i.value = value;
      i.dispatchEvent(new Event("input", { bubbles: true }));
      i.closest("details")?.setAttribute("open", "");
    }
  }
  for (const [name, value] of checks) {
    const i = document.querySelector(`[data-attest="${CSS.escape(name)}"]`);
    if (i && raw(name) === value) i.checked = true;
  }
}
async function submitForm(form) {
  const type = form.dataset.form;
  const body = Object.fromEntries(new FormData(form));
  await withAction(form, async () => {
    if (type === "field") {
      const field = form.dataset.field;
      await reviewPost("correct", {
        field,
        value: body.value.trim(),
        expected_seq: state.review.revision_seq,
      });
      await refreshDetail([field]);
      notice(`${FIELD[field] || field} saved.`);
    } else if (type === "pick-po") {
      await reviewPost("correct", {
        field: "po_reference",
        value: body.po,
        expected_seq: state.review.revision_seq,
      });
      await refreshDetail(["po_reference"]);
      notice("Purchase order selected.");
    } else if (type === "onboard") {
      await post("/api/vendors", {
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
          ? "Supplier added. The reviewer can now choose or wait for a purchase order."
          : "Supplier added. You can now choose a purchase order.",
      );
    } else if (type === "create-po") {
      await post("/api/pos", {
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
          ? "Purchase order added. The reviewer can now select it and check again."
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
      notice(result.existing ? "That request is already open with procurement." : "Request sent to procurement.");
      await refreshDetail();
    } else if (type === "confirm-distinct") {
      await reviewPost("confirm-distinct", {
        note: body.note.trim(),
        expected_seq: state.review.revision_seq,
      });
      await refreshDetail();
      notice("Recorded as a separate invoice. Check again to approve it.");
    } else if (type === "resolve-ticket") {
      const outcome = form.dataset.outcome || "resolved";
      await post(`/api/tickets/${encodeURIComponent(form.dataset.id)}/resolve`, {
        outcome,
        note: (body.note || "").trim(),
      });
      notice(outcome === "resolved" ? "Request marked resolved." : "Request declined.");
      refreshQueueCount();
      await route();
    } else if (type === "login") {
      const result = await api("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: body.code.trim() }),
      });
      try {
        localStorage.setItem(TOKEN_KEY, result.token);
      } catch (e) {}
      state.user = { role: result.role, label: result.label, actor: result.actor };
      applyRoleUI();
      notice(`Signed in as ${result.label.toLowerCase()}.`);
      refreshQueueCount();
      if (!location.hash || location.hash === "#landing") location.hash = "invoices";
      else await route();
    } else if (type === "amend-po") {
      const id = form.dataset.id;
      await api(`/api/pos/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: body.amount.trim() }),
      });
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
  if (action === "toggle-theme") {
    applyTheme(
      document.documentElement.dataset.theme === "dark" ? "light" : "dark",
    );
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
      notice("Supplier approved again. Resolve the request so the reviewer can check the invoice.");
      await route();
    });
    return;
  }
  if (action === "switch-role") {
    if (unsaved() && !(await confirmAction("Leave unsaved changes?", "Changes still in the input fields will be discarded.", "Switch role"))) return;
    signOut();
    location.hash = "";
    await renderLanding();
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
    const id = button.dataset.id;
    await withAction(button.closest("td"), async () => {
      await api(`/api/pos/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: action === "close-po" ? "closed" : "open" }),
      });
      notice(action === "close-po" ? `${id} closed. New invoices against it will hold.` : `${id} reopened.`);
      await route();
    });
    return;
  }
  if (action === "delete-po") {
    const id = button.dataset.id;
    if (!(await confirmAction("Delete this purchase order?", "Orders with approved billing recorded against them cannot be deleted — close them instead.", "Delete order"))) return;
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
  if (action === "upload") {
    $("#file-input").click();
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
  if (action === "retry-reading") {
    const id = state.detail.run_id;
    beginLive(state.detail.filename, () =>
      post(
        `/api/runs/${encodeURIComponent(id)}/retry`,
        {},
        { timeout: 180000 },
      ),
    );
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
    if (document.querySelector("[data-attest]:checked")) {
      formError(
        container,
        new Error("Confirm your checked scan values before checking again."),
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
  if (action === "confirm-scan") {
    const container =
      button.closest(".task") || button.closest(".review-footer");
    const checked = [...document.querySelectorAll("[data-attest]:checked")];
    if (!checked.length) {
      formError(
        container,
        new Error(
          "Check the boxes for values you have compared with the original invoice.",
        ),
      );
      return;
    }
    if (
      checked.some((i) => {
        const input = $(`#input-${CSS.escape(i.dataset.attest)}`);
        return input && input.value.trim() !== input.dataset.original;
      })
    ) {
      formError(
        container,
        new Error(
          "Save your edited scan values first, then confirm the remaining readings.",
        ),
      );
      return;
    }
    await withAction(container, async () => {
      await reviewPost("attest", {
        fields: checked.map((i) => i.dataset.attest),
        expected_seq: state.review.revision_seq,
      });
      await refreshDetail();
      notice("Checked scan values confirmed.");
    });
    return;
  }
  if (action === "reset") {
    if (
      !(await confirmAction(
        "Reset the demo workspace?",
        "This permanently removes every invoice, review and approval in this demo. Example suppliers and purchase orders will be restored.",
        "Reset workspace",
      ))
    )
      return;
    await withAction(button.closest("section"), async () => {
      await post("/api/admin/reset");
      state.live = null;
      notice("Demo workspace reset.");
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
  submitForm(form);
});
document.addEventListener("input", (e) => {
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
  const button = e.target.closest("button");
  if (button?.dataset.action) {
    e.preventDefault();
    handleAction(button.dataset.action, button);
    return;
  }
  if (button?.dataset.filter) {
    state.filter = button.dataset.filter;
    renderRows();
    return;
  }
  if (button?.dataset.sample) {
    const sample = button.dataset.sample;
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
$("#file-input").addEventListener("change", (e) => {
  upload(e.target.files[0]);
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
    if (e.dataTransfer.files.length !== 1) {
      intakeError("Choose one invoice PDF at a time.");
      return;
    }
    upload(e.dataTransfer.files[0]);
  }
});
window.addEventListener("beforeunload", (e) => {
  if (unsaved()) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("hashchange", route);
applyTheme(document.documentElement.dataset.theme || "light", false);
ensureSession().then(() => {
  route();
  refreshQueueCount();
});
setInterval(async () => {
  if (!state.user || state.route !== "invoices" || state.busy) return;
  try {
    const runs = await api("/api/runs");
    if (state.route === "invoices" && $("#invoice-table")) {
      if (JSON.stringify(state.runs) !== JSON.stringify(runs)) {
        state.runs = runs;
        renderRows();
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
