import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioCase, FOLLOWUP_CSV } from '../lib/recall/sample.ts';
import { parseLedgerCsv } from '../lib/recall/csv.ts';
import { reconcileCase } from '../lib/recall/engine.ts';
import { evidenceFingerprint, recordSnapshot, takeSnapshot } from '../lib/recall/snapshot.ts';
import { challengeIssue, type Challenge } from '../lib/recall/explain.ts';
import type { RecallCase } from '../lib/recall/types.ts';

// Evidence Challenge on the missing-40 drill. Every line must come from records, engine statuses or
// typed fields, so the assertions check content, and that no likelihoods are invented.
const NOW = '2026-10-24T00:00:00Z', LATER = '2026-10-24T03:00:00Z';
const text = (ch: Challenge) => JSON.stringify(ch);
function explain(c: RecallCase, issueId: string) {
  const r = reconcileCase(c), issue = r.issues.find(i => i.id === issueId)!;
  assert.ok(issue, `${issueId} is open`);
  return challengeIssue(issue, { c, r, current: evidenceFingerprint(c, r), now: Date.parse(LATER) });
}
const addFollowUp = (c: RecallCase) => {
  c.records.push(...parseLedgerCsv(FOLLOWUP_CSV, 'followup'));
  c.sources.push({ id: 'followup', name: 'Training follow-up.csv', kind: 'sample', content: FOLLOWUP_CSV, added_at: LATER, row_count: 1 });
};

test('why RR-104 is unresolved: the calculation, and why no rejected record explains it', () => {
  const ch = explain(createScenarioCase('missing-40', 'x1', NOW), 'stock:RR-104');
  assert.equal(ch.calculation.length, 1); assert.match(ch.calculation[0].text, /Opening shipment DISPATCH-104 at “Destination pending confirmation”: \+40 awaiting containment/);
  assert.deepEqual(ch.calculation[0].balance, { available: 40, quarantined: 0, returned: 0, dispensed: 0 });
  assert.match(ch.result!, /RR-104: 40 awaiting containment, 0 quarantined, 0 returned, 0 dispensed \(bottles\), of 40 accepted/);
  assert.match(text(ch), /None of the 4 records held for review elsewhere names RR-104, its location or a quantity of 40/);
  assert.match(text(ch), /current status of the 40 bottles still awaiting containment: .* does not mean they are safe to sell or use/);
  const could = ch.could_change.join(' ');
  assert.match(could, /dated quarantine, return or dispensing record for RR-104 \(batch DEMO-042, in bottles/);
  // An unconfirmed destination: say how evidence naming the real recipient is handled, without changing the original.
  assert.match(could, /matches it to the shipment by location, and the opening record still says “Destination pending confirmation”/);
  assert.match(could, /If that evidence names the actual recipient, first correct the opening record DISPATCH-104 to that recipient .* The original record stays in the history, marked superseded\./);
  assert.doesNotMatch(could, /already counted/, 'nothing is counted at that location yet');
});

test('why approval cannot change it: a decision is listed, and stock is unchanged', () => {
  const c = createScenarioCase('missing-40', 'x2', NOW);
  c.decisions.push({ id: 'd1', issue_id: 'stock:RR-104', at: NOW, actor: 'Coordinator', status: 'approved', note: 'Distributor asked for proof of delivery.', evidence_ids: [] });
  const ch = explain(c, 'stock:RR-104');
  assert.match(ch.approvals[0], /Coordinator approved “stock:RR-104”/);
  assert.match(ch.approvals.at(-1)!, /does not change stock\. Only imported evidence that passes the engine’s checks changes a balance/);
  assert.equal(reconcileCase(c).shipments.find(s => s.shipment_id === 'RR-104')!.available, 40);
});

test('which new evidence changed the result, and why a reported quarantine is not a confirmed destination', () => {
  const c = createScenarioCase('missing-40', 'x3', NOW);
  recordSnapshot(c, takeSnapshot(c, reconcileCase(c), 'rules', 'T', null, NOW));
  addFollowUp(c);
  const ch = explain(c, 'destination:RR-104');
  const added = ch.changes.find(g => /Added since the previous run/.test(g.heading));
  assert.ok(added, JSON.stringify(ch.changes)); assert.match(added.items[0].text, /awaiting containment → quarantined, 40 bottles; applied/);
  assert.match(ch.unknowns.join(' '), /does not name a responsible recipient, so the destination stays unconfirmed/);
  assert.match(ch.could_change.join(' '), /Proof of delivery naming a responsible recipient would close “Destination unconfirmed”\. A quarantine or return report alone does not/);
});

test('why the 60 dispensed bottles need follow-up even though nothing is missing', () => {
  const ch = explain(createScenarioCase('missing-40', 'x4', NOW), 'dispensed:RR-103');
  assert.match(ch.unknowns.join(' '), /Who received the 60 bottles recorded as dispensed, and with what outcome/);
  assert.match(ch.could_change.join(' '), /supervising pharmacist reviews the dispensing outside this workspace/);
  assert.equal(ch.hypothetical, null, 'no available stock, so no containment preview');
});

test('the hypothetical preview reruns the engine and shows which issues would stay open', () => {
  const c = createScenarioCase('missing-40', 'x5', NOW), before = JSON.stringify(c);
  const ch = explain(c, 'stock:RR-104');
  assert.deepEqual(ch.hypothetical!.after, { available: 0, quarantined: 40, returned: 0, dispensed: 0 });
  assert.deepEqual(ch.hypothetical!.closed, ['Locate and check 40 bottles']);
  assert.deepEqual(ch.hypothetical!.still_open, ['Confirm where shipment RR-104 went']);
  assert.match(ch.hypothetical!.description, /Not evidence; nothing is saved/);
  assert.equal(JSON.stringify(c), before, 'the preview does not touch the case');
});

test('what each source says: who names RR-104, who does not, and what a live read returned at the time', () => {
  const c = createScenarioCase('missing-40', 'x7', NOW), names = Object.fromEntries(c.sources.map(s => [s.id, s.name]));
  c.scope_observations = {
    'zetaris://localhost:8888/org/1|recall_pharmacy.stock_events|batch=DEMO-042|shipment=RR-104': { observed_at: LATER, rows: 0 },
    'zetaris://localhost:8888/org/1|recall_returns.return_notes|batch=DEMO-042|shipment=RR-104': { observed_at: LATER, rows: 0 },
    'mock://fixtures|pharmacy_stock_events|batch=DEMO-042|shipment=RR-104': { observed_at: NOW, rows: 1 },
    'zetaris://localhost:8888/org/1|recall_pharmacy.stock_events|batch=DEMO-042|shipment=RR-103': { observed_at: LATER, rows: 2 },
  };
  const ch = explain(c, 'stock:RR-104'), dispatch = 'sample-missing-40-distributor_dispatches';
  assert.equal(ch.answer, `40 bottles of RR-104 have no accepted quarantine, return or dispensing record. Only “${names[dispatch]}” has an imported record naming RR-104; no imported record from “${names['sample-missing-40-pharmacy_stock_events']}” or “${names['sample-missing-40-return_records']}” names it.`);
  assert.deepEqual(ch.sources.map(s => s.items.length), c.sources.map(s => s.id === dispatch ? 1 : 0));
  assert.match(ch.sources.find(s => s.source_id === dispatch)!.items[0].text, /^DISPATCH-104: opening shipment, 40 bottles; applied\.$/);
  assert.deepEqual(ch.reads, [
    'Read from a MOCK connected source (not Zetaris) at 2026-10-24 00:00 UTC: 1 row for RR-104 in pharmacy_stock_events (as of that read).',
    'Checked live through Zetaris at 2026-10-24 03:00 UTC: 0 rows for RR-104 in recall_pharmacy.stock_events and recall_returns.return_notes (as of that read).',
  ], 'only reads scoped to this shipment; mock reads are labelled; silence is dated, not a clearance');
  assert.doesNotMatch(text(ch), /has no record|no record exists|confirmed absent/i);
  addFollowUp(c);
  const after = explain(c, 'destination:RR-104');
  assert.match(after.answer!, /^Nothing of RR-104 is still awaiting containment: 40 bottles reported contained and 0 bottles recorded as dispensed\. /);
  assert.match(after.answer!, /“Training follow-up\.csv”/);
  // Two imports from the same Zetaris table are one source system, named once.
  const origin = { system: 'zetaris' as const, mode: 'live' as const, table: 'recall_pharmacy.stock_events', instance: 'zetaris://localhost:8888/org/1', latency_ms: 1, sql: '' };
  for (const [id, at] of [['z1', NOW], ['z2', LATER]]) c.sources.push({ id, name: `Pharmacy stock events via Zetaris ${at}`, kind: 'zetaris', content: '', added_at: at, row_count: 0, origin: { ...origin, query_id: id, fetched_at: at } });
  const grouped = explain(c, 'destination:RR-104');
  assert.equal(grouped.sources.filter(s => s.name === 'recall_pharmacy.stock_events (through Zetaris)').length, 1);
  assert.equal(grouped.sources.find(s => s.source_id === 'z1')!.via, '2 imports, last read 2026-10-24 03:00 UTC');
  assert.match(grouped.answer!, /or “recall_pharmacy\.stock_events \(through Zetaris\)” names it\.$/);
});

test('explanations contain no invented likelihoods', () => {
  const c = createScenarioCase('missing-40', 'x6', NOW), r = reconcileCase(c);
  for (const issue of r.issues) assert.doesNotMatch(text(challengeIssue(issue, { c, r, current: 'x' })), /\d+\s?%|\b(likely|probably|probability|chance|confidence)\b/i, issue.id);
});
