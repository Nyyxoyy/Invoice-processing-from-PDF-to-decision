/* Pure presentation rules shared by both workspaces. Financial decisions stay on the server. */
(function (root) {
  const kinds = {
    VENDOR_UNKNOWN: "onboard_supplier",
    VENDOR_BLOCKED: "unblock_supplier",
    NO_PO_MATCH: "raise_po",
    PO_CLOSED: "raise_po",
    CURRENCY_MISMATCH: "raise_po",
    PO_VENDOR_MISMATCH: "raise_po",
    PO_BUDGET_EXCEEDED: "amend_po",
  };
  function latestRequests(tickets, documentId) {
    const seen = new Set();
    return tickets
      .filter((t) => t.document_id === documentId)
      .filter((t) => {
        if (seen.has(t.kind)) return false;
        seen.add(t.kind);
        return true;
      });
  }
  function workState(run, tickets) {
    const requests = latestRequests(tickets, run.document_id);
    if (run.disposition === "approved")
      return {
        key: "approved",
        label:
          run.decision_mode === "automatic_exception"
            ? "Approved · exception"
            : "Approved",
        action: "View invoice",
      };
    if (["running", "queued"].includes(run.run_status))
      return {
        key: "processing",
        label: "Processing",
        action: "View progress",
      };
    if (run.run_status === "failed")
      return {
        key: "review",
        label: "Couldn’t process",
        action: "Resolve issue",
      };
    if (run.disposition === "rejected" && (run.codes || run.snapshot?.codes || []).includes("UNSUPPORTED_DOCUMENT_TYPE"))
      return { key: "rejected", label: "Rejected", action: "View reason" };
    const open = requests.filter((t) => t.status === "open");
    if (open.length)
      return {
        key: "waiting",
        label: "With procurement",
        action: "View request",
      };
    const replies = requests.filter(
      (t) =>
        t.status !== "open" &&
        (t.resolved_at > (run.finished_at || run.created_at) ||
          t.run_id === run.run_id),
    );
    if (replies.some((t) => t.status === "resolved"))
      return {
        key: "ready",
        label: "Ready to recheck",
        action: "Resume review",
      };
    if (replies.some((t) => t.status === "declined"))
      return { key: "review", label: "Reply received", action: "Read reply" };
    if (run.disposition === "rejected")
      return { key: "rejected", label: "Rejected", action: "View reason" };
    return {
      key: "review",
      label: "Needs your review",
      action: "Review invoice",
    };
  }
  function unrequestedNeeds(items, tickets, runs) {
    return items
      .map((item) => {
        const run = runs.find((r) => r.run_id === item.run_id);
        const open = tickets.filter(
          (t) =>
            t.status === "open" &&
            (run
              ? t.document_id === run.document_id
              : t.run_id === item.run_id),
        );
        return {
          ...item,
          asks: item.asks.filter(
            (a) => !open.some((t) => t.kind === kinds[a.code]),
          ),
        };
      })
      .filter((item) => item.asks.length);
  }
  const api = { latestRequests, workState, unrequestedNeeds };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.InvoiceWorkflow = api;
})(typeof window !== "undefined" ? window : globalThis);
