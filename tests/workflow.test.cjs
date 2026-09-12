const test = require('node:test');
const assert = require('node:assert/strict');
const {workState,latestRequests,unrequestedNeeds} = require('../backend/app/static/workflow.js');
const run = {run_id:'child',document_id:'doc',run_status:'completed',disposition:'held',created_at:'2026-09-10 12:00:00',finished_at:'2026-09-10 12:00:01'};
const request = {run_id:'parent',document_id:'doc',kind:'raise_po',status:'open',created_at:'2026-09-10 11:00:00'};
test('an open request follows the invoice across review attempts',()=>assert.equal(workState(run,[request]).key,'waiting'));
test('a response after the current check is ready to resume',()=>assert.equal(workState(run,[{...request,status:'resolved',resolved_at:'2026-09-10 12:01:00'}]).key,'ready'));
test('an older response is not still ready after an unsuccessful recheck',()=>assert.equal(workState(run,[{...request,status:'resolved',resolved_at:'2026-09-10 11:50:00'}]).key,'review'));
test('an approval stays final even if procurement still has an open request',()=>assert.equal(workState({...run,disposition:'approved'},[request]).key,'approved'));
test('a declined response directs the reviewer to the reply',()=>assert.equal(workState(run,[{...request,status:'declined',resolved_at:'2026-09-10 12:02:00'}]).action,'Read reply'));
test('another document request cannot affect this invoice',()=>assert.equal(workState(run,[{...request,document_id:'other'}]).key,'review'));
test('the latest request for each kind replaces the previous reply',()=>{const old={...request,status:'resolved'};assert.deepEqual(latestRequests([request,old],run.document_id),[request]);});
test('processing and failed readings have useful next actions',()=>{assert.equal(workState({...run,run_status:'running'},[request]).action,'View progress');assert.equal(workState({...run,run_status:'failed'},[]).action,'Resolve issue');});
test('detected needs deduplicate only the matching open request kind across attempts',()=>{const needs=[{run_id:'child',asks:[{code:'NO_PO_MATCH'},{code:'PO_BUDGET_EXCEEDED'}]}];assert.deepEqual(unrequestedNeeds(needs,[request],[run])[0].asks,[{code:'PO_BUDGET_EXCEEDED'}]);assert.equal(unrequestedNeeds(needs,[{...request,status:'resolved'}],[run])[0].asks.length,2);});
test('same-second response on the current run remains visible',()=>assert.equal(workState(run,[{...request,run_id:'child',status:'resolved',resolved_at:run.finished_at}]).key,'ready'));
test('a rejected non-invoice never returns to review through old procurement requests',()=>{
  const rejected={...run,disposition:'rejected',codes:['UNSUPPORTED_DOCUMENT_TYPE']};
  for(const status of ['open','declined','resolved']) assert.equal(workState(rejected,[{...request,run_id:'child',status}]).key,'rejected');
});
