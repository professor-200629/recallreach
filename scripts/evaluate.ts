// Automated fixture evaluation. Compares, on fictional scenarios with hand-written answer keys:
// - baseline: an exact-batch spreadsheet filter plus SUMIF by shipment and state;
// - engine: RecallReach's deterministic reconciliation;
// - agent (rules mode): the fixed tool-using procedure, through the same validator;
// - agent (live model): only with --live, a bounded number of runs (--runs N, default 1).
// The held-out case (eval/heldout/corvel-vials.ts) and its rubric were committed before any run.
// These are fixture results, not user research or evidence of real-world performance.
// Run: npm run eval            (no network, no model)
//      node --env-file=.dev.vars --experimental-transform-types scripts/evaluate.ts --live --runs 3 --only corvel-vials --tag <name>
// Live results are never overwritten: each live series goes to its own file, named by --tag.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { SCENARIOS, scenarioSources, toLedgerCsv, type Scenario } from '../lib/recall/sample.ts';
import { parseLedgerCsv } from '../lib/recall/csv.ts';
import { reconcileCase } from '../lib/recall/engine.ts';
import { runCaseInvestigation } from '../lib/recall/investigation.ts';
import { providerFromEnv } from '../lib/recall/agent/provider.ts';
import { CORVEL_RUBRIC, CORVEL_VIALS } from '../eval/heldout/corvel-vials.ts';
import type { AgentRun, LedgerRecord, RecallCase } from '../lib/recall/types.ts';

type Totals = { shipped: number; available: number; quarantined: number; returned: number; dispensed: number };
type MethodResult = { totals: Totals; unresolved: Record<string, number>; counted: Set<string>; answers: Record<string, unknown> };
const ALL: Record<string, { scenario: Scenario; held_out: boolean; rubric?: typeof CORVEL_RUBRIC }> = {
  ...Object.fromEntries(Object.values(SCENARIOS).map(s => [s.id, { scenario: s, held_out: false }])),
  [CORVEL_VIALS.id]: { scenario: CORVEL_VIALS, held_out: true, rubric: CORVEL_RUBRIC },
};

function caseFor(s: Scenario, suffix = ''): RecallCase {
  const now = new Date().toISOString(), { sources, records } = scenarioSources(s, now);
  return { id: `eval-${s.id}${suffix}`, name: s.name, mode: 'drill', created_at: now, version: 1, alert: { ...s.alert, description: s.description }, sources, records, audit: [], decisions: [], investigated_at: null, corrections: [], proposals: [], snapshots: [], agent_runs: [] };
}

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

function engine(c: RecallCase): MethodResult {
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
  const tp = found.filter(x => truth.includes(x) && m.unresolved[x] === key.unresolved[x]).length;
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
    unresolved_found: m.unresolved, unresolved_correct: `${tp}/${truth.length}`, unresolved_false_positives: found.filter(x => !truth.includes(x)).length,
    wrongly_counted_records: [...m.counted].filter(id => mustNotCount.has(id)).length,
    totals: m.totals, totals_correct: same(m.totals, key.totals),
    questions, questions_correct: Object.values(questions).filter(Boolean).length, questions_total: Object.keys(questions).length,
  };
}

/** Scores one agent run against the frozen key: facts, unsupported claims, evidence requests, follow-ups, cost. */
function scoreRun(s: Scenario, run: AgentRun, rubric?: typeof CORVEL_RUBRIC) {
  const a = run.answer, facts = a?.facts ?? [], ok = facts.filter(f => f.status === 'validated'), key = s.key;
  const has = (pred: string, id: string, q?: number) => ok.some(f => f.type === 'shipment_balance' && f.entity.id === id && f.predicate === pred && (q === undefined || f.quantity === q));
  const keyFacts = [
    ...Object.entries(key.unresolved).map(([id, q]) => ({ item: `${id} available ${q}`, found: has('balance.available', id, q) })),
    ...Object.entries(key.dispensed).map(([id, q]) => ({ item: `${id} dispensed ${q}`, found: has('balance.dispensed', id, q) })),
    ...key.unconfirmed_destinations.map(id => ({ item: `${id} destination unconfirmed`, found: ok.some(f => f.type === 'open_issue' && f.entity.id === `destination:${id}`) })),
  ];
  // A validated shipment balance that contradicts the key would be an unsupported claim the validator accepted.
  const unsupported = ok.filter(f => f.type === 'shipment_balance' && ((f.predicate === 'balance.available' && f.quantity !== (key.unresolved[f.entity.id] ?? 0)) || (f.predicate === 'balance.dispensed' && f.quantity !== (key.dispensed[f.entity.id] ?? 0))));
  const linked = new Set([...(a?.evidence_requests ?? []).filter(e => e.linked).map(e => e.issue_id), ...(a?.follow_ups ?? []).map(p => p.issue_id)]);
  const rubricScores = rubric?.map(item => {
    const p = (a?.follow_ups ?? []).find(f => f.issue_id === item.issue_id), text = p ? `${p.action} ${p.evidence_requested}` : '';
    return { issue_id: item.issue_id, proposed: !!p, owner_ok: p?.owner_role === item.owner, names_required: !!p && item.must_name.every(w => text.includes(w)), overreach: p?.problems.length ?? 0 };
  });
  return {
    mode: run.mode, provider: run.provider, model: run.model, status: run.status, status_detail: run.status_detail,
    limits: run.limits ?? null, duration_ms: run.duration_ms, tool_calls: run.steps.filter(x => x.tool !== 'submit_findings').length, rejected_tool_calls: run.steps.filter(x => !x.ok).length,
    model_calls: run.usage.model_calls, input_tokens: run.usage.input_tokens, output_tokens: run.usage.output_tokens, estimated_cost_usd: run.usage.estimated_cost_usd,
    facts_submitted: facts.length, facts_validated: ok.length, facts_rejected: facts.length - ok.length,
    rejected_fact_reasons: facts.filter(f => f.status === 'rejected').map(f => f.problems[0]),
    key_facts_correct: `${keyFacts.filter(k => k.found).length}/${keyFacts.length}`, key_facts: keyFacts,
    unsupported_claims_accepted: unsupported.length,
    overreach_flags: (a?.summary_problems.length ?? 0) + (a?.interpretations ?? []).reduce((n, i) => n + i.problems.length, 0),
    missing_evidence_identified: `${Object.keys(key.unresolved).filter(id => linked.has(`stock:${id}`)).length}/${Object.keys(key.unresolved).length}`,
    follow_ups_proposed: a?.follow_ups.length ?? 0,
    ...(rubricScores ? { follow_up_rubric: rubricScores, follow_up_rubric_points: `${rubricScores.reduce((n, r) => n + (r.proposed ? 1 : 0) + (r.owner_ok ? 1 : 0) + (r.names_required ? 1 : 0), 0)}/${rubricScores.length * 3}` } : {}),
  };
}

async function agentRun(s: Scenario, live: boolean, rubric?: typeof CORVEL_RUBRIC) {
  const c = caseFor(s, live ? '-live' : '-rules');
  const { provider, settings } = live ? providerFromEnv(process.env) : { provider: null, settings: null };
  if (live && !provider) return { skipped: 'No provider configured (AGENT_PROVIDER and its API key).' };
  const before = JSON.stringify(reconcileCase(c));
  // Live runs use the same time limit as the app (the provider's default, or AGENT_TIME_LIMIT_S).
  const limits = provider && settings ? { totalTimeoutMs: settings.time_limit_s * 1000 } : undefined;
  const { run } = await runCaseInvestigation({ c, memoryState: null, provider, external: null, question: s.question, actor: 'evaluation', limits });
  return { ...scoreRun(s, run, rubric), stock_unchanged_by_run: JSON.stringify(reconcileCase(c)) === before };
}

const args = process.argv.slice(2), live = args.includes('--live');
const runs = Math.max(1, Math.min(5, Number(args[args.indexOf('--runs') + 1]) || 1)), only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] ?? '' : null;
if (tag !== null && !/^[a-z0-9-]{1,40}$/.test(tag)) throw new Error('--tag must be 1 to 40 lowercase letters, digits or hyphens.');
if (only !== null && !(only in ALL)) throw new Error(`--only must be one of: ${Object.keys(ALL).join(', ')}.`);
if (!live && (tag || only)) throw new Error('--tag and --only are for live series; npm run eval with no flags regenerates the offline results.');
const file = `eval/results${live ? '-live' : ''}${only ? `-${only}` : ''}${tag ? `-${tag}` : ''}.json`;
// A recorded live series is evidence: never replace one. Only the offline file (eval/results.json) is regenerated.
if (file !== 'eval/results.json' && existsSync(file)) throw new Error(`${file} already exists. Live results are never overwritten; pass a new --tag.`);
const results: Record<string, unknown> = { generated_at: new Date().toISOString(), note: 'Automated results on fictional fixtures with hand-written answer keys. Not evidence of real-world performance.', held_out_key_commit: '1313452', ...(tag ? { series: tag } : {}), scenarios: {} };
for (const { scenario: s, held_out, rubric } of Object.values(ALL)) {
  if (only && s.id !== only) continue;
  const states: [string, RecallCase][] = [['initial', caseFor(s)]];
  if (s.followup) { const c = caseFor(s, '-f'); c.records.push(...parseLedgerCsv(toLedgerCsv(s.followup.rows), 'followup')); states.push(['after_followup', c]); }
  const entry: Record<string, unknown> = { held_out };
  for (const [label, c] of states) {
    const sc = label === 'after_followup' ? { ...s, key: { ...s.key, totals: s.key.after_followup!.totals, unresolved: s.key.after_followup!.unresolved } } : s;
    entry[label] = { baseline: score(sc, c, baseline(c)), engine: score(sc, c, engine(c)) };
  }
  entry.agent_rules_mode = await agentRun(s, false, rubric);
  if (live) {
    entry.agent_live = [];
    for (let i = 0; i < runs; i++) (entry.agent_live as unknown[]).push(await agentRun(s, true, rubric));
  }
  (results.scenarios as Record<string, unknown>)[s.id] = entry;
}
mkdirSync('eval', { recursive: true });
// 'wx' fails if the file appeared while the runs were in progress.
writeFileSync(file, JSON.stringify(results, null, 2) + '\n', { flag: file === 'eval/results.json' ? 'w' : 'wx' });
console.log(`Wrote ${file}`);
console.log(JSON.stringify(results, null, 2));
