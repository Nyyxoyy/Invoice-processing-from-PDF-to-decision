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
    const response = await fetch(path, {
      ...options,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
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
  return `<button class="primary" data-action="upload">${text}</button>`;
}
async function route() {
  const generation = ++state.generation;
  const route = location.hash.slice(1) || "invoices";
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
<section class="upload-zone" id="drop-zone" aria-label="Drop an invoice PDF"><div class="upload-icon" aria-hidden="true">↥</div><div><h2>Drop an invoice here</h2><p>One PDF at a time · up to 10 MB and 10 pages</p></div><button data-action="upload">Choose a PDF</button></section><div id="upload-error"></div>
<details class="sample-details"><summary>Just exploring? Try a sample invoice</summary><div class="samples" id="samples">Loading samples…</div></details>
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
          return `<tr><td><a class="invoice-link" href="#invoice/${encodeURIComponent(r.run_id)}">${esc(s.supplier_name || r.filename || "Invoice")}</a><small class="invoice-sub">${esc(s.invoice_number ? `#${s.invoice_number} · ${r.filename}` : r.filename === s.supplier_name ? "" : s.supplier_name ? "Invoice number not found" : "Supplier not yet confirmed")}</small></td><td class="amount">${s.invoice_gross_total ? `${esc(s.currency || "")} ${esc(s.invoice_gross_total)}` : "—"}</td><td>${badge(r)}</td><td class="col-date"><small>${esc(date(r.finished_at || r.created_at))}</small></td><td><a class="row-action" href="#invoice/${encodeURIComponent(r.run_id)}">${key === "held" ? "Review invoice" : key === "failed" ? "Resolve issue" : key === "running" || key === "queued" ? "View progress" : "View details"} →</a></td></tr>`;
        })
        .join("")}</tbody></table></div>`
    : `<div class="empty"><h3>${!rows.length ? "Your invoice inbox is ready" : "No invoices here"}</h3><p>${!rows.length ? "Upload your first PDF to get started." : state.search ? "Try another supplier, invoice number or filename." : "Invoices with this status will appear here."}</p>${rows.length ? '<button class="text" data-action="clear-filters">Show all invoices</button>' : ""}</div>`;
}
async function loadSamples() {
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
  const [rv, pos, runs, vendors] = await Promise.all([
    api(`/api/runs/${encodeURIComponent(id)}/review`).catch((e) => {
      if (e.status === 404) return null;
      throw e;
    }),
    api("/api/pos"),
    api("/api/runs"),
    api("/api/vendors"),
  ]);
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
  const fields = rv?.fields ?? {};
  const s = Object.fromEntries(
    Object.entries(fields).map(([name, rec]) => [name, rec.raw_value]),
  );
  const curr = s.currency || rv?.context?.currency?.code || "";
  const child = runs.find((r) => r.parent_run_id === id);
  const postedRelated = runs.find(
    (r) => r.document_id === d.document_id && r.disposition === "approved",
  );
  const canReview = key === "held" && !!rv && !child && !postedRelated;
  const title = noReading
    ? "We couldn’t finish reading this invoice"
    : key === "held"
      ? open.length
        ? "A few details need your review"
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
        ? "Work through the items below, then check the invoice again. Nothing has been approved yet."
        : "This is an earlier result. Open the latest result to continue."
      : key === "approved"
        ? `Added to the approved purchase order balance${d.decision_mode === "automatic_exception" ? " using the permitted budget exception" : ""}. ${d.decision_mode === "reviewer" ? "Approved after review." : "No further action is needed."}`
        : rejectionHelp(dec);
  $("#main").innerHTML =
    `<a href="#invoices" class="back-link">← All invoices</a><div class="page-heading detail-title"><div><h1>${esc(s.supplier_name || d.filename)}</h1><p>${esc(s.invoice_number ? "Invoice #" + s.invoice_number + " · " : "")}${esc(d.filename)} · ${esc(date(d.created_at))}</p></div>${uploadButton("Upload another")}</div>${child ? `<div class="success-message">This invoice has a newer result. <a href="#invoice/${encodeURIComponent(latestDescendant(id))}">Open latest result →</a></div>` : ""}<section class="card outcome ${key}"><div class="outcome-head">${badge(d)}<h2>${title}</h2></div><p>${esc(description)}</p>${Object.keys(fields).length ? `<dl class="invoice-summary"><div><dt>Invoice total</dt><dd>${esc(curr)} ${esc(s.invoice_gross_total || "Not confirmed")}</dd></div><div><dt>Invoice date</dt><dd>${esc(s.invoice_date || "Not confirmed")}</dd></div><div><dt>Purchase order</dt><dd>${esc(s.po_reference || "Not selected")}</dd></div><div><dt>Supplier</dt><dd>${esc(s.supplier_name || "Not confirmed")}</dd></div></dl>` : ""}${noReading ? `<div class="button-row" style="margin-top:16px">${!child ? '<button class="primary" data-action="retry-reading">Try reading again</button>' : ""}<button data-action="upload">Upload a replacement PDF</button></div><div id="retry-error"></div>` : ""}${key === "rejected" ? duplicateLink(d, dec) : ""}</section><div class="review-layout"><div class="review-panel">${canReview ? reviewHTML(rv) : summaryHTML(fields)}<div id="review-notice" role="status"></div></div><section class="card document-panel" aria-label="Invoice document"><div class="document-header"><h2>Original invoice</h2><button class="mobile-document-toggle small" data-action="toggle-preview" aria-expanded="false">Show document</button><div class="page-controls" id="page-controls"></div></div><div class="document-canvas" id="document-canvas"><p>Loading document…</p></div><div class="document-caption" id="document-caption">Compare these details with your invoice.</div></section></div>${detailsHTML(d, dec, rv)}<p class="footer-note">Approval records an amount against a purchase order. This demo does not send payments.</p>`;
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
    return "This supplier is blocked. Contact the person responsible for supplier approval before proceeding outside this workflow.";
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
  const scan =
    rec.read_method === "llm_vision" &&
    rec.status === "selected" &&
    rec.review_status !== "attested";
  const suggestion = problem?.suggestion;
  return `<div class="field-editor" id="field-${esc(name)}"><div class="field-head"><label for="input-${esc(name)}">${esc(FIELD[name] || name)}</label>${rec.evidence?.block_id ? `<button class="text small" data-evidence="${esc(name)}">Find on invoice ↗</button>` : ""}</div>${problem ? `<p>${esc(problemCopy(name, problem))}</p>` : ""}<form data-form="field" data-field="${esc(name)}"><div class="field-entry"><input id="input-${esc(name)}" name="value" value="${esc(rec.raw_value || "")}" data-original="${esc(rec.raw_value || "")}" aria-describedby="hint-${esc(name)}" required autocomplete="off"><button type="submit" class="small" ${!problem ? "disabled" : ""}>${problem ? "Save & confirm" : "Save"}</button></div><small id="hint-${esc(name)}">${esc(EXPECTED[name] || "Match the value shown on the invoice.")}</small>${suggestion ? `<button type="button" class="text suggestion" data-suggestion="${esc(name)}" data-value="${esc(suggestion)}">Use “${esc(suggestion)}”</button>` : ""}${scan ? `<label class="confirm-field"><input type="checkbox" data-attest="${esc(name)}"><span>I checked <b>${esc(rec.raw_value)}</b> against the scanned invoice.</span></label>` : ""}</form></div>`;
}
function taskHTML(number, title, body) {
  return `<section class="task"><div class="task-heading"><span class="step-number">${number}</span><h3>${title}</h3></div>${body}</section>`;
}
function reviewHTML(rv) {
  const items = rv.diagnosis.items;
  const open = items.filter((i) => i.status !== "resolved");
  const fields = rv.fields;
  const problems = rv.diagnosis.field_problems ?? {};
  const poNeedsSelection = open.some((i) => PO_CODES.includes(i.code));
  let n = 0;
  let sections = "";
  const supplierProblem = problems.supplier_name;
  if (supplierProblem) {
    sections += taskHTML(
      ++n,
      "Confirm the supplier",
      editor("supplier_name", fields.supplier_name, supplierProblem) +
        (open.some((i) => i.code === "VENDOR_UNKNOWN")
          ? `<details class="compact-details"><summary>Is this a new supplier?</summary><p style="margin-top:10px">Check that your team has approved this supplier before adding it.</p><form data-form="onboard" class="form-grid"><label>Supplier legal name<input name="name" value="${esc(raw("supplier_name"))}" required></label><button>Add approved supplier</button></form></details>`
          : ""),
    );
  }
  const fieldNames = new Set(
    Object.keys(problems).filter(
      (name) => !["supplier_name", "po_reference"].includes(name),
    ),
  );
  for (const [name, v] of Object.entries(fields))
    if (
      v.read_method === "llm_vision" &&
      v.status === "selected" &&
      v.review_status !== "attested" &&
      name !== "supplier_name" &&
      (name !== "po_reference" || !poNeedsSelection)
    )
      fieldNames.add(name);
  if (fieldNames.size) {
    sections += taskHTML(
      ++n,
      "Check the invoice details",
      `<p>Confirm these values against the document. Save each correction as you go.</p>${[...fieldNames].map((name) => editor(name, fields[name], problems[name])).join("")}${Object.values(fields).some((v) => v.read_method === "llm_vision" && v.status === "selected" && v.review_status !== "attested") ? '<button class="small" data-action="confirm-scan" style="margin-top:16px">Confirm checked values</button>' : ""}`,
    );
  }
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
    sections += taskHTML(
      ++n,
      "Choose the purchase order",
      `<p>${esc(problems.po_reference ? problemCopy("po_reference", problems.po_reference) : "Choose the order this invoice belongs to.")}</p>${
        !rv.diagnosis.vendor_resolved
          ? '<div class="callout">Confirm or add the supplier first. Their purchase orders will appear here.</div>'
          : `<form data-form="pick-po" class="form-grid"><label>Purchase order<select name="po" required><option value="">Choose an order…</option>${candidates
              .map((p) => {
                const live = state.pos.find((x) => x.po_id === p.po_id);
                return `<option value="${esc(p.po_id)}" ${raw("po_reference") === p.po_id ? "selected" : ""}>${esc(p.po_id)} · ${esc(money(p.amount_minor - (live?.consumed_minor || 0), p.currency))} remaining</option>`;
              })
              .join(
                "",
              )}</select></label>${candidates.length ? "<button>Use this purchase order</button>" : "<p>No open purchase order matches this supplier and currency.</p>"}</form><details class="compact-details"><summary>Need to add an authorized purchase order?</summary><p style="margin-top:10px">Use the number and amount approved by procurement. Creating an order does not authorize new spending.</p><form data-form="create-po" class="form-grid two"><label class="full">Purchase order number<input name="po_id" placeholder="PO-1005" value="${esc((raw("po_reference").match(/[A-Z0-9]*PO-[A-Za-z0-9]+/) || [])[0] || "")}" required></label><label>Currency<input name="currency" placeholder="USD" value="${esc(currency || "")}" required></label><label>Authorized amount<input name="amount" inputmode="decimal" placeholder="10000.00" required></label><button class="full">Add & select purchase order</button></form></details>`
      }<details class="compact-details"><summary>Enter the purchase order reference manually</summary>${editor("po_reference", fields.po_reference, null)}</details>`,
    );
  }
  const external = open.filter((i) =>
    [
      "PO_BUDGET_EXCEEDED",
      "DUP_FINGERPRINT",
      "CONTENT_CONFLICT",
      "UNSUPPORTED_DOCUMENT_TYPE",
      "UNSUPPORTED_AMOUNT_STRUCTURE",
      "VENDOR_BLOCKED",
    ].includes(i.code),
  );
  if (external.length) {
    sections += taskHTML(
      ++n,
      "Resolve with your team",
      external
        .map(
          (i) =>
            `<div class="callout"><h3>${esc(LABELS[i.code] || human(i.label))}</h3><p>${esc(externalHelp(i.code))}</p>${["DUP_FINGERPRINT", "CONTENT_CONFLICT"].includes(i.code) ? '<a href="#invoices">Compare invoices in the inbox →</a>' : ""}${i.code === "PO_BUDGET_EXCEEDED" ? '<a href="#pos">View purchase order balances →</a>' : ""}</div>`,
        )
        .join(""),
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
  return `<section class="card"><div class="section-heading"><h2>${n ? "What needs your attention" : "Ready to check again"}</h2><p>${items.filter((i) => i.status === "resolved").length ? `${items.filter((i) => i.status === "resolved").length} of ${items.length} checks resolved · ` : ""}Changes are saved when you confirm each field.</p></div>${sections}<div class="task"><details><summary>View or edit other invoice details</summary>${other.map((name) => editor(name, fields[name], null)).join("")}</details></div><div class="review-footer"><p>When you’re done, check again. The invoice will be approved automatically if all checks pass.</p><button class="primary" data-action="check-again">Check again</button><div id="decision-error"></div>${Object.values(fields).some((v) => v.read_method === "llm_vision" && v.status === "selected" && v.review_status !== "attested") ? '<button class="text" data-action="confirm-scan" style="margin-top:10px">Confirm checked scan values</button>' : ""}<details class="rejection"><summary>Can’t resolve this invoice? Reject it</summary><form data-form="reject"><label>Why should this invoice be rejected?<textarea name="reason" required placeholder="For example: Supplier needs to send a corrected invoice"></textarea></label><button class="danger">Reject invoice</button></form></details></div></section>`;
}
function externalHelp(code) {
  return (
    {
      PO_BUDGET_EXCEEDED:
        "Check that the amount and purchase order are correct. If the invoice is correct, ask procurement to amend the authorized budget in the source system. This demo cannot amend existing orders. Leave it pending, or reject it with a reason.",
      DUP_FINGERPRINT:
        "Another invoice has the same supplier, date and amount. Compare the documents with your team. This app cannot override this duplicate check: leave it pending for investigation, or reject the duplicate.",
      CONTENT_CONFLICT:
        "A different amount is already recorded for this invoice number. Ask your finance team to establish the correct version. This app cannot reverse an approved entry. Keep this pending or reject the incorrect version.",
      UNSUPPORTED_AMOUNT_STRUCTURE:
        "This invoice includes a prepayment or adjustment that this workflow cannot approve. If a value was misread, correct it using the document. Otherwise, handle it through your finance team’s exception process and reject it here with the reason.",
      UNSUPPORTED_DOCUMENT_TYPE:
        "Use your team’s process for credit notes or other document types. Reject this submission here, then upload a standard invoice if needed.",
      VENDOR_BLOCKED:
        "Contact the person responsible for approving suppliers. A blocked supplier cannot be approved through this invoice review.",
    }[code] || "Check the document with your finance team before continuing."
  );
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
    `<div class="pdf-page"><img src="/api/runs/${encodeURIComponent(state.detail.run_id)}/page/${state.page}" alt="Original invoice, page ${state.page}">${overlay}</div>`;
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
    `<details class="card form-card"><summary>${isPO ? "Add an authorized purchase order" : "Add an approved supplier"}</summary><p style="margin-top:10px;font-size:12px">${isPO ? "Enter an existing authorization from procurement." : "Confirm that your team has approved this supplier before adding it here."}</p><form data-form="${isPO ? "master-po" : "master-vendor"}" class="form-grid two">${
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
    }<button class="primary full">${isPO ? "Add purchase order" : "Add supplier"}</button></form></details>` +
    (isPO
      ? `<section class="card"><div class="table-scroll"><table><thead><tr><th>Purchase order</th><th>Supplier</th><th>Approved billing</th><th class="amount">Remaining budget</th><th>Status</th></tr></thead><tbody>${pos.map((p) => `<tr><td><b>${esc(p.po_id)}</b></td><td>${esc(vendors.find((v) => v.supplier_id === p.supplier_id)?.name || p.supplier_id)}</td><td>${esc(money(p.consumed_minor, p.currency))}<small>of ${esc(money(p.amount_minor, p.currency))}</small><div class="budget-track"><span style="width:${Math.max(0, Math.min(100, (p.consumed_minor / Math.max(1, p.amount_minor)) * 100))}%"></span></div></td><td class="amount">${esc(money(p.amount_minor - p.consumed_minor, p.currency))}</td><td><span class="badge ${p.status === "open" ? "approved" : ""}">${esc(p.status === "open" ? "Open" : "Closed")}</span></td></tr>`).join("")}</tbody></table></div>${!pos.length ? '<div class="empty"><p>No purchase orders yet. Add an authorized order to get started.</p></div>' : ""}</section><p class="footer-note">Held and rejected invoices use no budget. Existing purchase orders cannot be amended in this demo.</p>`
      : `<div class="supplier-grid">${vendors.map((v) => `<section class="card supplier-card"><h2 style="font-size:15px">${esc(v.name)}</h2><p>${esc(v.country || "Country not specified")} · ${v.open_pos || 0} open purchase order${v.open_pos === 1 ? "" : "s"}</p><span class="badge ${v.status === "approved" ? "approved" : "rejected"}">${esc(v.status === "approved" ? "Approved supplier" : "Blocked")}</span></section>`).join("")}</div>`);
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
    `<div class="help-content"><section class="card"><h2>Your invoice journey</h2><ol><li><b>Upload a PDF.</b> We read the details and check the supplier, purchase order and amounts.</li><li><b>See the result.</b> Eligible invoices are approved automatically. Invoices that need your help appear under Needs attention.</li><li><b>Resolve the highlighted items.</b> Compare the details with the original, save corrections, and select a purchase order. For scans, confirm the values you’ve checked.</li><li><b>Check again.</b> All rules run again. Passing invoices are approved; anything unresolved gets a next step.</li></ol><h3>What the statuses mean</h3><p><b>Approved:</b> The amount was added to the approved purchase order balance. An exception label means a permitted small budget overage.</p><p><b>Needs review:</b> Nothing was approved. Open the invoice for corrections or next steps.</p><p><b>Rejected:</b> No amount was added. The invoice explains why, including duplicates and blocked suppliers.</p><p><b>Couldn’t process:</b> The document could not be read. Retry an interrupted reading or upload a replacement PDF.</p></section><section class="card"><h2>If you can’t resolve an invoice</h2><p>Keep it pending while you ask your supplier or procurement team for the missing information. Reject it with a reason if it should not proceed.</p><p>The demo can add approved suppliers and authorized purchase orders. It cannot amend an existing purchase order, override a duplicate check, reverse an approval, or send a payment.</p><p>Each invoice keeps its original document, earlier attempts, decision explanation and technical evidence under <b>Decision details & activity</b>.</p></section><section class="card"><h2>Demo settings</h2><p>Reset removes all invoices, reviews and approvals in this demo and restores the example suppliers and purchase orders. This cannot be undone.</p><button class="danger" data-action="reset">Reset demo workspace</button><div id="reset-error"></div></section><a href="#invoices">← Back to invoices</a></div>`;
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
        run_id: state.detail.run_id,
      });
      if (body.name.trim() !== raw("supplier_name"))
        await reviewPost("correct", {
          field: "supplier_name",
          value: body.name.trim(),
          expected_seq: state.review.revision_seq,
        });
      await refreshDetail(["supplier_name"]);
      notice("Supplier added. You can now choose a purchase order.");
    } else if (type === "create-po") {
      await post("/api/pos", {
        ...body,
        supplier_id: state.review.po_supplier_id,
        run_id: state.detail.run_id,
      });
      await reviewPost("correct", {
        field: "po_reference",
        value: body.po_id,
        expected_seq: state.review.revision_seq,
      });
      await refreshDetail(["po_reference"]);
      notice("Purchase order added and selected.");
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
            : "Checks complete. See the updated result.",
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
route();
setInterval(async () => {
  if (state.route !== "invoices" || state.busy) return;
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
