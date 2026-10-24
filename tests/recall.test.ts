import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, reconcileCase, nearMissBatch } from '../lib/recall/engine.ts';
import { createSample, FOLLOWUP_CSV } from '../lib/recall/sample.ts';
import { parseLedgerCsv, parseCsvRows, toCsv, sourceRow } from '../lib/recall/csv.ts';
import { appendAudit, verifyAudit } from '../lib/recall/audit.ts';
import { compareSnapshots, staleness, takeSnapshot, recordSnapshot } from '../lib/recall/snapshot.ts';
import type { LedgerRecord } from '../lib/recall/types.ts';

const sample = () => createSample('test', '2026-10-23T00:00:00Z');
const byEvent = (rows: LedgerRecord[], e: string) => rows.find(r => r.event_id === e)!;
const states = ['available', 'quarantined', 'returned', 'dispensed'] as const;

test('sample reconciles 1000 bottles without double-counting quarantine then return', () => {
  const c = sample(), r = reconcile(c.alert, c.records);
  assert.deepEqual([r.shipped,r.quarantined,r.returned,r.dispensed,r.available,r.contained,r.coverage], [1000,800,100,60,40,900,90]);
  assert.equal(r.duplicate_ids.length, 1); assert.equal(r.excluded_ids.length, 1);
  // The drill now carries deliberate variants: two conflicting versions, a wrong unit and a missing shipment ID.
  assert.deepEqual(r.review_ids.map(id => c.records.find(x => x.id === id)!.event_id).sort(), ['Q-C2', 'Q-E', 'R-B', 'R-B']);
  assert.equal(r.shipped, r.quarantined + r.returned + r.available + r.dispensed);
});
test('conservation holds per shipment, not only in total', () => {
  const r = reconcile(sample().alert, sample().records);
  for (const s of r.shipments) assert.equal(s.quantity, states.reduce((n, k) => n + s[k], 0), s.shipment_id);
});
test('follow-up changes containment but never closes dispensed-stock finding', () => {
  const c = sample(), r = reconcile(c.alert, [...c.records, ...parseLedgerCsv(FOLLOWUP_CSV, 'followup')]);
  assert.equal(r.available, 0); assert.equal(r.coverage, 94); assert.equal(r.dispensed, 60); assert.equal(r.contained, 940);
  assert.equal(r.issues.some(i => i.kind === 'Pharmacist follow-up'), true);
  assert.equal(r.issues.some(i => i.id === 'destination:RR-104'), true, 'quarantine evidence does not confirm the destination');
});
test('conflicting event versions are all held for review', () => {
  const c = sample(), row = c.records[0];
  const r = reconcile(c.alert, [row, { ...row, id: 'conflict', quantity: 501 }]);
  assert.equal(r.shipped, 0); assert.equal(r.review_ids.length, 2);
});
test('different IDs cannot count the same reference twice', () => {
  const c = sample(); const rows = c.records.slice(0, 1);
  const q = byEvent(c.records, 'Q-A');
  const r = reconcile(c.alert, [...rows,q,{...q,id:'copy',event_id:'Q-OTHER'}]);
  assert.equal(r.quarantined, 500); assert.equal(r.review_ids.length, 1);
});
test('a second opening record for one shipment is not added', () => {
  const c = sample(), s = c.records[0];
  const r = reconcile(c.alert, [s, { ...s, id: 'again', event_id: 'S-A2', reference: 'INV-101-R', occurred_at: '2026-10-01T10:00:00Z' }]);
  assert.equal(r.shipped, 500); assert.equal(r.review_ids.length, 1);
});
test('overspending a stock bucket is refused without negative balances', () => {
  const c = sample(), q = {...byEvent(c.records, 'Q-A'), quantity:501};
  const r = reconcile(c.alert, [c.records[0],q]);
  assert.equal(r.available,500); assert.equal(r.quarantined,0); assert.equal(r.review_ids.length,1);
});
test('releasing held stock or reversing dispensing is not an ordinary movement', () => {
  const c = sample(), s = c.records[0], q = byEvent(c.records, 'Q-A');
  const release = { ...q, id: 'rel', event_id: 'REL', from_state: 'quarantined', to_state: 'available', reference: 'REL-1', occurred_at: '2026-10-05T00:00:00Z', quantity: 10 };
  const undo = { ...q, id: 'undo', event_id: 'UNDO', from_state: 'dispensed', to_state: 'quarantined', reference: 'UNDO-1', occurred_at: '2026-10-05T00:00:00Z', quantity: 1 };
  const r = reconcile(c.alert, [s, q, release, undo]);
  assert.equal(r.quarantined, 500); assert.deepEqual(r.review_ids.sort(), ['rel', 'undo']);
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
test('near-miss batch numbers are suggested for review but never counted', () => {
  const c = sample(), row = c.records[0];
  const r = reconcile(c.alert, [{ ...row, id: 'a', batch: 'DEMO042' }, { ...row, id: 'b', event_id: 'S-A9', shipment_id: 'RR-9', batch: 'DEMO-042B', reference: 'X' }, { ...row, id: 'c', event_id: 'S-A8', shipment_id: 'RR-8', batch: 'DEMO-043', reference: 'Y' }]);
  assert.equal(r.shipped, 0);
  assert.deepEqual(r.issues.filter(i => i.kind === 'Possible batch match').map(i => i.evidence_ids[0]).sort(), ['a', 'b']);
  assert.equal(nearMissBatch('VL-22O7', 'VL-2207'), true, 'letter O read as zero');
  assert.equal(nearMissBatch('DEMO-043', 'DEMO-042'), false, 'a different batch number is not a near miss');
});
test('unit mismatch never silently converts', () => {
  const c = sample(), r = reconcile(c.alert,[{...c.records[0],unit:'boxes'}]);
  assert.equal(r.shipped,0); assert.equal(r.review_ids.length,1);
});
test('fractional, negative, zero and implausible quantities are held for review', () => {
  const rows = parseLedgerCsv(FOLLOWUP_CSV.replace(',40,', ',2.5,'), 's');
  assert.equal(rows[0].quantity, 0); assert.equal(rows[0].raw_quantity, '2.5');
  const c = sample(), base = c.records[0];
  const r = reconcile(c.alert, [{ ...base, id: 'f', quantity: 0, raw_quantity: '2.5' }, { ...base, id: 'n', event_id: 'N', shipment_id: 'N', quantity: 0, raw_quantity: '-5' }, { ...base, id: 'big', event_id: 'B', shipment_id: 'B', quantity: 50_000_000 }]);
  assert.equal(r.shipped, 0); assert.equal(r.review_ids.length, 3);
  assert.match(r.record_status.f.reason, /“2\.5”/);
});
test('movement before shipment and orphan movement are reviewed', () => {
  const c = sample(), q = {...byEvent(c.records, 'Q-A'),occurred_at:'2026-09-01T00:00:00Z'};
  const r = reconcile(c.alert,[c.records[0],q]);
  assert.equal(r.available,500); assert.equal(r.review_ids.length,1);
});
test('location mismatch is not silently mapped', () => {
  const c = sample(), q = {...byEvent(c.records, 'Q-A'),location:'Another pharmacy'};
  const r = reconcile(c.alert,[c.records[0],q]); assert.equal(r.available,500); assert.equal(r.review_ids.length,1);
});
test('future events are not accepted', () => {
  const c = sample(), r = reconcile(c.alert,[{...c.records[0],occurred_at:'2099-01-01T00:00:00Z'}]);
  assert.equal(r.shipped,0); assert.equal(r.review_ids.length,1);
  assert.equal(reconcile(c.alert, [{ ...c.records[0], occurred_at: '2026-10-01T09:00:00Z' }], { now: Date.parse('2026-09-30T00:00:00Z') }).shipped, 0, 'clock is injectable');
});
test('timestamps without a timezone or in other formats are invalid', () => {
  const c = sample();
  for (const t of ['2026-10-01 09:00', '2026-10-01', '01/10/2026 09:00', 'yesterday', '2026-13-01T00:00:00Z']) assert.equal(reconcile(c.alert, [{ ...c.records[0], occurred_at: t }]).review_ids.length, 1, t);
  assert.equal(reconcile(c.alert, [{ ...c.records[0], occurred_at: '2026-10-01T14:30:00+05:30' }]).shipped, 500);
});
test('a correction supersedes the original without editing it, and recalculates', () => {
  const c = sample(), q = byEvent(c.records, 'Q-C2');
  const replacement = parseLedgerCsv(FOLLOWUP_CSV.replace('Q-D,RR-104', 'Q-C3,RR-103').replace('Destination pending confirmation', 'Meadow Pharmacy').replace(',40,', ',0,'), 'fix')[0];
  c.records.push({ ...replacement, quantity: 0 });
  c.corrections.push({ id: 'k1', at: '2026-10-05T00:00:00Z', actor: 'QA', kind: 'supersede', original_id: q.id, replacement_id: replacement.id, reason: 'Unit was entered as boxes', evidence_reference: 'Email 12' });
  const r = reconcileCase(c);
  assert.equal(r.record_status[q.id].status, 'superseded'); assert.match(r.record_status[q.id].reason, /Unit was entered as boxes/);
  assert.equal(c.records.find(x => x.id === q.id)!.unit, 'boxes', 'original record is unchanged');
  c.corrections.push({ id: 'k2', at: '2026-10-05T00:00:00Z', actor: 'QA', kind: 'withdraw', original_id: byEvent(c.records, 'Q-A').id, replacement_id: null, reason: 'Hold record entered for wrong pharmacy', evidence_reference: 'Call log 7' });
  const r2 = reconcileCase(c);
  assert.equal(r2.available, 540); assert.equal(r2.quarantined, 400); assert.equal(r2.returned, 0);
  assert.match(r2.record_status[byEvent(c.records, 'R-A').id].reason, /only 0 are recorded in quarantined/, 'the dependent return record is now an overspend');
});
test('CSV supports quoted commas, escaped quotes, CRLF and multiline fields', () => {
  assert.deepEqual(parseCsvRows('a,b\r\n"one, two","three ""four""\nfive"'),[['a','b'],['one, two','three "four"\nfive']]);
  assert.throws(() => parseCsvRows('a,b\n"unfinished,b'), /unclosed/);
  assert.throws(() => parseLedgerCsv('a,b\n1,2','source'), /Missing columns/);
});
test('original source rows are retrievable exactly as imported', () => {
  const c = sample(), q = byEvent(c.records, 'Q-E'), src = c.sources.find(s => s.id === q.source_id)!;
  assert.deepEqual(sourceRow(src, q.source_row), { event_id: 'Q-E', shipment_id: '', type: 'movement', from_state: 'available', to_state: 'quarantined', product: 'Nivara oral solution', manufacturer: 'Example Pharma (fictional)', batch: 'DEMO-042', quantity: '12', unit: 'bottles', location: 'Harbor Pharmacy', reference: 'HOLD-UNLINKED', occurred_at: '2026-10-02T11:30:00Z' });
  assert.equal(sourceRow(src, 1), null, 'the header is not a record');
});
test('CSV export neutralizes formula cells', () => {
  assert.equal(toCsv([{reference:'=1+1'}],['reference']), "reference\r\n'=1+1");
  assert.equal(toCsv([{a:'+SUM(A1)',b:'@cmd',c:'-2+3',d:'\tx'}],['a','b','c','d']), "a,b,c,d\r\n'+SUM(A1),'@cmd,'-2+3,'\tx");
});
test('audit verifies authentic sequence and detects tampering and reordering', async () => {
  const c = sample(); await appendAudit(c,'Operator','Created','Case created'); await appendAudit(c,'Operator','Imported','Two records');
  assert.equal(await verifyAudit(c.audit),true);
  const modified = structuredClone(c.audit); modified[0].detail='Rewritten';
  assert.equal(await verifyAudit(modified),false); assert.equal(await verifyAudit([...c.audit].reverse()),false);
  assert.equal(await verifyAudit(c.audit.slice(1)), false, 'dropping the first entry breaks the chain');
});
test('evidence snapshots detect what changed and mark earlier conclusions stale', () => {
  const c = sample(), r1 = reconcileCase(c);
  recordSnapshot(c, takeSnapshot(c, r1, 'rules', 'QA', null, '2026-10-04T00:00:00Z'));
  assert.equal(staleness(c, r1).stale, false);
  c.records.push(...parseLedgerCsv(FOLLOWUP_CSV, 'followup'));
  const r2 = reconcileCase(c), diff = compareSnapshots(c.snapshots[0], takeSnapshot(c, r2, 'rules', 'QA', null, '2026-10-05T00:00:00Z'));
  assert.equal(staleness(c, r2).stale, true);
  assert.deepEqual(diff.totals, [{ field: 'available', before: 40, after: 0 }, { field: 'quarantined', before: 800, after: 840 }]);
  assert.deepEqual(diff.shipments.map(s => s.shipment_id), ['RR-104']);
  assert.deepEqual(diff.issues_closed, ['stock:RR-104']);
});
