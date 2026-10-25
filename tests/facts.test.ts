import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioCase } from '../lib/recall/sample.ts';
import { reconcileCase } from '../lib/recall/engine.ts';
import { takeSnapshot } from '../lib/recall/snapshot.ts';
import { collectDelivered, createContext, executeTool, FINAL_TOOL, serializeForModel, type ToolContext } from '../lib/recall/agent/tools.ts';
import { verifyAnswer } from '../lib/recall/agent/validate.ts';
import { MockZetarisSource } from '../lib/recall/sources/mock.ts';

// Counterexamples for the typed-fact verifier. Each fact names an entity, a predicate, a quantity,
// a unit and a scope; any wrong field rejects it, and the wording comes from RecallReach, not the model.
const NOW = '2026-10-24T00:00:00Z';
function setup(external: MockZetarisSource | null = null) {
  const c = createScenarioCase('missing-40', 'facts', NOW), r = reconcileCase(c);
  return createContext({ c, r, memory: null, external, previous: undefined, current: takeSnapshot(c, r, 'agent-live', 'T', null, NOW) });
}
/** Runs a tool the way the runner does: serialize, then collect what was actually delivered. */
async function deliver(ctx: ToolContext, name: string, args: Record<string, unknown> = {}) {
  const { result } = await executeTool(name, args, ctx), text = serializeForModel(result);
  collectDelivered(name, text, ctx);
  return JSON.parse(text);
}
const check = (ctx: ToolContext, facts: unknown[], extra: Record<string, unknown> = {}) =>
  verifyAnswer(FINAL_TOOL.schema.parse({ summary: 'Test summary text.', facts, interpretations: [], evidence_requests: [], ...extra }), ctx);
const balance = (shipment_id: string, state: string, quantity: number, unit = 'bottles', snapshot?: string) => ({ type: 'shipment_balance', shipment_id, state, quantity, unit, ...(snapshot ? { snapshot } : {}) });

test('valid facts are validated and worded by RecallReach, labelled engine-calculated or source-reported', async () => {
  const ctx = setup();
  const recon = await deliver(ctx, 'run_reconciliation'), ledger = await deliver(ctx, 'get_shipment_ledger', { shipment_id: 'RR-103' });
  const opening = ledger.data.records.find((r: { from_state: string }) => r.from_state === 'none');
  const a = check(ctx, [
    balance('RR-104', 'available', 40, 'bottles', recon.data.snapshot),
    balance('RR-103', 'dispensed', 60, 'bottle'),
    { type: 'case_total', measure: 'contained', quantity: 900, unit: 'bottles' },
    { type: 'open_issue', issue_id: 'dispensed:RR-103' },
    { type: 'record_report', record: opening.cite, shipment_id: 'RR-103', from_state: 'none', to_state: 'available', quantity: 160, unit: 'bottles' },
    { type: 'record_status', record: opening.cite, status: 'applied' },
  ]);
  assert.deepEqual(a.facts!.map(f => f.status), Array(6).fill('validated'), JSON.stringify(a.facts!.map(f => f.problems)));
  assert.deepEqual(a.facts!.map(f => f.basis), ['engine_calculated', 'engine_calculated', 'engine_calculated', 'engine_calculated', 'source_reported', 'engine_calculated']);
  assert.match(a.facts![1].statement!, /Shipment RR-103 \(Meadow Pharmacy\): 60 bottles recorded as dispensed, of 160 accepted\. Calculated by the engine/);
  assert.match(a.facts![2].statement!, /900 bottles reported contained/);
  assert.match(a.facts![3].statement!, /^Open issue, Pharmacist follow-up/);
  assert.match(a.facts![4].statement!, /reports an opening shipment into available of 160 bottles for shipment RR-103.*not proof of physical handling/);
  assert.equal(a.facts![1].unit, 'bottles', 'the stored unit is the case unit, not the spelling submitted');
  assert.deepEqual(a.facts![0].dependencies, [{ kind: 'shipment', shipment_id: 'RR-104' }]);
  assert.deepEqual(a.validated_summary, a.facts!.map(f => f.statement));
});

test('wrong shipment: a quantity that is true for another shipment is rejected', async () => {
  const ctx = setup();
  await deliver(ctx, 'run_reconciliation');
  const [f] = check(ctx, [balance('RR-104', 'dispensed', 60)]).facts!;
  assert.equal(f.status, 'rejected'); assert.match(f.problems[0], /RR-104 dispensed = 0 bottles, not 60/);
  const [g] = check(ctx, [balance('RR-105', 'available', 50)]).facts!;
  assert.equal(g.status, 'rejected'); assert.match(g.problems[0], /no accepted opening record for shipment RR-105/, 'an excluded batch has no balance');
});

test('wrong state: the right number in the wrong stock state is rejected', async () => {
  const ctx = setup();
  await deliver(ctx, 'run_reconciliation');
  const [f] = check(ctx, [balance('RR-104', 'quarantined', 40)]).facts!;
  assert.equal(f.status, 'rejected'); assert.match(f.problems[0], /quarantined = 0/);
});

test('wrong unit: no conversion or unit substitution is accepted', async () => {
  const ctx = setup();
  await deliver(ctx, 'run_reconciliation');
  const [pens, cases] = check(ctx, [balance('RR-104', 'available', 40, 'pens'), { type: 'case_total', measure: 'available', quantity: 40, unit: 'cartons' }]).facts!;
  assert.equal(pens.status, 'rejected'); assert.match(pens.problems[0], /Unit “pens” is not the case unit “bottles”/);
  assert.equal(cases.status, 'rejected');
});

test('wrong scope: a shipment number is not a case total, and a case total is not a shipment number', async () => {
  const ctx = setup();
  await deliver(ctx, 'run_reconciliation');
  const [total, shipment] = check(ctx, [{ type: 'case_total', measure: 'dispensed', quantity: 40, unit: 'bottles' }, balance('RR-101', 'available', 40)]).facts!;
  assert.equal(total.status, 'rejected'); assert.match(total.problems[0], /dispensed = 60 bottles for the case, not 40/);
  assert.equal(shipment.status, 'rejected');
});

test('stale snapshot: a fact about an earlier evidence snapshot is rejected', async () => {
  const ctx = setup();
  await deliver(ctx, 'run_reconciliation');
  const [f] = check(ctx, [balance('RR-104', 'available', 40, 'bottles', '0123456789abcdef')]).facts!;
  assert.equal(f.status, 'rejected'); assert.match(f.problems[0], /Refers to evidence snapshot 0123456789abcdef/);
});

test('not delivered: a correct balance the agent never retrieved is rejected', () => {
  const ctx = setup();
  const [f] = check(ctx, [balance('RR-104', 'available', 40)]).facts!;
  assert.equal(f.status, 'rejected'); assert.match(f.problems[0], /was not returned to the agent in this run/);
});

test('mixed clauses and unsupported summaries stay unverified interpretation; only typed facts feed the checked summary', async () => {
  const ctx = setup();
  await deliver(ctx, 'run_reconciliation');
  const a = check(ctx, [balance('RR-104', 'available', 40)], {
    summary: 'RR-104 has 40 bottles available and 60 dispensed, and all stock is accounted for.',
    interpretations: [{ text: 'RR-104 has 40 bottles available and 60 dispensed.', related: ['stock:RR-104'] }],
  });
  assert.equal(a.facts![0].status, 'validated');
  assert.equal(a.validated_summary!.length, 1); assert.doesNotMatch(a.validated_summary![0], /60/);
  assert.equal('status' in a.interpretations![0], false, 'interpretations have no validated status at all');
  assert.match(a.summary_problems.join(' '), /all stock contained/);
});

test('record facts: wrong movement, quantity, shipment or status are each rejected', async () => {
  const ctx = setup();
  const ledger = await deliver(ctx, 'get_shipment_ledger', { shipment_id: 'RR-101' });
  const opening = ledger.data.records.find((r: { from_state: string }) => r.from_state === 'none').cite;
  const facts = check(ctx, [
    { type: 'record_report', record: opening, shipment_id: 'RR-101', from_state: 'available', to_state: 'quarantined', quantity: 500, unit: 'bottles' },
    { type: 'record_report', record: opening, shipment_id: 'RR-101', from_state: 'none', to_state: 'available', quantity: 400, unit: 'bottles' },
    { type: 'record_report', record: opening, shipment_id: 'RR-104', from_state: 'none', to_state: 'available', quantity: 500, unit: 'bottles' },
    { type: 'record_status', record: opening, status: 'review' },
  ]).facts!;
  assert.deepEqual(facts.map(f => f.status), ['rejected', 'rejected', 'rejected', 'rejected']);
  assert.match(facts[0].problems[0], /reports an opening shipment into available, not a movement from available to quarantined/);
  assert.match(facts[1].problems[0], /quantity of 500, not 400/);
  assert.match(facts[2].problems[0], /about shipment RR-101, not RR-104/);
  assert.match(facts[3].problems[0], /treated E\d+ as applied, not review/);
});

test('referenced is not delivered: an issue evidence reference cannot support a record fact until retrieved', async () => {
  const ctx = setup();
  const recon = await deliver(ctx, 'run_reconciliation');
  const ref = recon.data.open_issues.find((i: { issue_id: string }) => i.issue_id === 'stock:RR-104').evidence_refs[0];
  const before = check(ctx, [{ type: 'record_status', record: ref, status: 'applied' }]).facts![0];
  assert.equal(before.status, 'rejected'); assert.match(before.problems[0], /only referenced, not returned/);
  await deliver(ctx, 'get_source_row', { cite: ref });
  assert.equal(check(ctx, [{ type: 'record_status', record: ref, status: 'applied' }]).facts![0].status, 'validated');
});

test('connected-source rows are validated as source reports, labelled MOCK, with an external dependency', async () => {
  const ctx = setup(new MockZetarisSource());
  const res = await deliver(ctx, 'query_connected_source', { source: 'pharmacy_stock_events', shipment_id: 'RR-103' });
  const x = res.data.rows[0];
  const [ok, bad] = check(ctx, [
    { type: 'source_row_report', row: x.cite, shipment_id: x.shipment_id, from_state: x.from_state || 'none', to_state: x.to_state, quantity: Number(x.quantity), unit: x.unit },
    { type: 'source_row_report', row: x.cite, shipment_id: x.shipment_id, from_state: x.from_state || 'none', to_state: x.to_state, quantity: Number(x.quantity) + 1, unit: x.unit },
  ]).facts!;
  assert.equal(ok.status, 'validated', ok.problems.join(' ')); assert.match(ok.statement!, /MOCK fixture, not a Zetaris query/); assert.match(ok.statement!, /not case evidence until an operator imports it/);
  assert.equal(ok.dependencies[0].kind, 'external');
  assert.equal(bad.status, 'rejected');
});

test('evidence requests must link to an open issue the agent retrieved', async () => {
  const ctx = setup();
  const a1 = check(ctx, [], { evidence_requests: [{ issue_id: 'stock:RR-104', description: 'A dated hold record.', would_change: 'Could move the 40 bottles out of available.' }] });
  assert.equal(a1.evidence_requests![0].linked, false); assert.match(a1.evidence_requests![0].problems[0], /not returned to the agent/);
  await deliver(ctx, 'run_reconciliation');
  const a2 = check(ctx, [], { evidence_requests: [{ issue_id: 'stock:RR-104', description: 'A dated hold record.', would_change: 'Could move the 40 bottles out of available.' }, { issue_id: 'stock:RR-999', description: 'Anything.', would_change: 'Anything at all.' }] });
  assert.deepEqual(a2.evidence_requests!.map(e => e.linked), [true, false]);
});
