'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { RecallCase, Reconciliation, LedgerRecord } from '@/lib/recall/types';
import type { RecalledMemory } from '@/lib/recall/memory/hmem';
import type { ProviderSettings } from '@/lib/recall/agent/provider';

export type MemoryView = { engine: string; items: RecalledMemory[]; contradictions: { a: string; b: string; reason: string }[]; ledger: { entries: number; dropped: number; records?: number; records_dropped?: number; record_limit?: number; ledger_limit?: number; by_action: Record<string, number> } | null };
export type Payload = {
  case: RecallCase; result: Reconciliation;
  staleness: { stale: boolean; last_run_at: string | null; last_trigger: string | null; current_fingerprint: string };
  memory: MemoryView;
  capabilities: { agent: ProviderSettings; external: { mode: 'live' | 'mock' | 'none'; detail: string } };
  memory_invalidated?: number; memory_saved?: boolean; run_id?: string; imported?: number; skipped?: number;
  updated?: number; unchanged?: number; conflicts?: string[]; missing_at_source?: string[]; pages?: number; source_count?: number;
};

export const number = (v: number) => v.toLocaleString('en-IN');
export const date = (v: string) => new Date(v).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export async function api<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  } catch {
    throw new Error('Could not reach RecallReach. Check your connection and try again.');
  }
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

export function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; d?.showModal(); return () => d?.close(); }, []);
  return <dialog ref={ref} className={`dialog ${wide ? 'wide' : ''}`} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) onClose(); }} aria-labelledby="dialog-title"><div className="dialog-head"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div>{children}</dialog>;
}

export function Tag({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`tag ${tone}`}>{children}</span>; }

/** Short, human-readable label for a cited ID: a record's reference, an issue ID, or an external row. */
export function citeLabel(id: string, c: RecallCase): string {
  const row = c.records.find(r => r.id === id);
  if (row) return row.reference || row.event_id || `row ${row.source_row}`;
  if (id.startsWith('zetaris')) return id.split(':').slice(-2).join(' row ');
  if (id.startsWith('memory:')) return `memory ${id.slice(7)}`;
  if (id.startsWith('snapshot-diff:')) return 'change since previous run';
  if (id.startsWith('engine:shipment:')) return `engine balance ${id.slice(16)}`;
  if (id === 'engine:totals') return 'engine totals';
  return id;
}

/** Citation chips. A record opens its evidence dialog; an issue shows the records linked to it (if still open). */
export function CiteChips({ ids, c, r, onOpen }: { ids: string[]; c: RecallCase; r: Reconciliation; onOpen: (row: LedgerRecord | null, ids: string[]) => void }) {
  if (!ids.length) return <span className="cite-none">No valid citation</span>;
  return <span className="cite-list">{ids.map(id => {
    const row = c.records.find(x => x.id === id), issue = row ? null : r.issues.find(i => i.id === id);
    if (!row && !issue) return <span key={id} className="cite-chip static" title="Not in the current evidence">{citeLabel(id, c)}</span>;
    return <button key={id} type="button" className={`cite-chip ${row ? '' : 'issue'}`} onClick={() => onOpen(row ?? null, row ? [id] : issue!.evidence_ids)} title={row ? `Open ${row.event_id || 'record'} (row ${row.source_row})` : `Show evidence for ${id}`}>{citeLabel(id, c)}</button>;
  })}</span>;
}
