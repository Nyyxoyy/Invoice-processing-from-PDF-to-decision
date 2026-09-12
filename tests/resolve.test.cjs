const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../backend/app/static/resolve.js');

// ---- fixtures ---------------------------------------------------------------------
const rec = (o = {}) => ({ field: 'x', status: 'selected', raw_value: 'v', read_method: 'llm_text',
  evidence: { block_id: 'b1' }, checks: { source_match: 'pass', role_check: 'pass', normalization: 'pass' },
  review_status: 'not_reviewed', attestable: false, ...o });
const item = (code, extra = {}) => ({ code, status: 'open', label: code, action: '', target: null, fields: [], ...extra });
const review = (o = {}) => ({ revision_seq: 1, fields: {}, context: { currency: { code: 'USD' }, po_references: [] },
  po_candidates: [], budget: null, display: {},
  diagnosis: { items: [], field_problems: {}, open_codes: [], vendor_resolved: true }, ...o });
const vendors = [
  { supplier_id: 'v1', name: 'Cedar Cloud Services Ltd', status: 'approved', country: 'GB', invoices: 14, aliases: [] },
  { supplier_id: 'v2', name: 'Northwind Supplies LLC', status: 'approved', country: 'US', invoices: 3, aliases: ['northwind'] },
  { supplier_id: 'v3', name: 'Shady Imports Co', status: 'blocked', country: 'US', invoices: 0, aliases: [] },
];
const build = (rv, ctx = {}) => R.buildDecisions(rv, { vendors, ...ctx });

// ---- supplier ---------------------------------------------------------------------
test('a close approved name is the recommended mapping, with the difference as evidence', () => {
  const rv = review({
    fields: { supplier_name: rec({ raw_value: 'Cedar Cloud Services', checks: {} }) },
    diagnosis: { items: [item('VENDOR_UNKNOWN', { fields: ['supplier_name'] })], vendor_resolved: false,
      field_problems: { supplier_name: { why: 'not in the vendor master', codes: ['VENDOR_UNKNOWN'], suggestion: 'Cedar Cloud Services Ltd' } } },
  });
  const [d] = build(rv);
  assert.equal(d.key, 'supplier');
  assert.equal(d.status, 'open');
  const recd = d.options.filter((o) => o.recommended);
  assert.equal(recd.length, 1);
  assert.deepEqual(recd[0].action, { type: 'correct', field: 'supplier_name', value: 'Cedar Cloud Services Ltd' });
  assert.match(d.evidence, /differs only by “Ltd”/);
  assert.match(d.evidence, /14 prior invoices/);
  const create = d.options.find((o) => o.id === 'supplier:new');
  assert.equal(create.action.type, 'ticket');
  assert.equal(create.action.kind, 'onboard_supplier');
  // the blocked supplier is never offered
  const other = d.options.find((o) => o.id === 'supplier:other');
  assert.ok(other.select.choices.every((c) => c.value !== 'Shady Imports Co'));
});

test('an open onboarding request makes the supplier decision "waiting" and hides "create new"', () => {
  const rv = review({
    fields: { supplier_name: rec({ raw_value: 'Summit Studio', checks: {} }) },
    diagnosis: { items: [item('VENDOR_UNKNOWN')], vendor_resolved: false, field_problems: { supplier_name: { why: '', codes: ['VENDOR_UNKNOWN'] } } },
  });
  const [d] = build(rv, { openTickets: ['onboard_supplier'] });
  assert.equal(d.status, 'waiting');
  assert.equal(d.waitingOn, 'onboard_supplier');
  assert.ok(!d.options.some((o) => o.id === 'supplier:new'));
  assert.ok(d.options.some((o) => o.id === 'supplier:other'), 'mapping to an existing supplier stays possible');
});

// ---- ambiguous values ----------------------------------------------------------------
test('an ambiguous date offers both readings and recommends neither', () => {
  const rv = review({
    fields: { invoice_date: rec({ raw_value: '04/05/2026' }) },
    diagnosis: { items: [item('AMBIGUOUS_DATE', { fields: ['invoice_date'] })], vendor_resolved: true,
      field_problems: { invoice_date: { why: '"04/05/2026" reads two ways.', codes: ['AMBIGUOUS_DATE'],
        suggestions: [{ value: '2026-05-04', reason: 'if the day comes first (4 May)' }, { value: '2026-04-05', reason: 'if the month comes first (5 April)' }] } } },
  });
  const [d] = build(rv);
  assert.equal(d.key, 'field:invoice_date');
  assert.equal(d.step, 'Date');
  assert.equal(d.options.filter((o) => o.recommended).length, 0);
  assert.deepEqual(d.options.map((o) => o.action.value ?? null), ['2026-05-04', '2026-04-05', null]);
  assert.ok(d.options.at(-1).inputs, 'typing the value is always possible');
});

test('a currency implied by the purchase order is recommended over a bare symbol reading', () => {
  const rv = review({
    fields: { currency: rec({ raw_value: '$', checks: { normalization: 'fail' } }) },
    diagnosis: { items: [item('AMBIGUOUS_CURRENCY', { fields: ['currency'] })], vendor_resolved: true,
      field_problems: { currency: { why: '', codes: ['AMBIGUOUS_CURRENCY'],
        suggestions: [{ value: 'USD', reason: 'purchase order PO-1001 is in USD' }, { value: 'CAD', reason: 'one of the currencies that use the $ symbol' }] } } },
  });
  const [d] = build(rv);
  const recd = d.options.filter((o) => o.recommended);
  assert.equal(recd.length, 1);
  assert.equal(recd[0].action.value, 'USD');
});

// ---- purchase order --------------------------------------------------------------------
test('the purchase order waits on the supplier while the supplier is unresolved', () => {
  const rv = review({
    fields: { supplier_name: rec({ raw_value: 'Nobody Inc', checks: {} }), po_reference: rec({ raw_value: 'PO-9' }) },
    diagnosis: { items: [item('VENDOR_UNKNOWN'), item('NO_PO_MATCH', { fields: ['po_reference'] })], vendor_resolved: false,
      field_problems: { supplier_name: { why: '', codes: ['VENDOR_UNKNOWN'] }, po_reference: { why: '', codes: ['NO_PO_MATCH'] } } },
  });
  const ds = build(rv);
  assert.deepEqual(ds.map((d) => d.key), ['supplier', 'po']);
  assert.equal(ds[1].status, 'blocked');
  assert.equal(ds[1].blockedBy, 'supplier');
  assert.equal(ds[1].options.length, 0);
  const rows = R.fieldStates(rv, ds);
  assert.equal(rows.find((r) => r.name === 'po_reference').text, 'Waits on supplier');
  assert.equal(rows.find((r) => r.name === 'supplier_name').text, 'Needs decision');
});

test('the single order with budget is recommended; one without budget is flagged, not hidden', () => {
  const rv = review({
    fields: { po_reference: rec({ raw_value: '' , status: 'missing' }) },
    po_candidates: [
      { po_id: 'PO-1', currency: 'USD', amount_minor: 100000, status: 'exceeded', remaining_minor: 1000, short_minor: 5000 },
      { po_id: 'PO-2', currency: 'USD', amount_minor: 500000, status: 'fitting', remaining_minor: 400000 },
      { po_id: 'PO-3', currency: 'EUR', amount_minor: 500000, status: 'fitting', remaining_minor: 400000 },
    ],
    diagnosis: { items: [item('NO_PO_MATCH', { fields: ['po_reference'] })], vendor_resolved: true, field_problems: { po_reference: { why: 'No purchase order reference was found.', codes: ['NO_PO_MATCH'] } } },
  });
  const [d] = build(rv, { money: (m, c) => `${c} ${(m / 100).toFixed(2)}` });
  assert.equal(d.status, 'open');
  assert.deepEqual(d.options.filter((o) => o.id.startsWith('po:PO')).map((o) => o.label), ['PO-1', 'PO-2'], 'EUR order filtered out for a USD invoice');
  const recd = d.options.find((o) => o.recommended);
  assert.equal(recd.label, 'PO-2');
  assert.match(d.options[0].detail, /not enough for this invoice/);
  assert.match(d.evidence, /only open USD order with budget/);
  assert.ok(d.options.some((o) => o.action.kind === 'raise_po'));
});

test('an order the invoice itself names wins the recommendation over other fitting orders', () => {
  const rv = review({
    fields: { po_reference: rec({ raw_value: 'PO-1002 / PO-1001' }) },
    context: { currency: { code: 'USD' }, po_references: ['PO-1002', 'PO-1001'] },
    po_candidates: [
      { po_id: 'PO-1001', currency: 'USD', amount_minor: 1, status: 'fitting', remaining_minor: 1 },
      { po_id: 'PO-1002', currency: 'USD', amount_minor: 1, status: 'fitting', remaining_minor: 1 },
      { po_id: 'PO-1005', currency: 'USD', amount_minor: 1, status: 'fitting', remaining_minor: 1 },
    ],
    diagnosis: { items: [item('PO_MULTIPLE_REFS', { fields: ['po_reference'] })], vendor_resolved: true, field_problems: { po_reference: { why: '', codes: ['PO_MULTIPLE_REFS'] } } },
  });
  const [d] = build(rv);
  // two orders are named on the page: neither can honestly be recommended
  assert.equal(d.options.filter((o) => o.recommended).length, 0);
  const one = build(review({ ...rv, context: { currency: { code: 'USD' }, po_references: ['PO-1002'] },
    po_candidates: rv.po_candidates, fields: { po_reference: rec({ raw_value: 'PO-1002' }) } }))[0];
  assert.equal(one.options.find((o) => o.recommended).label, 'PO-1002');
  assert.match(one.evidence, /only order named on the invoice/);
});

test('the order decision explains the item-level problem, not the single-reference format rule', () => {
  const rv = review({
    fields: { po_reference: rec({ raw_value: 'PO Reference: PO-1002 / PO-1001' }) },
    context: { currency: { code: 'USD' }, po_references: ['PO-1002', 'PO-1001'] },
    po_candidates: [{ po_id: 'PO-1002', currency: 'USD', amount_minor: 1, status: 'fitting', remaining_minor: 1 }],
    diagnosis: { items: [item('PO_MULTIPLE_REFS', { fields: ['po_reference'] })], vendor_resolved: true,
      field_problems: { po_reference: { why: 'The document mentions several purchase orders: PO-1002, PO-1001. Only one can be matched.',
        unusable: '“PO Reference: PO-1002 / PO-1001” contains no purchase order reference (PO-…).', codes: ['PO_MULTIPLE_REFS'] } } },
  });
  const [d] = build(rv, { problemCopy: (name, p) => p.unusable });
  assert.match(d.why, /mentions several purchase orders/);
  assert.equal(d.options.find((o) => o.recommended)?.label, 'PO-1002', 'the one candidate the page names is recommended');
});

test('an open raise_po request turns the order decision into waiting', () => {
  const rv = review({
    fields: { po_reference: rec({ raw_value: 'PO-77' }) },
    diagnosis: { items: [item('NO_PO_MATCH', { fields: ['po_reference'] })], vendor_resolved: true, field_problems: { po_reference: { why: '', codes: ['NO_PO_MATCH'] } } },
  });
  const [d] = build(rv, { openTickets: ['raise_po'] });
  assert.equal(d.status, 'waiting');
  assert.ok(!d.options.some((o) => o.id === 'po:raise'));
});

// ---- amounts ---------------------------------------------------------------------------
const amounts = (sub, tax, total) => review({
  fields: { subtotal_net: rec({ raw_value: sub }), tax_total: rec({ raw_value: tax }), invoice_gross_total: rec({ raw_value: total }) },
  diagnosis: { items: [item('MATH_MISMATCH', { fields: ['subtotal_net', 'tax_total', 'invoice_gross_total'] })], vendor_resolved: true,
    field_problems: { invoice_gross_total: { why: 'Amounts do not add up: 600.00 + 40.00 ≠ 648.00.', codes: ['MATH_MISMATCH'] } } },
});

test('a math mismatch offers each single-field fix and recommends the one printed on the page', () => {
  const [d] = build(amounts('$600.00', '$40.00', '$648.00'), { pageText: 'Subtotal: $600.00 Sales Tax (8%): $48.00 Total: $648.00' });
  assert.equal(d.key, 'amounts');
  assert.deepEqual(d.fields, ['subtotal_net', 'tax_total', 'invoice_gross_total']);
  const fixes = d.options.filter((o) => o.id.startsWith('amounts:') && o.action.type === 'correct');
  assert.deepEqual(fixes.map((o) => [o.action.field, o.action.value]), [['tax_total', '48.00'], ['invoice_gross_total', '640.00'], ['subtotal_net', '608.00']]);
  const recd = d.options.find((o) => o.recommended);
  assert.equal(recd.action.field, 'tax_total');
  assert.match(d.evidence, /48\.00 is printed on the page/);
  assert.ok(d.options.some((o) => o.action.type === 'correct-many'));
  assert.ok(d.options.some((o) => o.action.type === 'reject'));
});

test('a fix value that only appears inside a larger printed number is not "printed on the page"', () => {
  // 1000 + 80 ≠ 1200; the tax fix would be 200.00, which is a substring of "$1,200.00"
  const [d] = build(amounts('$1,000.00', '$80.00', '$1,200.00'),
    { pageText: 'Subtotal: $1,000.00 Sales Tax: $80.00 Total: $1,200.00' });
  assert.equal(d.options.filter((o) => o.recommended).length, 0);
  assert.equal(d.evidence, null);
  // whereas a genuinely printed grouped amount still counts
  const [d2] = build(amounts('$1,000.00', '$80.00', '$1,200.00'),
    { pageText: 'Subtotal: $1,000.00 Sales Tax: $200.00 Total: $1,200.00' });
  assert.equal(d2.options.find((o) => o.recommended)?.action.value, '200.00');
});

test('without page evidence no amount fix is recommended', () => {
  const [d] = build(amounts('600', '40', '648'));
  assert.equal(d.options.filter((o) => o.recommended).length, 0);
  assert.equal(d.evidence, null);
});

test('an absent shipping line is left out of the arithmetic and its wording', () => {
  const rv = amounts('300.00', '24.00', '400.00');
  rv.fields.shipping_total = rec({ raw_value: null, status: 'missing' });
  const [d] = build(rv);
  const tax = d.options.find((o) => o.id === 'amounts:tax_total');
  assert.equal(tax.action.value, '100.00');
  assert.ok(!/shipping/.test(tax.detail), tax.detail);
  const withShipping = amounts('300.00', '24.00', '400.00');
  withShipping.fields.shipping_total = rec({ raw_value: '50.00' });
  const [d2] = build(withShipping);
  assert.equal(d2.options.find((o) => o.id === 'amounts:tax_total').action.value, '50.00');
  assert.match(d2.options.find((o) => o.id === 'amounts:tax_total').detail, /− shipping/);
});

test('a field already covered by the amounts decision does not get a second scan decision', () => {
  const rv = amounts('600', '40', '648');
  rv.fields.tax_total = rec({ raw_value: '40', read_method: 'llm_vision', attestable: true, checks: { normalization: 'pass' } });
  rv.diagnosis.items.push(item('REVIEW_REQUIRED_SCAN', { fields: ['tax_total'] }));
  const ds = build(rv);
  assert.deepEqual(ds.map((d) => d.key), ['amounts']);
});

// ---- scan readings ------------------------------------------------------------------------
test('an attestable scan reading recommends confirming as read; an unusable one falls back to typing', () => {
  const rv = review({
    fields: { tax_total: rec({ raw_value: '48.00', read_method: 'llm_vision', attestable: true, checks: { normalization: 'pass' } }),
              invoice_date: rec({ raw_value: '4th of Mai', read_method: 'llm_vision', attestable: false, checks: { normalization: 'fail' } }) },
    diagnosis: { items: [item('REVIEW_REQUIRED_SCAN', { fields: ['tax_total', 'invoice_date'] })], vendor_resolved: true,
      field_problems: { invoice_date: { why: 'Could not be read as a date.', codes: ['REVIEW_REQUIRED_SCAN'], suggestions: [] } } },
  });
  const ds = build(rv);
  assert.deepEqual(ds.map((d) => d.key), ['scan:tax_total', 'field:invoice_date']);
  const ok = ds[0].options.find((o) => o.recommended);
  assert.deepEqual(ok.action, { type: 'attest', fields: ['tax_total'] });
  assert.equal(ds[1].options.filter((o) => o.recommended).length, 0);
});

// ---- duplicates, budget, fallbacks -----------------------------------------------------------
test('a same-day match asks for a note or a rejection; a budget forecast becomes a decision even before the code fires', () => {
  const rv = review({
    budget: { po_id: 'PO-1', status: 'exceeded', remaining_minor: 100000, gross_minor: 150000, short_minor: 20000, currency: 'USD' },
    diagnosis: { items: [item('DUP_FINGERPRINT')], vendor_resolved: true, field_problems: {} },
  });
  const ds = build(rv, { money: (m, c) => `${c} ${(m / 100).toFixed(2)}` });
  assert.deepEqual(ds.map((d) => d.key), ['dup', 'budget']);
  assert.ok(ds[0].options.find((o) => o.id === 'dup:distinct').note);
  assert.equal(ds[0].options.find((o) => o.id === 'dup:reject').action.type, 'reject');
  assert.match(ds[1].why, /USD 1000\.00 left; this invoice is USD 1500\.00, USD 200\.00 more/);
  assert.equal(build(rv, { openTickets: ['amend_po'] })[1].status, 'waiting');
});

test('an unrecognised open code still gets a decision with a way out; resolved items get none', () => {
  const rv = review({ diagnosis: { items: [item('CONTENT_CONFLICT', { label: 'Another version was approved', action: 'Finance decides which stands.' }),
    item('AMBIGUOUS_DATE', { status: 'resolved', fields: ['invoice_date'] })], vendor_resolved: true, field_problems: {} } });
  const ds = build(rv);
  assert.deepEqual(ds.map((d) => d.key), ['code:CONTENT_CONFLICT']);
  assert.equal(ds[0].options[0].action.type, 'reject');
});

test('decisions come in dependency order: supplier, currency, date, order, amounts', () => {
  const rv = review({
    fields: { supplier_name: rec({ raw_value: 'X', checks: {} }), currency: rec({ raw_value: '$' }), invoice_date: rec({ raw_value: '1/2/2026' }),
              po_reference: rec({ raw_value: 'PO-1' }), subtotal_net: rec({ raw_value: '1' }), tax_total: rec({ raw_value: '1' }), invoice_gross_total: rec({ raw_value: '3' }) },
    diagnosis: { items: [item('MATH_MISMATCH', { fields: ['subtotal_net', 'tax_total', 'invoice_gross_total'] }), item('NO_PO_MATCH', { fields: ['po_reference'] }),
      item('AMBIGUOUS_DATE', { fields: ['invoice_date'] }), item('AMBIGUOUS_CURRENCY', { fields: ['currency'] }), item('VENDOR_UNKNOWN', { fields: ['supplier_name'] })],
      vendor_resolved: false, field_problems: {} },
  });
  assert.deepEqual(build(rv).map((d) => d.step), ['Supplier', 'Currency', 'Date', 'PO', 'Amounts']);
});

// ---- field rows ------------------------------------------------------------------------------
test('field rows show verification states, never a score', () => {
  const rv = review({
    fields: {
      supplier_name: rec({ raw_value: 'Northwind Supplies LLC' }),
      invoice_number: rec({ raw_value: 'NW-1', review_status: 'corrected' }),
      invoice_date: rec({ raw_value: '2026-08-28', read_method: 'llm_vision', checks: { normalization: 'pass', cross_check: 'arithmetic' } }),
      buyer_name: rec({ raw_value: 'Acme', checks: { source_match: 'fail' } }),
      tax_total: rec({ raw_value: null, status: 'missing' }),
    },
    display: { supplier_name: 'Northwind Supplies LLC' },
  });
  const rows = Object.fromEntries(R.fieldStates(rv, []).map((r) => [r.name, r]));
  assert.equal(rows.supplier_name.text, 'Verified');
  assert.equal(rows.invoice_number.text, 'Confirmed by you');
  assert.equal(rows.invoice_date.text, 'Verified by cross-check');
  assert.equal(rows.buyer_name.text, 'Unverified');
  assert.equal(rows.tax_total.text, 'Not found');
  assert.equal(rows.po_reference.text, 'Not found', 'required fields appear even when the model returned nothing');
  assert.ok(!('shipping_total' in rows), 'optional absent fields stay hidden');
  const withEmptyShipping = review({ fields: { ...rv.fields, shipping_total: rec({ raw_value: null, status: 'missing' }) } });
  assert.ok(!R.fieldStates(withEmptyShipping, []).some((r) => r.name === 'shipping_total'), 'an empty optional field is not a red row');
  for (const r of Object.values(rows)) assert.ok(!/%/.test(r.text));
});

// ---- helpers -----------------------------------------------------------------------------------
test('amount parsing handles both separator conventions', () => {
  assert.equal(R.parseAmount('$6,495.00'), 6495);
  assert.equal(R.parseAmount('1.234,56'), 1234.56);
  assert.equal(R.parseAmount('2.809,30'), 2809.3);
  assert.equal(R.parseAmount('EUR 648'), 648);
  assert.equal(R.parseAmount(''), null);
  assert.equal(R.parseAmount('n/a'), null);
});

test('name difference is described in words a reviewer can check', () => {
  assert.equal(R.nameDiff('Cedar Cloud Services', 'Cedar Cloud Services Ltd'), 'name differs only by “Ltd”');
  assert.equal(R.nameDiff('Globex Industrial Inc.', 'Globex Industrial'), 'printed name adds “Inc”');
  assert.match(R.nameDiff('Cedar Clowd Servces', 'Cedar Cloud Services'), /\d+% name similarity/);
});
