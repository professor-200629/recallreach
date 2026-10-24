import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../lib/recall/engine.ts';
import { createSample, FOLLOWUP_CSV } from '../lib/recall/sample.ts';
import { parseLedgerCsv, parseCsvRows, toCsv } from '../lib/recall/csv.ts';
import { appendAudit, verifyAudit } from '../lib/recall/audit.ts';
const sample = () => createSample('test', '2026-10-23T00:00:00Z');
test('sample reconciles 1000 bottles without double-counting quarantine then return', () => {
  const c = sample(), r = reconcile(c.alert, c.records);
  assert.deepEqual([r.shipped,r.quarantined,r.returned,r.dispensed,r.available,r.contained,r.coverage], [1000,800,100,60,40,900,90]);
  assert.equal(r.duplicate_ids.length, 1); assert.equal(r.excluded_ids.length, 1); assert.equal(r.review_ids.length, 0);
  assert.equal(r.shipped, r.quarantined + r.returned + r.available + r.dispensed);
});
test('follow-up changes containment but never closes dispensed-stock finding', () => {
  const c = sample(), r = reconcile(c.alert, [...c.records, ...parseLedgerCsv(FOLLOWUP_CSV, 'followup')]);
  assert.equal(r.available, 0); assert.equal(r.coverage, 94); assert.equal(r.dispensed, 60);
  assert.equal(r.issues.some(i => i.kind === 'Pharmacist follow-up'), true);
});
test('conflicting event versions are all held for review', () => {
  const c = sample(), row = c.records[0];
  const r = reconcile(c.alert, [row, { ...row, id: 'conflict', quantity: 501 }]);
  assert.equal(r.shipped, 0); assert.equal(r.review_ids.length, 2);
});
test('different IDs cannot count the same reference twice', () => {
  const c = sample(); const rows = c.records.slice(0, 1);
  const q = c.records.find(r => r.event_id === 'Q-A')!;
  const r = reconcile(c.alert, [...rows,q,{...q,id:'copy',event_id:'Q-OTHER'}]);
  assert.equal(r.quarantined, 500); assert.equal(r.review_ids.length, 1);
});
test('overspending a stock bucket is refused without negative balances', () => {
  const c = sample(), q = {...c.records.find(r => r.event_id === 'Q-A')!, quantity:501};
  const r = reconcile(c.alert, [c.records[0],q]);
  assert.equal(r.available,500); assert.equal(r.quarantined,0); assert.equal(r.review_ids.length,1);
});
test('missing batch is uncertain rather than outside recall', () => {
  const c = sample(), r = reconcile(c.alert,[{...c.records[0], batch:''}]);
  assert.equal(r.review_ids.length,1); assert.equal(r.excluded_ids.length,0);
});
test('wrong batch and manufacturer do not match', () => {
  const c = sample(), r = reconcile(c.alert,[{...c.records[0],batch:'OTHER'},{...c.records[1],manufacturer:'Other manufacturer'}]);
  assert.equal(r.shipped,0); assert.equal(r.excluded_ids.length,2);
});
test('case and outer whitespace normalize, punctuation does not', () => {
  const c = sample(), row = c.records[0];
  assert.equal(reconcile(c.alert,[{...row,batch:' demo-042 '}]).shipped,500);
  assert.equal(reconcile(c.alert,[{...row,batch:'DEMO042'}]).shipped,0);
});
test('unit mismatch never silently converts', () => {
  const c = sample(), r = reconcile(c.alert,[{...c.records[0],unit:'boxes'}]);
  assert.equal(r.shipped,0); assert.equal(r.review_ids.length,1);
});
test('movement before shipment and orphan movement are reviewed', () => {
  const c = sample(), q = {...c.records.find(r => r.event_id === 'Q-A')!,occurred_at:'2026-09-01T00:00:00Z'};
  const r = reconcile(c.alert,[c.records[0],q]);
  assert.equal(r.available,500); assert.equal(r.review_ids.length,1);
});
test('location mismatch is not silently mapped', () => {
  const c = sample(), q = {...c.records.find(r => r.event_id === 'Q-A')!,location:'Another pharmacy'};
  const r = reconcile(c.alert,[c.records[0],q]); assert.equal(r.available,500); assert.equal(r.review_ids.length,1);
});
test('future events are not accepted', () => {
  const c = sample(), r = reconcile(c.alert,[{...c.records[0],occurred_at:'2099-01-01T00:00:00Z'}]);
  assert.equal(r.shipped,0); assert.equal(r.review_ids.length,1);
});
test('CSV supports quoted commas, escaped quotes, CRLF and multiline fields', () => {
  assert.deepEqual(parseCsvRows('a,b\r\n"one, two","three ""four""\nfive"'),[['a','b'],['one, two','three "four"\nfive']]);
  assert.throws(() => parseCsvRows('a,b\n"unfinished,b'), /unclosed/);
  assert.throws(() => parseLedgerCsv('a,b\n1,2','source'), /Missing columns/);
});
test('CSV export neutralizes formula cells', () => {
  assert.equal(toCsv([{reference:'=1+1'}],['reference']), "reference\r\n'=1+1");
});
test('audit verifies authentic sequence and detects tampering and reordering', async () => {
  const c = sample(); await appendAudit(c,'Operator','Created','Case created'); await appendAudit(c,'Operator','Imported','Two records');
  assert.equal(await verifyAudit(c.audit),true);
  const modified = structuredClone(c.audit); modified[0].detail='Rewritten';
  assert.equal(await verifyAudit(modified),false); assert.equal(await verifyAudit([...c.audit].reverse()),false);
});
