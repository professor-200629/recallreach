import { HMEM } from '../../../vendor/meterless-hmem/src/index.ts';
import type { LedgerEntry, MemoryRecord } from '../../../vendor/meterless-hmem/src/types.ts';
import type { FactDependency, RecallCase, Reconciliation } from '../types.ts';
import { evidenceFingerprint, hash64, recordsFingerprint, shipmentFingerprint } from '../snapshot.ts';
import { rowIdentity } from '../sources/external.ts';

// Memory for one case, backed by the vendored Meterless H-MEM reference engine.
// RecallReach adds evidence dependencies and validity checks; ranking, the trust ledger,
// supersession lineage and conflict detection are H-MEM's own code.
export const MEMORY_ENGINE = 'meterless-hmem-reference@1742dec';
/** Retention per case. Older entries are dropped and counted; the counts are shown to the operator. */
export const RECORD_LIMIT = 200, LEDGER_LIMIT = 800;

export type MemoryState = { engine: string; seq: number; records: MemoryRecord[]; ledger: LedgerEntry[]; ledger_dropped: number; records_dropped?: number; save_token?: string };
export type MemoryKind = 'finding' | 'question' | 'decision' | 'recheck';
/** unknown: its dependencies cannot be checked (none were recorded, or connected-source evidence has not been re-checked at the source). */
export type MemoryValidity = 'current' | 'stale' | 'superseded' | 'unknown';
export type RecalledMemory = {
  memory_id: string; content: string; kind: MemoryKind; review: string; confidence: number; created_at: string;
  source: string; cites: string[]; shipments: string[]; dependencies: FactDependency[]; validity: MemoryValidity; validity_reason: string; relevance: number;
  /** An operator marked it wrong (H-MEM "wrong" feedback adds the review tag and lowers confidence). */
  disputed: boolean;
};
export type RememberInput = {
  content: string; kind: MemoryKind; confidence: number; source: string; label: string;
  origin: 'model_response' | 'manual' | 'document'; refs: string[]; shipments: string[];
  review: 'unreviewed' | 'operator-approved'; supersedes?: string;
  /** What the remembered statement depends on. Without any, the memory is shown as unknown, never current. */
  deps?: FactDependency[];
};

type Evidence = { c: Pick<RecallCase, 'records' | 'corrections' | 'source_observations' | 'scope_observations'>; r: Reconciliation };
const tagValue = (m: MemoryRecord, prefix: string) => m.tags.filter(t => t.startsWith(prefix)).map(t => t.slice(prefix.length));

// Dependencies are stored in H-MEM's provenance refs with a "dep:" prefix. Memories written before
// dependencies existed have plain record IDs there (plus shipment tags) and keep working.
const DEP = 'dep:';
const encodeDep = (d: FactDependency) => DEP + (d.kind === 'case' ? 'case' : d.kind === 'shipment' ? `shipment:${d.shipment_id}` : d.kind === 'record' ? `record:${d.record_id}` : `external:${JSON.stringify(d)}`);
function decodeDep(ref: string): FactDependency | null {
  const s = ref.slice(DEP.length);
  if (s === 'case') return { kind: 'case' };
  if (s.startsWith('shipment:')) return { kind: 'shipment', shipment_id: s.slice(9) };
  if (s.startsWith('record:')) return { kind: 'record', record_id: s.slice(7) };
  if (s.startsWith('external:')) { try { const d = JSON.parse(s.slice(9)); return d?.kind === 'external' ? d : null; } catch { return null; } }
  return null;
}
/** All dependencies of a memory: explicit ones, or (for older memories) its cited records and shipment tags. */
export function dependenciesOf(m: Pick<MemoryRecord, 'provenance' | 'tags'>): FactDependency[] {
  const refs = m.provenance.refs ?? [], explicit = refs.filter(r => r.startsWith(DEP)).map(decodeDep).filter((d): d is FactDependency => !!d);
  if (explicit.length) return explicit;
  return [...refs.map(record_id => ({ kind: 'record' as const, record_id })), ...m.tags.filter(t => t.startsWith('shipment:')).map(t => ({ kind: 'shipment' as const, shipment_id: t.slice(9) }))];
}

/** Fingerprint of the case evidence a memory depends on. Connected-source rows are checked separately. */
export function memoryFingerprint({ c, r }: Evidence, refs: string[], shipments: string[], deps?: FactDependency[]): string {
  if (!deps) return hash64([recordsFingerprint(c, r, refs), ...[...new Set(shipments)].sort().map(s => `${s}:${shipmentFingerprint(c, r, s)}`)].join('\n'));
  return hash64(deps.filter(d => d.kind !== 'external').map(d => d.kind === 'case' ? `case:${evidenceFingerprint(c, r)}` : d.kind === 'shipment' ? `shipment:${d.shipment_id}:${shipmentFingerprint(c, r, d.shipment_id)}` : `record:${recordsFingerprint(c, r, [(d as { record_id: string }).record_id])}`).sort().join('\n'));
}

/** Whether connected-source evidence captured at one time is still what the source returned later. */
function externalValidity(d: Extract<FactDependency, { kind: 'external' }>, c: Evidence['c']): { validity: 'current' | 'stale' | 'unknown'; reason: string } {
  // A complete read of the whole batch also covers a narrower (per-shipment) query.
  const seen = c.source_observations?.[rowIdentity(d.instance, d.table, d.row_key)];
  const scope = [d.query_scope, d.query_scope.replace(/\|shipment=.*$/, '')].map(k => c.scope_observations?.[k]).filter((x): x is { observed_at: string; rows: number } => !!x)
    .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0];
  const captured = Date.parse(d.captured_at);
  if (seen && Date.parse(seen.seen_at) > captured) return seen.hash === d.content_hash
    ? { validity: 'current', reason: `Zetaris row ${d.row_key} was read again at ${seen.seen_at} and is unchanged.` }
    : { validity: 'stale', reason: `Zetaris row ${d.row_key} changed at the source after this was written.` };
  if (scope && Date.parse(scope.observed_at) > captured && (!seen || Date.parse(seen.seen_at) < Date.parse(scope.observed_at)))
    return { validity: 'stale', reason: `A complete read at ${scope.observed_at} no longer returned Zetaris row ${d.row_key}.` };
  return { validity: 'unknown', reason: `Depends on Zetaris row ${d.row_key} as captured at ${d.captured_at}; it has not been read again at the source since.` };
}

/** A recheck note depends on what the source shows now: changed rows at their new content, rows no longer returned are dropped. */
function refreshDependencies(deps: FactDependency[], c: Evidence['c']): FactDependency[] {
  return deps.flatMap((d): FactDependency[] => {
    if (d.kind !== 'external') return [d];
    const seen = c.source_observations?.[rowIdentity(d.instance, d.table, d.row_key)];
    if (seen && Date.parse(seen.seen_at) > Date.parse(d.captured_at)) return [{ ...d, content_hash: seen.hash, captured_at: seen.seen_at }];
    return [];
  });
}

export class CaseMemory {
  readonly hmem: HMEM;
  private replayClock: number | null = null;
  private dropped = 0;
  private recordsDropped = 0;

  constructor(readonly caseId: string, actor: string, state?: MemoryState | null, private now: () => number = Date.now) {
    this.hmem = new HMEM({ clock: () => this.replayClock ?? this.now(), actor });
    if (!state) return;
    if (state.engine !== MEMORY_ENGINE) throw new Error(`Stored memory was written by ${state.engine}, not ${MEMORY_ENGINE}.`);
    this.hmem.store.restoreAll(state.records, state.seq);
    // H-MEM's ledger has no bulk restore, so entries are replayed with their original timestamps.
    for (const e of state.ledger) {
      this.replayClock = e.timestamp;
      this.hmem.ledger.log(e.memoryId, e.action, e.actor, { previousState: e.previousState, newState: e.newState, details: e.details });
    }
    this.replayClock = null;
    this.dropped = state.ledger_dropped ?? 0;
    this.recordsDropped = state.records_dropped ?? 0;
  }

  /** Keeps the newest RECORD_LIMIT memories and LEDGER_LIMIT ledger entries; how many were dropped is kept and shown. */
  toState(): MemoryState {
    const { records, seq } = this.hmem.store.snapshotAll();
    const ledger = [...this.hmem.ledger.all()];
    const overflow = Math.max(0, ledger.length - LEDGER_LIMIT), recordOverflow = Math.max(0, records.length - RECORD_LIMIT);
    return { engine: MEMORY_ENGINE, seq, records: records.slice(recordOverflow), ledger: ledger.slice(overflow), ledger_dropped: this.dropped + overflow, records_dropped: this.recordsDropped + recordOverflow };
  }

  remember(input: RememberInput, evidence: Evidence): MemoryRecord {
    const fingerprint = memoryFingerprint(evidence, input.refs, input.shipments, input.deps);
    const refs = [...(input.deps ?? []).slice(0, 30).map(encodeDep), ...input.refs.slice(0, 30)];
    const record = this.hmem.add({
      content: input.content.slice(0, 1000), type: 'factual', layer: input.review === 'operator-approved' ? 'long_term' : 'working',
      confidence: input.confidence, source: input.source, chatId: this.caseId, supersedes: input.supersedes,
      tags: [`kind:${input.kind}`, `review:${input.review}`, `fp:${fingerprint}`, ...(input.deps ? ['deps:v2'] : []), ...input.shipments.map(s => `shipment:${s}`), ...input.refs.slice(0, 30).map(id => `cites:${id}`)],
      provenance: { origin: input.origin, learnedAt: this.now(), label: input.label, refs },
    });
    if (input.supersedes) this.hmem.store.update(input.supersedes, { supersededBy: record.id });
    return record;
  }

  /**
   * current: every dependency was checked and is unchanged. stale: a dependency changed. unknown: a
   * dependency cannot be checked here (no dependencies were recorded, or a connected-source row has
   * not been read again since). Unknown memories are never presented as current.
   */
  validity(m: MemoryRecord, evidence: Evidence): { validity: MemoryValidity; reason: string } {
    if (m.supersededBy) return { validity: 'superseded', reason: `Superseded by ${m.supersededBy}.` };
    const stored = tagValue(m, 'fp:')[0], deps = dependenciesOf(m);
    if (!stored) return { validity: 'unknown', reason: 'No evidence fingerprint was stored with this memory, so it cannot be checked.' };
    if (!deps.length) return { validity: 'unknown', reason: 'No evidence dependencies were recorded with this memory, so it cannot be checked.' };
    const current = m.tags.includes('deps:v2') ? memoryFingerprint(evidence, [], [], deps) : memoryFingerprint(evidence, (m.provenance.refs ?? []).filter(x => !x.startsWith(DEP)), tagValue(m, 'shipment:'));
    if (current !== stored) return { validity: 'stale', reason: 'Case evidence this depends on changed after it was written.' };
    const external = deps.filter((d): d is Extract<FactDependency, { kind: 'external' }> => d.kind === 'external').map(d => externalValidity(d, evidence.c));
    const staleExt = external.find(x => x.validity === 'stale'), unknownExt = external.find(x => x.validity === 'unknown');
    if (staleExt) return { validity: 'stale', reason: staleExt.reason };
    if (unknownExt) return { validity: 'unknown', reason: unknownExt.reason };
    return { validity: 'current', reason: external.length ? 'Case evidence is unchanged and each connected-source row was read again unchanged.' : 'Case evidence this depends on is unchanged since it was written.' };
  }

  describe(m: MemoryRecord, evidence: Evidence, relevance = 0): RecalledMemory {
    const v = this.validity(m, evidence);
    return { memory_id: m.id, content: m.content, kind: (tagValue(m, 'kind:')[0] ?? 'finding') as MemoryKind, review: tagValue(m, 'review:')[0] ?? 'unreviewed',
      confidence: Number(m.confidence.toFixed(2)), created_at: new Date(m.timestamp).toISOString(), source: m.source,
      cites: (m.provenance.refs ?? []).filter(x => !x.startsWith(DEP)), shipments: tagValue(m, 'shipment:'), dependencies: dependenciesOf(m),
      validity: v.validity, validity_reason: v.reason, relevance: Number(relevance.toFixed(3)), disputed: m.tags.includes('review') };
  }

  /** Operator feedback through H-MEM's own feedback deltas; "wrong" also tags the memory for review. */
  feedback(memoryId: string, kind: 'wrong' | 'helpful'): RecalledMemory['content'] {
    const m = this.hmem.store.get(memoryId);
    if (!m || m.chatId !== this.caseId) throw new Error('Memory not found in this case.');
    this.hmem.feedback(memoryId, kind);
    return m.content;
  }

  /** H-MEM hybrid retrieval scoped to this case, labelled with current validity. */
  recall(query: string, evidence: Evidence, topN = 5): RecalledMemory[] {
    const result = this.hmem.query(query, { topN, threshold: 0.05, chatId: this.caseId });
    return result.memories.map(({ memory, relevance }) => this.describe(memory, evidence, relevance));
  }

  list(evidence: Evidence): RecalledMemory[] {
    return this.hmem.store.all().filter(m => m.chatId === this.caseId).sort((a, b) => b.timestamp - a.timestamp).map(m => this.describe(m, evidence));
  }

  /**
   * Marks every memory whose evidence changed as superseded by a recheck note. The earlier text stays
   * readable in the recheck note and in the ledger while it is retained (see RECORD_LIMIT and LEDGER_LIMIT).
   */
  revalidate(evidence: Evidence, cause: string): number {
    let count = 0;
    for (const m of this.hmem.store.all()) {
      if (m.chatId !== this.caseId || m.supersededBy || this.validity(m, evidence).validity !== 'stale') continue;
      this.remember({ content: `Recheck needed (${cause}). Earlier ${tagValue(m, 'kind:')[0] ?? 'note'} ${m.id} is superseded and may no longer hold. It said: “${m.content.slice(0, 300)}”`, kind: 'recheck',
        confidence: 0.5, source: `recallreach:revalidation:${m.id}`, label: `Evidence changed: ${cause}`, origin: 'document',
        refs: (m.provenance.refs ?? []).filter(x => !x.startsWith(DEP)), shipments: tagValue(m, 'shipment:'), review: 'unreviewed', supersedes: m.id,
        deps: refreshDependencies(dependenciesOf(m), evidence.c) }, evidence);
      count++;
    }
    return count;
  }

  /** Runs H-MEM's conflict scan (detection only; RecallReach never auto-resolves). Call once after new writes. */
  scanContradictions(): number {
    return this.hmem.conflicts.scan().length;
  }

  /**
   * Contradictions H-MEM has recorded in its ledger, deduplicated by memory pair. Pairs involving a
   * recheck note are left out: a recheck note quotes the superseded text on purpose, so its similarity
   * to a newer statement is not a disagreement.
   */
  contradictions(): { a: string; b: string; reason: string }[] {
    const seen = new Set<string>(), recheck = (id: string) => this.hmem.store.get(id)?.tags.includes('kind:recheck') ?? false;
    return this.hmem.ledger.all().filter(e => e.action === 'conflict_detected').map(e => ({ a: e.memoryId, b: String(e.details?.with ?? ''), reason: String(e.details?.reason ?? '') }))
      .filter(x => !recheck(x.a) && !recheck(x.b))
      .filter(x => { const k = [x.a, x.b].sort().join('|'); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  ledgerSummary() {
    const records = this.hmem.store.all().filter(m => m.chatId === this.caseId).length;
    return { entries: this.hmem.ledger.all().length, dropped: this.dropped, records, records_dropped: this.recordsDropped, record_limit: RECORD_LIMIT, ledger_limit: LEDGER_LIMIT, by_action: this.hmem.ledger.stats() };
  }
}
