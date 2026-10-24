import type { AgentRun, RecallCase, Reconciliation } from './types.ts';
import { reconcileCase } from './engine.ts';
import { recordSnapshot, takeSnapshot } from './snapshot.ts';
import { appendAudit } from './audit.ts';
import { CaseMemory, type MemoryState } from './memory/hmem.ts';
import type { ExternalSource } from './sources/external.ts';
import type { ChatProvider } from './agent/provider.ts';
import { createContext } from './agent/tools.ts';
import { investigate, type Limits } from './agent/runner.ts';

const RUN_LIMIT = 10;

export type InvestigationInput = {
  c: RecallCase; memoryState: MemoryState | null; provider: ChatProvider | null; external: ExternalSource | null;
  question: string; actor: string; limits?: Partial<Limits>; now?: () => number;
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

/** Runs one investigation and applies its effects to the case and its memory. Stock is never changed here. */
export async function runCaseInvestigation(input: InvestigationInput): Promise<{ c: RecallCase; memoryState: MemoryState; run: AgentRun }> {
  const now = input.now ?? Date.now, c = input.c, r = reconcileCase(c, now());
  const memory = new CaseMemory(c.id, `recallreach:${input.actor}`, input.memoryState, now);
  const evidence = { c, r };
  const invalidated = memory.revalidate(evidence, 'evidence changed before this run');
  const previous = c.snapshots.at(-1);
  const current = takeSnapshot(c, r, input.provider ? 'agent-live' : 'agent-rules', input.actor, null, new Date(now()).toISOString());
  const ctx = createContext({ c, r, memory, external: input.external, previous, current });
  const run = await investigate({ question: input.question, ctx, provider: input.provider, actor: input.actor, limits: input.limits, now });

  current.run_id = run.id;
  recordSnapshot(c, current);
  const at = run.finished_at;
  for (const f of run.answer?.follow_ups ?? []) c.proposals.push({ id: crypto.randomUUID(), run_id: run.id, issue_id: f.issue_id, created_at: at, action: f.action, owner_role: f.owner_role, evidence_requested: f.evidence_requested, citations: f.citations, status: 'proposed' });

  // Only verified statements become memory; unverified ones stay visible in the run but are not remembered.
  let stored = 0;
  const existing = new Set(memory.list(evidence).filter(m => m.validity === 'current').map(m => m.content));
  const source = `recallreach:run:${run.id}:${run.mode}`, origin = run.mode === 'live' ? 'model_response' as const : 'document' as const;
  for (const f of run.answer?.findings ?? []) {
    if (f.verification !== 'verified' || existing.has(f.claim)) continue;
    memory.remember({ content: f.claim, kind: 'finding', confidence: 0.6, source, origin, label: `${run.mode} run ${run.id.slice(0, 8)}: unreviewed finding`, refs: f.citations.filter(id => c.records.some(x => x.id === id)), shipments: shipmentsFor(f.citations, c, r), review: 'unreviewed' }, evidence);
    stored++;
  }
  for (const m of run.answer?.missing_evidence ?? []) {
    const content = `Open question: ${m.description} Would resolve: ${m.would_resolve}`;
    if (m.verification !== 'verified' || existing.has(content)) continue;
    memory.remember({ content, kind: 'question', confidence: 0.5, source, origin, label: `${run.mode} run ${run.id.slice(0, 8)}: open question`, refs: m.citations.filter(id => c.records.some(x => x.id === id)), shipments: shipmentsFor(m.citations, c, r), review: 'unreviewed' }, evidence);
    stored++;
  }
  if (stored) memory.scanContradictions();
  run.memory.stored = stored; run.memory.invalidated = invalidated;

  c.agent_runs = [...c.agent_runs, run].slice(-RUN_LIMIT);
  c.investigated_at = at;
  const verified = run.answer?.findings.filter(f => f.verification === 'verified').length ?? 0;
  await appendAudit(c, input.actor, run.mode === 'live' ? 'Agent investigation run' : 'Rules investigation run',
    `${run.mode === 'live' ? `${run.provider} ${run.model}` : 'Rules mode (no language model)'}: ${run.status}. ${run.steps.length} tool steps, ${verified}/${run.answer?.findings.length ?? 0} findings verified, ${run.answer?.follow_ups.length ?? 0} follow-ups proposed. Evidence fingerprint ${current.fingerprint}. Stock balances unchanged.`);
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
  memory.remember({ content: text, kind: 'decision', confidence: 0.9, source: `recallreach:decision:${actor}`, label: `Operator decision by ${actor}`, origin: 'manual', refs: refs.filter(id => c.records.some(x => x.id === id)), shipments: shipmentsFor(refs, c, r), review: 'operator-approved' }, { c, r });
  return memory.toState();
}
