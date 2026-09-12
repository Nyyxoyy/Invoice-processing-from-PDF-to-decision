"""Evidence-based confidence and automatic procurement handoffs.

Scores are transparent workflow indicators, not calibrated model probabilities.
They never override the financial decision engine.
"""
import json

from .validate import REQUIRED_FIELDS, reconcile
from .normalize import extract_name, extract_po_refs, extract_currency


def confidence_for_run(conn, run_id):
    from .review import load_latest, ReviewError
    from .pipeline import resolve_vendor
    run = conn.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
    try:
        _, fields, context = load_latest(conn, run_id)
    except ReviewError:
        return {'score': None, 'band': 'unavailable', 'reasons': ['No completed extraction available.']}
    verified = sum(bool(fields.get(f) and fields[f].affirmatively_verified()) for f in REQUIRED_FIELDS)
    supplier = fields.get('supplier_name')
    vendor = resolve_vendor(conn, extract_name(supplier.raw_value) if supplier else None)
    po = fields.get('po_reference')
    refs = extract_po_refs(po.raw_value if po else None) if po and po.review_status == 'corrected' else context.get('po_references') or extract_po_refs(po.raw_value if po else None)
    if po and po.raw_value and conn.execute('SELECT 1 FROM pos WHERE po_id=?', (po.raw_value.strip(),)).fetchone() and len(refs) <= 1:
        refs = [po.raw_value.strip()]
    currency_rec = fields.get('currency')
    currency = (extract_currency(currency_rec.raw_value) if currency_rec else None) or (context.get('currency') or {}).get('code')
    matched = conn.execute('SELECT * FROM pos WHERE po_id=?', (refs[0],)).fetchone() if len(refs) == 1 else None
    supplier_ok = bool(vendor and vendor['status'] == 'approved' and supplier.affirmatively_verified())
    po_ok = bool(matched and supplier_ok and matched['supplier_id'] == vendor['supplier_id']
                 and matched['status'] == 'open' and matched['currency'] == currency)
    math_ok = reconcile(fields, currency)['ok'] is True
    score = round(40 * verified / len(REQUIRED_FIELDS)) + 20 * supplier_ok + 25 * po_ok + 10 * math_ok + 5 * bool(currency)
    reasons = [f'{verified}/{len(REQUIRED_FIELDS)} required fields verified',
               'Supplier matched' if supplier_ok else 'Supplier missing, blocked or unverified',
               'Purchase order matched' if po_ok else 'Purchase order missing or does not match',
               'Totals reconcile' if math_ok else 'Totals need review']
    # A critical uncertainty can never be hidden by a high aggregate score.
    if verified < len(REQUIRED_FIELDS) or not currency or not math_ok:
        score = min(score, 69)
    elif not supplier_ok or not po_ok:
        score = min(score, 84)
    return {'score': score, 'band': 'high' if score >= 90 else 'medium' if score >= 70 else 'low',
            'reasons': reasons, 'supplier_match': supplier_ok, 'po_match': po_ok,
            'method': 'evidence-v1', 'scored_at': run['finished_at']}


def finish_automation(conn, result, policy=None):
    from .review import load_latest, open_ticket, ReviewError
    from .pipeline import resolve_vendor
    from .ledger import _emit
    confidence = confidence_for_run(conn, result.run_id)
    _emit(conn, result.run_id, 'DECIDE', 'confidence_assessed', confidence)
    from . import settings
    rejected = reject_low_confidence_non_invoice(conn, result.run_id, policy or settings.current_policy(), confidence)
    if rejected is not None:
        return rejected
    # Only a held invoice is waiting on procurement. This is also what makes the
    # "Unknown suppliers" switch work end to end: under `reject` an absent
    # supplier ends the run as REJECT, so no onboarding request is raised; under
    # `ticket` it holds and falls through to the handoff below.
    if result.decision.route.value != 'HOLD_REVIEW':
        return result
    try:
        _, fields, context = load_latest(conn, result.run_id)
    except ReviewError:
        return result
    supplier = fields.get('supplier_name')
    # An unreadable name is uncertainty, not evidence that a supplier is absent.
    if not supplier or not supplier.affirmatively_verified():
        return result
    name = extract_name(supplier.raw_value)
    vendor = resolve_vendor(conn, name)
    po = fields.get('po_reference')
    refs = context.get('po_references') or extract_po_refs(po.raw_value if po else None)
    kind = None
    if vendor is None:
        kind = 'onboard_supplier'
        reason = 'The extracted supplier is absent from the supplier register. Onboard the supplier and provide its purchase order.'
    elif vendor['status'] == 'approved' and len(refs) <= 1:
        exists = conn.execute('SELECT 1 FROM pos WHERE po_id=?', (refs[0],)).fetchone() if refs else None
        if not exists and (not po or po.status == 'missing' or po.affirmatively_verified()):
            kind = 'raise_po'
            reason = 'The invoice purchase order is absent from the order register.' if refs else 'No purchase order reference was found on the invoice. Identify or raise the correct order.'
    if kind:
        summary = {f: r.raw_value for f, r in fields.items() if r.raw_value}
        note = f"Automatically raised by Invoice AI. {reason}\nExtracted invoice details: " + json.dumps(summary, ensure_ascii=False)
        open_ticket(conn, result.run_id, kind, note, 'invoice-ai')
    return result


def saved_confidence(conn, run_id):
    row = conn.execute("SELECT payload FROM run_events WHERE run_id=? AND event_type='confidence_assessed' ORDER BY seq DESC LIMIT 1", (run_id,)).fetchone()
    return json.loads(row['payload']) if row else confidence_for_run(conn, run_id)


NON_INVOICE_REJECT_THRESHOLD = 10


def non_invoice_flag(conn, run_id):
    """Keep the original classification through retry/review descendants.

    An explicit retry changes invoice_like to True, but must not erase the
    evidence that led to the original rejection. Unknown scans and bundles of
    real invoices are not evidence that a file is a non-invoice.
    """
    rows = conn.execute('''WITH RECURSIVE lineage(run_id, parent_run_id) AS (
        SELECT run_id, parent_run_id FROM runs WHERE run_id=?
        UNION
        SELECT r.run_id, r.parent_run_id FROM runs r JOIN lineage l ON r.run_id=l.parent_run_id
    ) SELECT e.payload FROM run_events e JOIN lineage l USING(run_id)
      WHERE e.event_type='document_type' ORDER BY e.seq DESC''', (run_id,)).fetchall()
    for row in rows:
        verdict = json.loads(row['payload'])
        if verdict.get('kind') not in ('unknown', 'invoice', 'bundle', None) and (
                verdict.get('invoice_like') is False or verdict.get('forced')):
            return verdict
    return None


def reject_low_confidence_non_invoice(conn, run_id, policy, confidence=None):
    """Reject only completed, unposted holds with BOTH classification and score.

    Returns a new decision result or None. Used for new reads, reviewer
    rechecks, and an idempotent startup reconciliation of older held results.
    """
    from .pipeline import _finalize_no_identity
    from .rules import ResolverInput
    from .ledger import _emit
    from .review import close_requests_for_final_invoice
    run = conn.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
    if not run or run['run_status'] != 'completed' or run['disposition'] != 'held':
        return None
    if conn.execute("SELECT 1 FROM ledger_events WHERE run_id=? AND kind='posting'", (run_id,)).fetchone():
        return None
    verdict = non_invoice_flag(conn, run_id)
    if verdict is None:
        return None
    confidence = confidence if confidence is not None else confidence_for_run(conn, run_id)
    score = confidence.get('score')
    if score is None or not 0 <= score < NON_INVOICE_REJECT_THRESHOLD:
        return None
    _emit(conn, run_id, 'DECIDE', 'document_type', {
        **verdict, 'invoice_like': False, 'forced': False, 'automatic_rejection': True,
        'reasons': [f'This file was flagged as not an invoice and scored {score}/100, below the 10-point threshold.',
                    'It was rejected automatically. No review or procurement action is required.']})
    result = _finalize_no_identity(conn, run_id, ResolverInput(document_type_supported=False), policy)
    _emit(conn, run_id, 'DECIDE', 'non_invoice_auto_rejected', {
        'actor': 'invoice-ai', 'score': score, 'threshold': NON_INVOICE_REJECT_THRESHOLD,
        'classification': verdict['kind'], 'previous_disposition': 'held',
        'reason': f'Flagged as not an invoice with confidence {score}/100, below 10. No review is required.'})
    _emit(conn, run_id, 'DECIDE', 'confidence_assessed', confidence)
    close_requests_for_final_invoice(conn, run_id, 'invoice-ai', 'rejected')
    return result


def reconcile_non_invoice_holds(conn, policy):
    """Apply the rule to latest saved results without rereading PDFs or models."""
    rows = conn.execute("""SELECT r.run_id FROM runs r
        WHERE r.run_status='completed' AND r.disposition='held'
        AND NOT EXISTS (SELECT 1 FROM runs child WHERE child.parent_run_id=r.run_id)""").fetchall()
    return [r['run_id'] for r in rows if reject_low_confidence_non_invoice(conn, r['run_id'], policy)]
