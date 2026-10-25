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
  assert.equal(ch.calculation.length, 1); assert.match(ch.calculation[0].text, /Opening shipment DISPATCH-104 at “Destination pending confirmation”: \+40 available/);
  assert.deepEqual(ch.calculation[0].balance, { available: 40, quarantined: 0, returned: 0, dispensed: 0 });
  assert.match(ch.result!, /RR-104: 40 available, 0 quarantined, 0 returned, 0 dispensed \(bottles\), of 40 accepted/);
  assert.match(text(ch), /None of the 4 records held for review elsewhere names RR-104, its location or a quantity of 40/);
  assert.match(text(ch), /current status of the 40 bottles still “available”/);
  assert.match(ch.could_change.join(' '), /dated quarantine, return or dispensing record for RR-104 \(batch DEMO-042, in bottles/);
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
  assert.ok(added, JSON.stringify(ch.changes)); assert.match(added.items[0].text, /available → quarantined, 40 bottles; applied/);
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

test('explanations contain no invented likelihoods', () => {
  const c = createScenarioCase('missing-40', 'x6', NOW), r = reconcileCase(c);
  for (const issue of r.issues) assert.doesNotMatch(text(challengeIssue(issue, { c, r, current: 'x' })), /\d+\s?%|\b(likely|probably|probability|chance|confidence)\b/i, issue.id);
});
