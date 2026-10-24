import { HMEM } from '../../../vendor/meterless-hmem/src/index.ts';
import type { LedgerEntry, MemoryRecord } from '../../../vendor/meterless-hmem/src/types.ts';
import type { RecallCase, Reconciliation } from '../types.ts';
import { hash64, recordsFingerprint, shipmentFingerprint } from '../snapshot.ts';

// Memory for one case, backed by the vendored Meterless H-MEM reference engine.
// RecallReach adds evidence links and validity checks; ranking, the trust ledger,
// supersession lineage and conflict detection are H-MEM's own code.
export const MEMORY_ENGINE = 'meterless-hmem-reference@1742dec';
const RECORD_LIMIT = 200, LEDGER_LIMIT = 800;

export type MemoryState = { engine: string; seq: number; records: MemoryRecord[]; ledger: LedgerEntry[]; ledger_dropped: number };
export type MemoryKind = 'finding' | 'question' | 'decision' | 'recheck';
export type MemoryValidity = 'current' | 'stale' | 'superseded';
export type RecalledMemory = {
  memory_id: string; content: string; kind: MemoryKind; review: string; confidence: number; created_at: string;
  source: string; cites: string[]; shipments: string[]; validity: MemoryValidity; validity_reason: string; relevance: number;
  /** An operator marked it wrong (H-MEM "wrong" feedback adds the review tag and lowers confidence). */
  disputed: boolean;
};
export type RememberInput = {
  content: string; kind: MemoryKind; confidence: number; source: string; label: string;
  origin: 'model_response' | 'manual' | 'document'; refs: string[]; shipments: string[];
  review: 'unreviewed' | 'operator-approved'; supersedes?: string;
};

type Evidence = { c: Pick<RecallCase, 'records' | 'corrections'>; r: Reconciliation };
const tagValue = (m: MemoryRecord, prefix: string) => m.tags.filter(t => t.startsWith(prefix)).map(t => t.slice(prefix.length));

/** Fingerprint of the cited records plus every record on the shipments the memory is about. */
export function memoryFingerprint({ c, r }: Evidence, refs: string[], shipments: string[]): string {
  return hash64([recordsFingerprint(c, r, refs), ...[...new Set(shipments)].sort().map(s => `${s}:${shipmentFingerprint(c, r, s)}`)].join('\n'));
}

export class CaseMemory {
  readonly hmem: HMEM;
  private replayClock: number | null = null;
  private dropped = 0;

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
  }

  toState(): MemoryState {
    const { records, seq } = this.hmem.store.snapshotAll();
    const ledger = [...this.hmem.ledger.all()];
    const overflow = Math.max(0, ledger.length - LEDGER_LIMIT);
    return { engine: MEMORY_ENGINE, seq, records: records.slice(-RECORD_LIMIT), ledger: ledger.slice(overflow), ledger_dropped: this.dropped + overflow };
  }

  remember(input: RememberInput, evidence: Evidence): MemoryRecord {
    const fingerprint = memoryFingerprint(evidence, input.refs, input.shipments);
    const record = this.hmem.add({
      content: input.content.slice(0, 1000), type: 'factual', layer: input.review === 'operator-approved' ? 'long_term' : 'working',
      confidence: input.confidence, source: input.source, chatId: this.caseId, supersedes: input.supersedes,
      tags: [`kind:${input.kind}`, `review:${input.review}`, `fp:${fingerprint}`, ...input.shipments.map(s => `shipment:${s}`), ...input.refs.slice(0, 30).map(id => `cites:${id}`)],
      provenance: { origin: input.origin, learnedAt: this.now(), label: input.label, refs: input.refs.slice(0, 30) },
    });
    if (input.supersedes) this.hmem.store.update(input.supersedes, { supersededBy: record.id });
    return record;
  }

  validity(m: MemoryRecord, evidence: Evidence): { validity: MemoryValidity; reason: string } {
    if (m.supersededBy) return { validity: 'superseded', reason: `Superseded by ${m.supersededBy}.` };
    const stored = tagValue(m, 'fp:')[0];
    if (!stored) return { validity: 'stale', reason: 'No evidence fingerprint was stored with this memory.' };
    const current = memoryFingerprint(evidence, m.provenance.refs ?? [], tagValue(m, 'shipment:'));
    return current === stored ? { validity: 'current', reason: 'Cited evidence is unchanged since this was written.' } : { validity: 'stale', reason: 'Evidence for the cited records or shipments changed after this was written.' };
  }

  describe(m: MemoryRecord, evidence: Evidence, relevance = 0): RecalledMemory {
    const v = this.validity(m, evidence);
    return { memory_id: m.id, content: m.content, kind: (tagValue(m, 'kind:')[0] ?? 'finding') as MemoryKind, review: tagValue(m, 'review:')[0] ?? 'unreviewed',
      confidence: Number(m.confidence.toFixed(2)), created_at: new Date(m.timestamp).toISOString(), source: m.source,
      cites: m.provenance.refs ?? [], shipments: tagValue(m, 'shipment:'), validity: v.validity, validity_reason: v.reason, relevance: Number(relevance.toFixed(3)), disputed: m.tags.includes('review') };
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
   * Marks every memory whose evidence changed as superseded by a recheck note. Nothing is
   * deleted and the earlier conclusion stays readable, so contradictions remain visible.
   */
  revalidate(evidence: Evidence, cause: string): number {
    let count = 0;
    for (const m of this.hmem.store.all()) {
      if (m.chatId !== this.caseId || m.supersededBy || this.validity(m, evidence).validity !== 'stale') continue;
      this.remember({ content: `Recheck needed (${cause}). Earlier ${tagValue(m, 'kind:')[0] ?? 'note'} ${m.id} is superseded and may no longer hold. It said: “${m.content.slice(0, 300)}”`, kind: 'recheck',
        confidence: 0.5, source: `recallreach:revalidation:${m.id}`, label: `Evidence changed: ${cause}`, origin: 'document',
        refs: m.provenance.refs ?? [], shipments: tagValue(m, 'shipment:'), review: 'unreviewed', supersedes: m.id }, evidence);
      count++;
    }
    return count;
  }

  /** Runs H-MEM's conflict scan (detection only; RecallReach never auto-resolves). Call once after new writes. */
  scanContradictions(): number {
    return this.hmem.conflicts.scan().length;
  }

  /** Contradictions H-MEM has recorded in its ledger, deduplicated by memory pair. */
  contradictions(): { a: string; b: string; reason: string }[] {
    const seen = new Set<string>();
    return this.hmem.ledger.all().filter(e => e.action === 'conflict_detected').map(e => ({ a: e.memoryId, b: String(e.details?.with ?? ''), reason: String(e.details?.reason ?? '') }))
      .filter(x => { const k = [x.a, x.b].sort().join('|'); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  ledgerSummary() {
    return { entries: this.hmem.ledger.all().length, dropped: this.dropped, by_action: this.hmem.ledger.stats() };
  }
}
