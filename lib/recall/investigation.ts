import type { AgentRun, FactDependency, FactType, RecallCase, Reconciliation } from './types.ts';
import { reconcileCase } from './engine.ts';
import { recordSnapshot, takeSnapshot } from './snapshot.ts';
import { appendAudit } from './audit.ts';
import { CaseMemory, type MemoryState } from './memory/hmem.ts';
import type { ExternalSource } from './sources/external.ts';
import type { ChatProvider } from './agent/provider.ts';
import { createContext } from './agent/tools.ts';
import { investigate, type Limits } from './agent/runner.ts';

const RUN_LIMIT = 10;
/** Fact types worth remembering. Changes since the previous run describe the run itself and are not kept. */
const REMEMBERED: ReadonlySet<FactType> = new Set(['shipment_balance', 'case_total', 'record_report', 'record_status', 'open_issue', 'source_row_report']);

export type InvestigationInput = {
  c: RecallCase; memoryState: MemoryState | null; provider: ChatProvider | null; external: ExternalSource | null;
  question: string; actor: string; limits?: Partial<Limits>; now?: () => number;
  /** Timer used for the run deadline (tests pass a fake one). */
  schedule?: (ms: number, fn: () => void) => () => void;
};

/** Shipments a cited ID refers to: record IDs map to their shipment, issue IDs carry it after the colon. */
function shipmentsFor(ids: string[], c: RecallCase, r: Reconciliation): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const row = c.records.find(x => x.id === id);
    if (row?.shipment_id) out.add(row.shipment_id);
    const issue = r.issues.find(i => i.id === id);
    if (issue?.shipment_id) out.add(issue.shipment_id);
  }
  return [...out];
}
const shipmentsOf = (deps: FactDependency[]) => deps.flatMap(d => d.kind === 'shipment' ? [d.shipment_id] : []);

/** Runs one investigation and applies its effects to the case and its memory. Stock is never changed here. */
export async function runCaseInvestigation(input: InvestigationInput): Promise<{ c: RecallCase; memoryState: MemoryState; run: AgentRun }> {
  const now = input.now ?? Date.now, c = input.c, r = reconcileCase(c, now());
  const memory = new CaseMemory(c.id, `recallreach:${input.actor}`, input.memoryState, now);
  const evidence = { c, r };
  const invalidated = memory.revalidate(evidence, 'evidence changed before this run');
  const previous = c.snapshots.at(-1);
  const current = takeSnapshot(c, r, input.provider ? 'agent-live' : 'agent-rules', input.actor, null, new Date(now()).toISOString());
  const ctx = createContext({ c, r, memory, external: input.external, previous, current });
  const run = await investigate({ question: input.question, ctx, provider: input.provider, actor: input.actor, limits: input.limits, now, schedule: input.schedule });

  current.run_id = run.id;
  recordSnapshot(c, current);
  const at = run.finished_at;
  for (const f of run.answer?.follow_ups ?? []) c.proposals.push({ id: crypto.randomUUID(), run_id: run.id, issue_id: f.issue_id, created_at: at, action: f.action, owner_role: f.owner_role, evidence_requested: f.evidence_requested, citations: f.citations, status: 'proposed' });

  // Only validated facts become memory: RecallReach's own wording plus the evidence each depends on.
  // The agent's summary, interpretations and evidence requests stay visible in the run but are not remembered.
  let stored = 0;
  const existing = new Set(memory.list(evidence).filter(m => m.validity === 'current' || m.validity === 'unknown').map(m => m.content));
  const source = `recallreach:run:${run.id}:${run.mode}`, origin = run.mode === 'live' ? 'model_response' as const : 'document' as const;
  for (const f of run.answer?.facts ?? []) {
    if (f.status !== 'validated' || !f.statement || !REMEMBERED.has(f.type) || existing.has(f.statement)) continue;
    memory.remember({ content: f.statement, kind: f.type === 'open_issue' ? 'question' : 'finding', confidence: 0.6, source, origin,
      label: `${run.mode} run ${run.id.slice(0, 8)}: validated ${f.type.replace(/_/g, ' ')}`, refs: f.evidence.filter(id => c.records.some(x => x.id === id)),
      shipments: shipmentsOf(f.dependencies), review: 'unreviewed', deps: f.dependencies }, evidence);
    existing.add(f.statement);
    stored++;
  }
  if (stored) memory.scanContradictions();
  run.memory.stored = stored; run.memory.invalidated = invalidated;

  c.agent_runs = [...c.agent_runs, run].slice(-RUN_LIMIT);
  c.investigated_at = at;
  const facts = run.answer?.facts ?? [], validated = facts.filter(f => f.status === 'validated').length;
  await appendAudit(c, input.actor, run.mode === 'live' ? 'Agent investigation run' : 'Rules investigation run',
    `${run.mode === 'live' ? `${run.provider} ${run.model}` : 'Rules mode (no language model)'}: ${run.status}. ${run.steps.length} tool steps, ${validated}/${facts.length} typed facts validated, ${run.answer?.follow_ups.length ?? 0} follow-ups proposed. Evidence fingerprint ${current.fingerprint}. Stock balances unchanged.`);
  return { c, memoryState: memory.toState(), run };
}

/** After evidence changes, marks memories whose evidence moved as needing a recheck. */
export function revalidateMemory(c: RecallCase, state: MemoryState | null, actor: string, cause: string, now: () => number = Date.now): { state: MemoryState | null; invalidated: number } {
  if (!state) return { state, invalidated: 0 };
  const memory = new CaseMemory(c.id, `recallreach:${actor}`, state, now);
  const invalidated = memory.revalidate({ c, r: reconcileCase(c, now()) }, cause);
  return { state: memory.toState(), invalidated };
}

/** Records an operator decision as long-term memory so later runs can see who approved what. */
export function rememberDecision(c: RecallCase, state: MemoryState | null, actor: string, text: string, refs: string[], now: () => number = Date.now): MemoryState {
  const memory = new CaseMemory(c.id, `recallreach:${actor}`, state, now), r = reconcileCase(c, now());
  const records = refs.filter(id => c.records.some(x => x.id === id)), shipments = shipmentsFor(refs, c, r);
  const deps: FactDependency[] = [...records.map(record_id => ({ kind: 'record' as const, record_id })), ...shipments.map(shipment_id => ({ kind: 'shipment' as const, shipment_id }))];
  memory.remember({ content: text, kind: 'decision', confidence: 0.9, source: `recallreach:decision:${actor}`, label: `Operator decision by ${actor}`, origin: 'manual', refs: records, shipments, review: 'operator-approved', deps }, { c, r });
  return memory.toState();
}
