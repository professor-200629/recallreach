import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioCase } from '../lib/recall/sample.ts';
import { reconcileCase } from '../lib/recall/engine.ts';
import { takeSnapshot } from '../lib/recall/snapshot.ts';
import { collectDelivered, createContext, serializeForModel } from '../lib/recall/agent/tools.ts';
import { investigate } from '../lib/recall/agent/runner.ts';
import { ScriptedProvider, turn, type ChatMessage } from '../lib/recall/agent/provider.ts';
import { CaseMemory, RECORD_LIMIT } from '../lib/recall/memory/hmem.ts';
import { MockZetarisSource } from '../lib/recall/sources/mock.ts';
import { readAll, type ExternalSourceKey } from '../lib/recall/sources/external.ts';
import { importExternal } from '../lib/recall/actions.ts';
import { runCaseInvestigation } from '../lib/recall/investigation.ts';

// Regression tests for failures reported by external reviews. Each was first reproduced against the
// old free-text design (where these assertions failed); the typed-fact design is what makes them pass.
const NOW = '2026-10-24T00:00:00Z', LATER = '2026-10-24T01:00:00Z', LATEST = '2026-10-24T02:00:00Z';
const lastTool = (m: ChatMessage[]) => JSON.parse([...m].reverse().find(x => x.role === 'tool')!.content as string);
const submit = (facts: unknown[], extra: Record<string, unknown> = {}) => turn([['submit_findings', { summary: 'Scripted summary for testing.', facts, interpretations: [], evidence_requests: [], ...extra }]]);
function setup(memory: CaseMemory | null = null) {
  const c = createScenarioCase('missing-40', 'trust', NOW), r = reconcileCase(c);
  return createContext({ c, r, memory, external: null, previous: undefined, current: takeSnapshot(c, r, 'agent-live', 'T', null, NOW) });
}
const scripted = (ctx: ReturnType<typeof setup>, steps: ConstructorParameters<typeof ScriptedProvider>[0]) =>
  investigate({ question: 'Why are 40 bottles unresolved?', ctx, provider: new ScriptedProvider(steps), actor: 'T', sleep: async () => {} });

test('reported: "RR-104 has 60 bottles dispensed" is rejected even though 60 dispensed appears elsewhere in the case', async () => {
  const ctx = setup();
  const result = await scripted(ctx, [
    () => turn([['run_reconciliation', { purpose: 'balances' }], ['get_shipment_ledger', { purpose: 'RR-104', shipment_id: 'RR-104' }]]),
    () => turn([['propose_follow_up', { issue_id: 'stock:RR-104', action: 'Ask the distributor for proof of delivery.', owner_role: 'distributor', evidence_requested: 'Proof of delivery', citations: ['stock:RR-104'] }]]),
    () => submit([{ type: 'shipment_balance', shipment_id: 'RR-104', state: 'dispensed', quantity: 60, unit: 'bottles' }, { type: 'shipment_balance', shipment_id: 'RR-103', state: 'dispensed', quantity: 60, unit: 'bottles' }],
      { summary: 'Shipment RR-104 has 60 bottles dispensed.' }),
  ]);
  const rr104 = ctx.r.shipments.find(s => s.shipment_id === 'RR-104')!;
  assert.deepEqual([rr104.quantity, rr104.available, rr104.dispensed], [40, 40, 0], 'fixture as reported');
  const [wrong, control] = result.answer!.facts!;
  assert.equal(wrong.status, 'rejected'); assert.match(wrong.problems.join(' '), /RR-104 dispensed = 0 bottles, not 60/);
  assert.equal(control.status, 'validated', 'the same number for the shipment it belongs to is accepted');
  assert.equal(result.answer!.validated_summary!.some(s => s.includes('RR-104') && s.includes('60')), false, 'the false claim never reaches the checked summary');
});

test('reported: handles a recalled memory names cannot support a fact until the records are retrieved', async () => {
  const c = createScenarioCase('missing-40', 'mem-bypass', NOW), r = reconcileCase(c);
  const memory = new CaseMemory(c.id, 'T', null, () => Date.parse(NOW));
  const opening = c.records.find(x => x.shipment_id === 'RR-104' && x.type === 'shipment')!;
  const m = memory.remember({ content: 'Shipment RR-104 destination is pending confirmation.', kind: 'finding', confidence: 0.6, source: 's', origin: 'model_response', label: 'l', refs: [opening.id], shipments: ['RR-104'], review: 'unreviewed', deps: [{ kind: 'record', record_id: opening.id }] }, { c, r });
  memory.feedback(m.id, 'wrong');
  const ctx = createContext({ c, r, memory, external: null, previous: undefined, current: takeSnapshot(c, r, 'agent-live', 'T', null, NOW) });
  let cite = '';
  const result = await scripted(ctx, [
    () => turn([['recall_memory', { purpose: 'earlier notes', query: 'RR-104 destination' }]]),
    msgs => { cite = lastTool(msgs).data.memories[0].referenced_records[0]; return submit([
      { type: 'record_report', record: cite, shipment_id: 'RR-104', from_state: 'none', to_state: 'available', quantity: 40, unit: 'bottles' },
      { type: 'record_status', record: cite, status: 'applied' },
    ], { interpretations: [{ text: 'An earlier note says the destination is pending.', related: [m.id] }] }); },
  ]);
  const [report, status] = result.answer!.facts!;
  assert.equal(report.status, 'rejected'); assert.match(report.problems[0], /only referenced, not returned/);
  assert.equal(status.status, 'rejected');
  assert.match(result.answer!.interpretations![0].problems.join(' '), /marked wrong/);
});

test('reported: a fact that rests only on connected-source rows is "unknown" in memory until the source is read again, then current or stale', async () => {
  const c = createScenarioCase('missing-40', 'ext-deps', NOW);
  const provider = new ScriptedProvider([
    () => turn([['query_connected_source', { purpose: 'unimported rows', source: 'pharmacy_stock_events', shipment_id: 'RR-103' }]]),
    msgs => { const x = lastTool(msgs).data.rows[0]; return submit([{ type: 'source_row_report', row: x.cite, shipment_id: x.shipment_id, from_state: x.from_state || 'none', to_state: x.to_state, quantity: Number(x.quantity), unit: x.unit }]); },
  ]);
  const out = await runCaseInvestigation({ c, memoryState: null, provider, external: new MockZetarisSource(), question: 'q', actor: 'T', now: () => Date.parse(NOW) });
  const list = (state = out.memoryState) => new CaseMemory(c.id, 'T', state).list({ c, r: reconcileCase(c) });
  const [mem] = list();
  assert.equal(out.run.answer!.facts![0].status, 'validated');
  assert.equal(mem.validity, 'unknown', mem.validity_reason); assert.match(mem.validity_reason, /has not been read again at the source/);
  assert.equal(mem.dependencies[0].kind, 'external');

  // A complete read later returns the row unchanged: the memory is now current.
  const read = await readAll(new MockZetarisSource(), 'pharmacy_stock_events', { batch: c.alert.batch });
  assert.ok(read.ok);
  await importExternal(c, read, { batch: c.alert.batch }, 'T', LATER);
  assert.equal(list()[0].validity, 'current', list()[0].validity_reason);

  // The same row then changes at the source: the memory is stale and a recheck supersedes it.
  class Changed extends MockZetarisSource {
    async query(...args: Parameters<MockZetarisSource['query']>) {
      const res = await super.query(...args);
      if (res.ok) res.rows = res.rows.map(row => row.row_key === (mem.dependencies[0] as { row_key: string }).row_key ? { ...row, values: { ...row.values, quantity: String(Number(row.values.quantity) + 1) } } : row);
      return res;
    }
  }
  const changed = await readAll(new Changed(), 'pharmacy_stock_events' as ExternalSourceKey, { batch: c.alert.batch });
  assert.ok(changed.ok);
  await importExternal(c, changed, { batch: c.alert.batch }, 'T', LATEST);
  assert.equal(list()[0].validity, 'stale');
  const memory = new CaseMemory(c.id, 'T', out.memoryState);
  assert.equal(memory.revalidate({ c, r: reconcileCase(c) }, 'source row changed'), 1);
});

test('reported: memories written before dependencies existed, with nothing to check, are never shown as current', () => {
  const c = createScenarioCase('missing-40', 'legacy', NOW), r = reconcileCase(c), memory = new CaseMemory(c.id, 'T', null);
  memory.remember({ content: 'The connected pharmacy source has a record for RR-103.', kind: 'finding', confidence: 0.6, source: 's', origin: 'model_response', label: 'l', refs: [], shipments: [], review: 'unreviewed' }, { c, r });
  const [m] = memory.list({ c, r });
  assert.equal(m.validity, 'unknown'); assert.match(m.validity_reason, /No evidence dependencies were recorded/);
});

test('reported: memory retention is bounded and what was dropped is counted, not hidden', () => {
  const c = createScenarioCase('missing-40', 'retention', NOW), r = reconcileCase(c), memory = new CaseMemory(c.id, 'T', null);
  for (let i = 0; i < RECORD_LIMIT + 15; i++) memory.remember({ content: `Note ${i} about shipment RR-104.`, kind: 'finding', confidence: 0.6, source: 's', origin: 'document', label: 'l', refs: [], shipments: ['RR-104'], review: 'unreviewed', deps: [{ kind: 'shipment', shipment_id: 'RR-104' }] }, { c, r });
  const state = memory.toState();
  assert.equal(state.records.length, RECORD_LIMIT); assert.equal(state.records_dropped, 15);
  const restored = new CaseMemory(c.id, 'T', state), summary = restored.ledgerSummary();
  assert.deepEqual([summary.records, summary.records_dropped, summary.record_limit], [RECORD_LIMIT, 15, RECORD_LIMIT]);
  assert.equal(restored.list({ c, r }).some(m => m.content === 'Note 0 about shipment RR-104.'), false, 'the oldest memories are the ones dropped');
});

test('reported: an oversized tool result is never cut into invalid JSON, and omitted items are counted and not delivered', () => {
  const ctx = setup();
  const records = Array.from({ length: 30 }, (_, i) => { ctx.handles.set(`E${i + 1}`, `rec-${i}`); return { cite: `E${i + 1}`, event_id: `ev-${i}`, text: 'y'.repeat(500) }; });
  const text = serializeForModel({ ok: true, summary: 's', record_ids: [], data: { note: 'x'.repeat(20_000), records } });
  const parsed = JSON.parse(text);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.data.records.length + parsed.data.records_omitted, 30, 'the model is told how many records it did not receive');
  collectDelivered('search_records', text, ctx);
  assert.equal(ctx.delivered.records.size, parsed.data.records.length, 'only records actually in the text count as delivered');
  for (const shape of [{ deep: { deeper: Array.from({ length: 200 }, () => ({ s: 'z'.repeat(300) })) } }, 'q'.repeat(50_000), Array.from({ length: 5000 }, (_, i) => i)])
    assert.doesNotThrow(() => JSON.parse(serializeForModel({ ok: true, summary: 'big', record_ids: [], data: shape })));
});
