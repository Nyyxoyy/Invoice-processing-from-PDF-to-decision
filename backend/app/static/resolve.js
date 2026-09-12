/* Decision model for the quick-resolve view.

   Pure and browser-free: turns one review payload (what /api/runs/{id}/review
   returns) plus the registers into an ordered list of DECISIONS, each a short
   list of OPTIONS. Every option maps onto a call the review page already
   makes — correct a field, attest a scan reading, send procurement a request,
   confirm a same-day match as distinct, reject — so nothing financial is
   decided here. Approve still re-runs every rule on the server.

   Two rules the view relies on:
     * "recommended" is set only when deterministic evidence exists (the
       closest approved supplier name, the single order with budget, a currency
       stated elsewhere on the page). An ambiguous date never gets one: both
       readings are legal, which is the whole reason it is a decision.
     * Field rows show verification STATE words, never a per-field score.
       `verified` mirrors FieldRecord.affirmatively_verified in validate.py. */
(function (root) {
  const FIELD_ORDER = [
    "supplier_name", "invoice_number", "invoice_date", "po_reference", "buyer_name",
    "currency", "subtotal_net", "tax_total", "shipping_total", "invoice_gross_total", "amount_due",
  ];
  const REQUIRED = new Set(["supplier_name", "invoice_number", "invoice_date", "currency",
                            "subtotal_net", "tax_total", "invoice_gross_total", "po_reference"]);
  const LABEL = {
    supplier_name: "Supplier", invoice_number: "Invoice no.", invoice_date: "Invoice date",
    po_reference: "Purchase order", buyer_name: "Billed to", currency: "Currency",
    subtotal_net: "Subtotal", tax_total: "Tax", shipping_total: "Shipping",
    invoice_gross_total: "Total", amount_due: "Amount due",
  };
  // pill labels: one or two words
  const STEP = {
    supplier_name: "Supplier", invoice_number: "Invoice no.", invoice_date: "Date",
    po_reference: "PO", buyer_name: "Billed to", currency: "Currency", subtotal_net: "Subtotal",
    tax_total: "Tax", shipping_total: "Shipping", invoice_gross_total: "Total", amount_due: "Amount due",
  };
  const PO_CODES = ["NO_PO_MATCH", "PO_MULTIPLE_REFS", "PO_CLOSED", "PO_VENDOR_MISMATCH",
                    "CURRENCY_MISMATCH", "PO_FUZZY_CANDIDATE"];
  const PO_ASK = {
    PO_CLOSED: "The referenced order is closed. Procurement can reopen it or raise a new one.",
    CURRENCY_MISMATCH: "The invoice currency does not match the referenced order. Procurement has to raise an order in this currency.",
    PO_VENDOR_MISMATCH: "The referenced order belongs to a different supplier.",
  };
  const AMOUNT_FIELDS = ["subtotal_net", "tax_total", "shipping_total", "invoice_gross_total"];

  // ---- verification state (mirror of validate.FieldRecord) -------------------
  function selfVerified(rec) {
    return !!rec && rec.read_method === "llm_vision" && rec.status === "selected"
      && rec.raw_value != null && rec.checks?.normalization === "pass"
      && (rec.checks?.independent_read === "agree" || !!rec.checks?.cross_check);
  }
  function verified(rec) {
    if (!rec || rec.status !== "selected" || rec.raw_value == null) return false;
    if (rec.checks?.normalization === "fail") return false;
    if (rec.review_status === "attested" || rec.review_status === "corrected") return true;
    if (rec.read_method === "llm_vision") return selfVerified(rec);
    return rec.checks?.source_match === "pass"
      && ["pass", "not_evaluated", undefined].includes(rec.checks?.role_check);
  }

  // ---- small helpers -----------------------------------------------------------
  function parseAmount(text) {
    if (text == null) return null;
    let s = String(text).replace(/[^\d.,-]/g, "");
    if (!s || !/\d/.test(s)) return null;
    const dot = s.lastIndexOf("."), comma = s.lastIndexOf(",");
    if (dot > -1 && comma > -1) s = dot > comma ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
    else if (comma > -1) {
      const tail = s.length - comma - 1;
      s = tail > 0 && tail <= 2 ? s.replace(",", ".") : s.replace(/,/g, "");
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  function fmtAmount(n, decimals) {
    return (Math.round(n * 10 ** decimals) / 10 ** decimals).toFixed(decimals);
  }
  function fmtGrouped(n, decimals) {
    return Number(fmtAmount(n, decimals)).toLocaleString("en-US",
      { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  function tokens(s) {
    return String(s || "").split(/[^a-z0-9]+/i).filter(Boolean);
  }
  function bigrams(s) {
    const t = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const out = new Map();
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  }
  function similarity(a, b) {
    const x = bigrams(a), y = bigrams(b);
    if (!x.size || !y.size) return 0;
    let shared = 0;
    for (const [g, n] of x) shared += Math.min(n, y.get(g) || 0);
    let total = 0;
    for (const n of x.values()) total += n;
    for (const n of y.values()) total += n;
    return (2 * shared) / total;
  }
  function nameDiff(printed, canonical) {
    const a = tokens(printed), b = tokens(canonical);
    const al = a.map((t) => t.toLowerCase()), bl = b.map((t) => t.toLowerCase());
    const extraB = b.filter((t, i) => !al.includes(bl[i]));
    const extraA = a.filter((t, i) => !bl.includes(al[i]));
    if (a.length && !extraA.length && extraB.length) return `name differs only by “${extraB.join(" ")}”`;
    if (b.length && !extraB.length && extraA.length) return `printed name adds “${extraA.join(" ")}”`;
    return `${Math.round(similarity(printed, canonical) * 100)}% name similarity`;
  }
  // a suggestion reason that rests on a record, not on a second legal reading
  function evidenced(reason) {
    return /purchase order|document|supplier|as read|closest/i.test(reason || "");
  }
  function currencyOf(review) {
    const rec = review.fields?.currency;
    const typed = String(rec?.raw_value || "").trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(typed)) return typed;
    return review.context?.currency?.code || "";
  }
  function oneRecommended(options) {
    let seen = false;
    for (const o of options) {
      if (o.recommended && seen) o.recommended = false;
      if (o.recommended) seen = true;
    }
    return options;
  }

  // ---- decision builders ---------------------------------------------------------
  function supplierDecision(S) {
    const printed = S.raw("supplier_name").trim();
    const p = S.problems.supplier_name || {};
    const approved = (S.vendors || []).filter((v) => v.status === "approved")
      .slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const suggested = approved.find((v) => v.name === p.suggestion) || null;
    const waiting = S.openTickets.has("onboard_supplier");
    const options = [];
    if (suggested) {
      const n = suggested.invoices || 0;
      options.push({
        id: "supplier:map:" + suggested.supplier_id, label: suggested.name,
        detail: ["Approved supplier", suggested.country || null, `${n} prior invoice${n === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
        recommended: true,
        action: { type: "correct", field: "supplier_name", value: suggested.name },
      });
    }
    const others = approved.filter((v) => v !== suggested);
    if (others.length)
      options.push({
        id: "supplier:other", label: "Another approved supplier",
        detail: "A subsidiary, brand or trading name of a supplier already in the register.",
        select: { field: "supplier_name", placeholder: "Choose a supplier…",
                  choices: others.map((v) => ({ value: v.name,
                    label: v.name + (v.aliases?.length ? ` · also ${v.aliases.slice(0, 2).join(", ")}` : "") })) },
        action: { type: "correct", field: "supplier_name" },
      });
    if (!waiting)
      options.push({
        id: "supplier:new", label: "Create new supplier",
        detail: "Starts supplier onboarding with procurement · blocks approval until they approve it.",
        action: { type: "ticket", kind: "onboard_supplier",
                  note: `Please onboard "${printed || "the supplier on this invoice"}" and provide its purchase order.` },
      });
    let evidence = null;
    if (suggested) {
      const n = suggested.invoices || 0;
      evidence = [nameDiff(printed, suggested.name),
                  suggested.country ? `registered in ${suggested.country}` : null,
                  `${n} prior invoice${n === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
    } else if (printed) evidence = `“${printed}” matches no approved supplier by name or alias.`;
    return {
      key: "supplier", step: "Supplier", title: LABEL.supplier_name, value: printed,
      fields: ["supplier_name"],
      why: printed
        ? `“${printed}” is not an exact match in the supplier register.${suggested ? " One approved supplier is close." : ""}`
        : "No supplier name could be read from the document.",
      evidence, status: waiting ? "waiting" : "open", blockedBy: null,
      waitingOn: waiting ? "onboard_supplier" : null, options: oneRecommended(options),
    };
  }

  function fieldDecision(name, S, opts = {}) {
    const rec = S.fields[name];
    const p = S.problems[name] || {};
    const suggestions = p.suggestions?.length ? p.suggestions
      : p.suggestion ? [{ value: p.suggestion, reason: "" }] : [];
    const options = suggestions.map((s, i) => ({
      id: `${name}:${i}`, label: String(s.value), detail: s.reason || "",
      recommended: evidenced(s.reason),
      action: { type: "correct", field: name, value: String(s.value) },
    }));
    oneRecommended(options);
    options.push({
      id: `${name}:type`, label: rec?.raw_value ? "Type the correct value" : "Type the value from the invoice",
      detail: S.expected?.[name] || "",
      inputs: [{ field: name, value: rec?.raw_value || "" }],
      action: { type: "correct", field: name },
    });
    if (opts.rejectReason)
      options.push({ id: `${name}:reject`, label: opts.rejectLabel || "Reject the invoice",
                     detail: opts.rejectDetail || "", action: { type: "reject", reason: opts.rejectReason } });
    return {
      key: `field:${name}`, step: STEP[name] || name, title: LABEL[name] || name,
      value: rec?.raw_value || "", fields: [name],
      why: (S.problemCopy ? S.problemCopy(name, p) : null) || p.why || `${LABEL[name] || name} needs confirming.`,
      evidence: null, status: "open", blockedBy: null, waitingOn: null, options,
    };
  }

  function scanDecision(name, S) {
    const rec = S.fields[name];
    const rawv = rec?.raw_value || "";
    return {
      key: `scan:${name}`, step: STEP[name] || name, title: LABEL[name] || name, value: rawv,
      fields: [name],
      why: "Read from a scanned image. Compare it with the highlighted area on the page.",
      evidence: null, status: "open", blockedBy: null, waitingOn: null,
      options: [
        { id: `scan:${name}:ok`, label: `Confirm as read: ${rawv}`,
          detail: "Records that you checked this value against the page.", recommended: true,
          action: { type: "attest", fields: [name] } },
        { id: `scan:${name}:type`, label: "Type the correct value", detail: S.expected?.[name] || "",
          inputs: [{ field: name, value: rawv }], action: { type: "correct", field: name } },
      ],
    };
  }

  function poDecision(S) {
    const review = S.review;
    const vendorResolved = !!review.diagnosis?.vendor_resolved;
    const printed = S.raw("po_reference").trim();
    const refs = review.context?.po_references || [];
    const currency = S.currency;
    const cands = (review.po_candidates || []).filter((c) => !currency || c.currency === currency);
    const code = PO_CODES.find((c) => S.openCodes.has(c));
    const p = S.problems.po_reference || {};
    const waiting = S.openTickets.has("raise_po");
    if (!vendorResolved)
      return {
        key: "po", step: "PO", title: LABEL.po_reference, value: printed, fields: ["po_reference"],
        why: "Confirm the supplier first — its purchase orders appear here once it is resolved.",
        evidence: null, status: "blocked", blockedBy: "supplier", waitingOn: null, options: [],
      };
    const fitting = cands.filter((c) => c.status !== "exceeded");
    const mentioned = cands.filter((c) => refs.includes(c.po_id) || c.po_id === printed);
    let rec = null, evidence = null;
    if (mentioned.length === 1 && mentioned[0].status !== "exceeded") {
      rec = mentioned[0];
      evidence = `${rec.po_id} is the only order named on the invoice, and it has budget for this amount.`;
    } else if (fitting.length === 1 && cands.length >= 1) {
      rec = fitting[0];
      evidence = `${rec.po_id} is the only open ${currency || ""} order with budget for this invoice.`.replace("  ", " ");
    }
    const options = cands.map((c) => {
      const remaining = c.remaining_minor ?? c.amount_minor;
      const flag = c.status === "exceeded" ? " · not enough for this invoice"
        : c.status === "exception" ? " · within the permitted exception" : "";
      return { id: "po:" + c.po_id, label: c.po_id,
               detail: `${S.money(remaining, c.currency)} remaining${flag}`, recommended: c === rec,
               action: { type: "correct", field: "po_reference", value: c.po_id } };
    });
    options.push({ id: "po:type", label: "Enter the order number",
                   detail: "If the order exists under a reference not listed here.",
                   inputs: [{ field: "po_reference", value: printed }],
                   action: { type: "correct", field: "po_reference" } });
    if (!waiting)
      options.push({
        id: "po:raise", label: "Ask procurement to raise an order",
        detail: PO_ASK[code] || (cands.length
          ? "If none of these orders is the one this invoice bills against."
          : `No open ${currency || ""} order exists for this supplier.`.replace("  ", " ")),
        action: { type: "ticket", kind: "raise_po",
                  note: `Please raise or identify the purchase order for ${S.raw("supplier_name").trim() || "this supplier"}`
                        + ` (invoice reference: ${printed || "none printed"}).` },
      });
    return {
      key: "po", step: "PO", title: LABEL.po_reference, value: printed, fields: ["po_reference"],
      // the item-level explanation ("mentions several purchase orders") over the
      // field's unusable-value wording, which describes a single-reference format
      why: p.why || (S.problemCopy ? S.problemCopy("po_reference", p) : null) || "Choose the order this invoice bills against.",
      evidence, status: waiting ? "waiting" : "open", blockedBy: null,
      waitingOn: waiting ? "raise_po" : null, options: oneRecommended(options),
    };
  }

  function amountsDecision(S) {
    const dec = S.decimals(S.currency);
    const present = AMOUNT_FIELDS.filter((f) => S.fields[f]);
    const val = (f) => parseAmount(S.raw(f));
    const sub = val("subtotal_net"), tax = val("tax_total"), gross = val("invoice_gross_total");
    // shipping only enters the arithmetic (and the wording) when the document states one
    const shipVal = S.fields.shipping_total ? val("shipping_total") : null;
    const ship = shipVal ?? 0;
    const withShip = (s) => (shipVal != null ? s : "");
    const fixes = [];
    if (sub != null && gross != null) fixes.push({ field: "tax_total", value: gross - sub - ship, formula: `total − subtotal${withShip(" − shipping")}` });
    if (sub != null && tax != null) fixes.push({ field: "invoice_gross_total", value: sub + tax + ship, formula: `subtotal + tax${withShip(" + shipping")}` });
    if (gross != null && tax != null) fixes.push({ field: "subtotal_net", value: gross - tax - ship, formula: `total − tax${withShip(" − shipping")}` });
    const usable = fixes.filter((f) => f.value >= 0 && S.fields[f.field]
      && fmtAmount(f.value, dec) !== fmtAmount(val(f.field) ?? NaN, dec));
    // "printed on the page" means the whole number appears as its own token —
    // 200.00 inside "$1,200.00" is not evidence that 200.00 was printed
    const page = String(S.pageText || "");
    const printedOn = (n) => [fmtAmount(n, dec), fmtGrouped(n, dec)].some((txt) =>
      new RegExp(`(^|[^\\d.,])${txt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d])`).test(page));
    const printed = usable.filter((f) => page && printedOn(f.value));
    const rec = printed.length === 1 ? printed[0] : null;
    const options = usable.map((f) => ({
      id: "amounts:" + f.field, label: `${LABEL[f.field]} → ${fmtAmount(f.value, dec)}`,
      detail: `= ${f.formula}; the other amounts stay as printed.`, recommended: f === rec,
      action: { type: "correct", field: f.field, value: fmtAmount(f.value, dec) },
    }));
    options.push({
      id: "amounts:type", label: "Type the amounts as printed", detail: "Correct more than one value at once.",
      inputs: present.map((f) => ({ field: f, value: S.raw(f) })),
      action: { type: "correct-many" },
    });
    options.push({
      id: "amounts:reject", label: "The invoice itself does not add up",
      detail: "Reject and ask the supplier for a corrected invoice.",
      action: { type: "reject", reason: `Invoice amounts do not reconcile (subtotal ${S.raw("subtotal_net") || "—"}, `
        + `tax ${S.raw("tax_total") || "—"}, total ${S.raw("invoice_gross_total") || "—"}). Please send a corrected invoice.` },
    });
    const p = S.problems.invoice_gross_total || S.problems.tax_total || S.problems.subtotal_net || {};
    return {
      key: "amounts", step: "Amounts", title: "Amounts", value: S.raw("invoice_gross_total"),
      fields: present,
      why: p.why || "The subtotal, tax and total on the document do not add up.",
      evidence: rec ? `${fmtAmount(rec.value, dec)} is printed on the page — the ${LABEL[rec.field].toLowerCase()} was misread.` : null,
      status: "open", blockedBy: null, waitingOn: null, options,
    };
  }

  function dupDecision(S) {
    return {
      key: "dup", step: "Duplicate", title: "Possible duplicate", value: "", fields: [],
      why: "Another invoice from this supplier has the same amount and date. Compare them before deciding.",
      evidence: null, status: "open", blockedBy: null, waitingOn: null,
      options: [
        { id: "dup:distinct", label: "This is a separate invoice",
          detail: "Say why — it goes on the audit trail. The next check runs the remaining rules.",
          note: { placeholder: "For example: two deliveries the same day; invoice numbers differ; both on the delivery notes" },
          action: { type: "confirm-distinct" } },
        { id: "dup:reject", label: "It is the same invoice", detail: "Reject this submission; the earlier one stands.",
          action: { type: "reject", reason: "Duplicate of an invoice already submitted (same supplier, amount and date)." } },
      ],
    };
  }

  function budgetDecision(S) {
    const b = S.review.budget || {};
    const waiting = S.openTickets.has("amend_po");
    const numbers = b.po_id && b.gross_minor != null
      ? `${b.po_id} has ${S.money(b.remaining_minor, b.currency)} left; this invoice is ${S.money(b.gross_minor, b.currency)}`
        + (b.short_minor ? `, ${S.money(b.short_minor, b.currency)} more than the permitted overage.` : ".")
      : "Approving this invoice would exceed the authorized amount on its purchase order.";
    const options = [];
    if (!waiting)
      options.push({ id: "budget:amend", label: "Ask procurement to raise the order budget",
                     detail: "If the spend is authorized.",
                     action: { type: "ticket", kind: "amend_po", note: `Please amend ${b.po_id || "the purchase order"}: ${numbers}` } });
    options.push({ id: "budget:reject", label: "Reject — ask the supplier for a corrected invoice",
                   detail: "If the invoice itself is wrong.",
                   action: { type: "reject", reason: `Invoice exceeds the purchase order budget. ${numbers} Please issue a corrected invoice or reference the right order.` } });
    return {
      key: "budget", step: "Budget", title: "Purchase order budget", value: b.po_id || "", fields: [],
      why: numbers, evidence: null, status: waiting ? "waiting" : "open", blockedBy: null,
      waitingOn: waiting ? "amend_po" : null, options,
    };
  }

  function codeDecision(item, S) {
    return {
      key: "code:" + item.code, step: item.code.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()).slice(0, 14),
      title: item.label || item.code, value: "", fields: item.fields || [],
      why: item.action || "This needs a human decision.", evidence: null, status: "open", blockedBy: null, waitingOn: null,
      options: [{ id: `code:${item.code}:reject`, label: "Reject the invoice", detail: "Recorded with the reason on the audit trail.",
                  action: { type: "reject", reason: item.label || item.code } }],
    };
  }

  // ---- entry points ------------------------------------------------------------------
  function buildDecisions(review, ctx = {}) {
    const fields = review.fields || {};
    const diag = review.diagnosis || {};
    const items = (diag.items || []).filter((i) => i.status !== "resolved");
    const openCodes = new Set(items.map((i) => i.code));
    const S = {
      review, fields, problems: diag.field_problems || {}, openCodes,
      vendors: ctx.vendors || [], openTickets: new Set(ctx.openTickets || []),
      money: ctx.money || ((m, c) => `${c || ""} ${(m / 100).toFixed(2)}`.trim()),
      decimals: ctx.decimals || (() => 2), pageText: ctx.pageText || "",
      expected: ctx.expected || {}, problemCopy: ctx.problemCopy || null,
      currency: currencyOf(review),
      raw: (n) => String(fields[n]?.raw_value ?? ""),
    };
    const out = [];
    const covered = new Set();
    const push = (d) => { out.push(d); d.fields.forEach((f) => covered.add(f)); };

    if (openCodes.has("VENDOR_UNKNOWN")) push(supplierDecision(S));
    if (openCodes.has("AMBIGUOUS_CURRENCY")) push(fieldDecision("currency", S));
    if (openCodes.has("AMBIGUOUS_DATE")) push(fieldDecision("invoice_date", S));
    if (PO_CODES.some((c) => openCodes.has(c))) push(poDecision(S));
    if (openCodes.has("MATH_MISMATCH")) push(amountsDecision(S));
    if (openCodes.has("UNSUPPORTED_AMOUNT_STRUCTURE") && !covered.has("amount_due"))
      push(fieldDecision("amount_due", S, {
        rejectLabel: "Prepayment or adjustment — reject",
        rejectDetail: "This workflow never auto-approves an amount due that differs from the total.",
        rejectReason: "Amount due differs from the invoice total (prepayment or adjustment). Needs manual handling.",
      }));
    for (const item of items.filter((i) => i.code === "REVIEW_REQUIRED_SCAN"))
      for (const f of item.fields || [])
        if (!covered.has(f) && fields[f]) push(fields[f].attestable ? scanDecision(f, S) : fieldDecision(f, S));
    for (const item of items.filter((i) => i.code === "MISSING_FIELD" || i.code === "UNVERIFIED_FIELD"))
      for (const f of item.fields || [])
        if (!covered.has(f) && f !== "po_reference" && f !== "currency") push(fieldDecision(f, S));
    if (openCodes.has("DUP_FINGERPRINT")) push(dupDecision(S));
    if (openCodes.has("PO_BUDGET_EXCEEDED") || review.budget?.status === "exceeded") push(budgetDecision(S));
    const handled = new Set(["VENDOR_UNKNOWN", "AMBIGUOUS_CURRENCY", "AMBIGUOUS_DATE", ...PO_CODES, "MATH_MISMATCH",
      "UNSUPPORTED_AMOUNT_STRUCTURE", "REVIEW_REQUIRED_SCAN", "MISSING_FIELD", "UNVERIFIED_FIELD",
      "DUP_FINGERPRINT", "PO_BUDGET_EXCEEDED"]);
    for (const item of items) if (!handled.has(item.code)) push(codeDecision(item, S));
    return out;
  }

  function fieldState(name, rec, decisions) {
    const d = decisions.find((x) => x.fields.includes(name));
    if (d) {
      if (d.status === "blocked") return { icon: "wait", text: `Waits on ${(d.blockedBy || "").replace(/^\w/, (c) => c.toUpperCase()).toLowerCase()}`, decision: d.key };
      if (d.status === "waiting") return { icon: "wait", text: "With procurement", decision: d.key };
      return { icon: "warn", text: d.key === "amounts" ? "Doesn’t add up" : "Needs decision", decision: d.key };
    }
    if (!rec || rec.status === "missing" || rec.raw_value == null || rec.raw_value === "")
      return { icon: "none", text: REQUIRED.has(name) ? "Not found" : "Not on document", decision: null };
    if (rec.review_status === "attested" || rec.review_status === "corrected")
      return { icon: "ok", text: "Confirmed by you", decision: null };
    if (verified(rec)) return { icon: "ok", text: rec.read_method === "llm_vision" ? "Verified by cross-check" : "Verified", decision: null };
    return { icon: "dot", text: "Unverified", decision: null };
  }

  // Rows: every required field (even when nothing was read), plus optional ones
  // that carry a value or a decision. An optional field the document simply
  // does not have (no shipping line) is not a problem and is not shown.
  function fieldStates(review, decisions) {
    const fields = review.fields || {};
    const decided = new Set(decisions.flatMap((d) => d.fields));
    return FIELD_ORDER
      .filter((n) => REQUIRED.has(n) || decided.has(n)
        || (fields[n] && fields[n].status !== "missing" && fields[n].raw_value != null && fields[n].raw_value !== ""))
      .map((n) => ({ name: n, label: LABEL[n] || n,
                     value: review.display?.[n] || fields[n]?.raw_value || "",
                     ...fieldState(n, fields[n], decisions) }));
  }

  const api = { buildDecisions, fieldStates, fieldState, verified, parseAmount, nameDiff, similarity,
                FIELD_ORDER, LABEL, STEP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.InvoiceResolve = api;
})(typeof window !== "undefined" ? window : globalThis);
