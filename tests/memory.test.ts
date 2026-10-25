import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createScenarioCase, FOLLOWUP_CSV, SCENARIOS } from '../lib/recall/sample.ts';
import { parseLedgerCsv } from '../lib/recall/csv.ts';
import { reconcileCase } from '../lib/recall/engine.ts';
import { CaseMemory, MEMORY_ENGINE } from '../lib/recall/memory/hmem.ts';
import { rememberDecision, revalidateMemory, runCaseInvestigation } from '../lib/recall/investigation.ts';
import type { RecallCase } from '../lib/recall/types.ts';

const NOW = '2026-10-24T00:00:00Z';
const addFollowUp = (c: RecallCase) => { c.records.push(...parseLedgerCsv(FOLLOWUP_CSV, 'followup')); c.sources.push({ id: 'followup', name: 'Training follow-up.csv', kind: 'sample', content: FOLLOWUP_CSV, added_at: NOW, row_count: 1 }); };

test('vendored Meterless H-MEM files match the recorded upstream hashes', () => {
  const sums = readFileSync(new URL('../vendor/meterless-hmem/SHA256SUMS', import.meta.url), 'utf8').trim().split('\n');
  assert.equal(sums.length, 10);
  for (const line of sums) {
    const [hash, file] = line.split(/\s+\*?/);
    // Hashes are of the upstream git blobs (LF line endings); normalise in case a checkout converted them.
    const text = readFileSync(new URL(`../vendor/meterless-hmem/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(text).digest('hex'), hash, file);
  }
});

test('memory state survives a save and reload, including the trust ledger', () => {
  const c = createScenarioCase('missing-40', 'm1', NOW), r = reconcileCase(c);
  const a = new CaseMemory(c.id, 'tester', null);
  a.remember({ content: 'Shipment RR-104 has 40 bottles awaiting containment.', kind: 'finding', confidence: 0.6, source: 'test', label: 'test', origin: 'document', refs: [c.records[3].id], shipments: ['RR-104'], review: 'unreviewed' }, { c, r });
  a.recall('40 bottles RR-104', { c, r });
  const restored = new CaseMemory(c.id, 'tester', JSON.parse(JSON.stringify(a.toState())));
  assert.equal(JSON.stringify(restored.toState()), JSON.stringify(a.toState()), 'stored form is identical after reload');
  assert.equal(restored.list({ c, r })[0].validity, 'current');
  assert.deepEqual(restored.ledgerSummary().by_action, { create: 1, read: 1 });
  assert.throws(() => new CaseMemory(c.id, 't', { ...a.toState(), engine: 'something-else' }), /written by something-else/);
});

test('new evidence invalidates the earlier conclusion; it is superseded by a recheck note that keeps its text', async () => {
  const c = createScenarioCase('missing-40', 'm2', NOW);
  const first = await runCaseInvestigation({ c, memoryState: null, provider: null, external: null, question: SCENARIOS['missing-40'].question, actor: 'QA' });
  const before = new CaseMemory(c.id, 'QA', first.memoryState).list({ c, r: reconcileCase(c) });
  const about104 = before.filter(m => m.shipments.includes('RR-104'));
  const about103 = before.filter(m => m.shipments.includes('RR-103') && !m.shipments.includes('RR-104'));
  assert.ok(about104.length > 0);

  addFollowUp(c);
  const { state, invalidated } = revalidateMemory(c, first.memoryState, 'QA', 'new evidence was imported');
  assert.equal(invalidated, about104.length, 'only memories about the changed shipment are invalidated');
  const after = new CaseMemory(c.id, 'QA', state).list({ c, r: reconcileCase(c) });
  for (const old of about104) {
    const now = after.find(m => m.memory_id === old.memory_id)!;
    assert.equal(now.validity, 'superseded'); assert.equal(now.content, old.content, 'original text is preserved');
  }
  for (const m of about103) assert.equal(after.find(x => x.memory_id === m.memory_id)!.validity, 'current');
  assert.equal(after.filter(m => m.kind === 'recheck').length, about104.length);

  const second = await runCaseInvestigation({ c, memoryState: state, provider: null, external: null, question: 'What changed after the new evidence, and what is still open?', actor: 'QA' });
  const recalled = second.run.steps.find(s => s.tool === 'recall_memory')!;
  assert.match(recalled.summary, /\d+ memories/);
  assert.equal(second.run.answer!.interpretations!.some(i => /recheck|stale|superseded/.test(i.text)), true, 'later run reports the recheck instead of reusing the old conclusion');
  assert.equal(second.run.answer!.facts!.some(f => f.status === 'validated' && f.entity.id === 'RR-104' && f.predicate === 'balance.available'), false, 'the old 40-bottle balance is not restated');
  assert.equal(reconcileCase(c).available, 0, 'stock comes from records, never from memory');
});

test('operator decisions are remembered as long-term, operator-approved memories', () => {
  const c = createScenarioCase('missing-40', 'm3', NOW);
  const state = rememberDecision(c, null, 'Coordinator', 'Coordinator approved follow-up for stock:RR-104.', ['stock:RR-104']);
  const [m] = new CaseMemory(c.id, 'x', state).list({ c, r: reconcileCase(c) });
  assert.equal(m.kind, 'decision'); assert.equal(m.review, 'operator-approved'); assert.deepEqual(m.shipments, ['RR-104']);
  assert.equal(state.records[0].layer, 'long_term');
  assert.equal(state.engine, MEMORY_ENGINE);
});

test('contradictory memories are both kept and reported by H-MEM conflict detection', () => {
  const c = createScenarioCase('missing-40', 'm4', NOW), r = reconcileCase(c), mem = new CaseMemory(c.id, 't', null);
  const base = { kind: 'finding' as const, confidence: 0.6, source: 'test', label: 'test', origin: 'document' as const, refs: [], shipments: [], review: 'unreviewed' as const };
  const a = mem.remember({ ...base, content: 'Shipment RR-104 has 40 bottles awaiting containment at the pending destination.' }, { c, r });
  const b = mem.remember({ ...base, content: 'Shipment RR-104 has 0 bottles awaiting containment at the pending destination.' }, { c, r });
  assert.equal(mem.scanContradictions(), 1);
  assert.deepEqual(mem.contradictions().map(x => [x.a, x.b].sort()), [[a.id, b.id].sort()]);
  assert.equal(mem.list({ c, r }).length, 2, 'neither memory was overwritten or deleted');
  assert.equal(mem.list({ c, r }).every(m => m.validity !== 'superseded'), true, 'detection never auto-resolves');
});
