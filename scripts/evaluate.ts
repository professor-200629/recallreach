// Automated fixture evaluation: RecallReach versus a simple batch-lookup baseline on the
// same fictional scenarios, scored against hand-written answer keys (lib/recall/sample.ts).
// These are fixture results, not user research. Run: npm run eval [-- --live]
import { mkdirSync, writeFileSync } from 'node:fs';
import { createScenarioCase, SCENARIOS, toLedgerCsv, type Scenario } from '../lib/recall/sample.ts';
import { parseLedgerCsv } from '../lib/recall/csv.ts';
import { reconcileCase } from '../lib/recall/engine.ts';
import { runCaseInvestigation } from '../lib/recall/investigation.ts';
import { providerFromEnv } from '../lib/recall/agent/provider.ts';
import type { LedgerRecord, RecallCase } from '../lib/recall/types.ts';

type Totals = { shipped: number; available: number; quarantined: number; returned: number; dispensed: number };
type MethodResult = { totals: Totals; unresolved: Record<string, number>; counted: Set<string>; answers: Record<string, unknown> };

/** Baseline: what an exact-batch spreadsheet filter plus SUMIF by shipment and state produces. */
function baseline(c: RecallCase): MethodResult {
  const rows = c.records.filter(r => r.batch === c.alert.batch), qty = (r: LedgerRecord) => Number(r.raw_quantity ?? r.quantity) || 0;
  const opened: Record<string, number> = {}, handled: Record<string, number> = {};
  const totals: Totals = { shipped: 0, available: 0, quarantined: 0, returned: 0, dispensed: 0 };
  for (const r of rows) {
    if (r.type === 'shipment') { opened[r.shipment_id] = (opened[r.shipment_id] ?? 0) + qty(r); totals.shipped += qty(r); continue; }
    if (r.to_state === 'quarantined' || r.to_state === 'returned' || r.to_state === 'dispensed') { totals[r.to_state] += qty(r); handled[r.shipment_id] = (handled[r.shipment_id] ?? 0) + qty(r); }
  }
  totals.available = totals.shipped - totals.quarantined - totals.returned - totals.dispensed;
  const unresolved = Object.fromEntries(Object.keys(opened).map(s => [s, opened[s] - (handled[s] ?? 0)]).filter(([, n]) => (n as number) > 0));
  const dispensed: Record<string, number> = {};
  for (const r of rows) if (r.to_state === 'dispensed') dispensed[r.shipment_id] = (dispensed[r.shipment_id] ?? 0) + qty(r);
  return { totals, unresolved, counted: new Set(rows.map(r => r.id)), answers: { dispensed, unconfirmed_destinations: [], review_events: [], near_miss_events: [], duplicate_events: [] } };
}

function recallreach(c: RecallCase): MethodResult {
  const r = reconcileCase(c), ev = (ids: string[]) => [...new Set(ids.map(id => c.records.find(x => x.id === id)!.event_id))].sort();
  return {
    totals: { shipped: r.shipped, available: r.available, quarantined: r.quarantined, returned: r.returned, dispensed: r.dispensed },
    unresolved: Object.fromEntries(r.shipments.filter(s => s.available > 0).map(s => [s.shipment_id, s.available])), counted: new Set(r.applied_ids),
    answers: {
      dispensed: Object.fromEntries(r.shipments.filter(s => s.dispensed > 0).map(s => [s.shipment_id, s.dispensed])),
      unconfirmed_destinations: r.issues.filter(i => i.kind === 'Destination unconfirmed').map(i => i.shipment_id).sort(),
      review_events: ev(r.review_ids), near_miss_events: ev(r.issues.filter(i => i.kind === 'Possible batch match').flatMap(i => i.evidence_ids)), duplicate_events: ev(r.duplicate_ids),
    },
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function score(s: Scenario, c: RecallCase, m: MethodResult) {
  const key = s.key, truth = Object.keys(key.unresolved), found = Object.keys(m.unresolved);
  const tp = found.filter(x => truth.includes(x)).length;
  // Rows the answer key says must not add to totals (review, outside alert, second copies of duplicates).
  const mustNotCount = new Set(c.records.filter(r => key.review_events.includes(r.event_id) || key.excluded_events.includes(r.event_id)).map(r => r.id));
  for (const e of key.duplicate_events) c.records.filter(r => r.event_id === e).slice(1).forEach(r => mustNotCount.add(r.id));
  const questions = {
    'Which shipments are unresolved, and by how much?': same(m.unresolved, key.unresolved),
    'How much was dispensed, and where?': same(m.answers.dispensed, key.dispensed),
    'Which destinations are unconfirmed?': same(m.answers.unconfirmed_destinations, [...key.unconfirmed_destinations].sort()),
    'Which records need review?': same(m.answers.review_events, [...key.review_events].sort()),
    'Which near-miss batch records need checking?': same(m.answers.near_miss_events, [...key.near_miss_events].sort()),
    'Which records are duplicates?': same(m.answers.duplicate_events, [...key.duplicate_events].sort()),
    'Are the source-reported totals correct?': same(m.totals, key.totals),
  };
  return {
    unresolved_found: m.unresolved, unresolved_precision: found.length ? tp / found.length : 1, unresolved_recall: truth.length ? tp / truth.length : 1,
    wrongly_counted_records: [...m.counted].filter(id => mustNotCount.has(id)).length,
    totals: m.totals, totals_correct: same(m.totals, key.totals),
    questions, questions_correct: Object.values(questions).filter(Boolean).length, questions_total: Object.keys(questions).length,
  };
}

async function agentRun(s: Scenario, live: boolean) {
  const c = createScenarioCase(s.id, `eval-${s.id}`, new Date().toISOString());
  const { provider } = live ? providerFromEnv(process.env) : { provider: null };
  if (live && !provider) return null;
  const { run } = await runCaseInvestigation({ c, memoryState: null, provider, external: null, question: s.question, actor: 'evaluation' });
  const a = run.answer, findings = a?.findings ?? [];
  const mentioned = Object.entries(s.key.unresolved).filter(([sid, n]) => findings.some(f => f.verification === 'verified' && f.claim.includes(sid) && new RegExp(`\\b${n}\\b`).test(f.claim))).map(([sid]) => sid);
  const citations = findings.reduce((n, f) => n + f.citations.length, 0);
  return {
    mode: run.mode, provider: run.provider, model: run.model, status: run.status, status_detail: run.status_detail,
    duration_ms: run.duration_ms, tool_calls: run.steps.filter(x => x.tool !== 'submit_findings').length, rejected_tool_calls: run.steps.filter(x => !x.ok).length,
    model_calls: run.usage.model_calls, input_tokens: run.usage.input_tokens, output_tokens: run.usage.output_tokens, estimated_cost_usd: run.usage.estimated_cost_usd,
    findings: findings.length, verified_findings: findings.filter(f => f.verification === 'verified').length,
    citations_valid: citations, citations_rejected: a?.rejected_citations.length ?? 0,
    unresolved_shipments_correctly_stated: `${mentioned.length}/${Object.keys(s.key.unresolved).length}`,
    follow_ups_proposed: a?.follow_ups.length ?? 0,
  };
}

const live = process.argv.includes('--live');
const results: Record<string, unknown> = { generated_at: new Date().toISOString(), note: 'Automated results on fictional fixtures with hand-written answer keys. Not evidence of real-world performance.', scenarios: {} };
for (const s of Object.values(SCENARIOS)) {
  const states: [string, RecallCase][] = [['initial', createScenarioCase(s.id, `eval-${s.id}`, new Date().toISOString())]];
  if (s.followup) { const c = createScenarioCase(s.id, `eval-${s.id}-f`, new Date().toISOString()); c.records.push(...parseLedgerCsv(toLedgerCsv(s.followup.rows), 'followup')); states.push(['after_followup', c]); }
  const entry: Record<string, unknown> = {};
  for (const [label, c] of states) {
    const sc = label === 'after_followup' ? { ...s, key: { ...s.key, totals: s.key.after_followup!.totals, unresolved: s.key.after_followup!.unresolved } } : s;
    entry[label] = { baseline: score(sc, c, baseline(c)), recallreach: score(sc, c, recallreach(c)) };
  }
  entry.agent_rules_mode = await agentRun(s, false);
  if (live) entry.agent_live = await agentRun(s, true);
  (results.scenarios as Record<string, unknown>)[s.id] = entry;
}
mkdirSync('eval', { recursive: true });
writeFileSync(`eval/results${live ? '-live' : ''}.json`, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
