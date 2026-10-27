'use client';

import { useState } from 'react';
import { AlertTriangle, ArrowRight, Check, FileText, PencilLine } from 'lucide-react';
import type { LedgerRecord } from '@/lib/recall/types';
import { CSV_COLUMNS, sourceRow } from '@/lib/recall/csv';
import { recordFlags } from '@/lib/recall/agent/safety';
import { date, Tag, type Payload } from './shared';

const STATUS: Record<string, [string, string]> = { applied: ['Accepted', 'teal'], review: ['Needs review', 'red'], duplicate: ['Duplicate', ''], excluded: ['Outside alert', ''], superseded: ['Superseded', 'amber'] };

export function RecordDialogBody({ record, data, busy, error, onViewSource, onCorrect }: {
  record: LedgerRecord; data: Payload; busy: boolean; error: string;
  onViewSource: (sourceId: string) => void;
  onCorrect: (body: { record_id: string; kind: 'supersede' | 'withdraw'; reason: string; evidence_reference: string; replacement?: Record<string, string> }) => void;
}) {
  const { case: c, result: r } = data, status = r.record_status[record.id], source = c.sources.find(s => s.id === record.source_id);
  const original = source ? sourceRow(source, record.source_row) : null, flags = recordFlags(record);
  const correction = c.corrections.find(k => k.original_id === record.id), replaces = c.corrections.find(k => k.replacement_id === record.id);
  const [editing, setEditing] = useState(false);
  const [label, tone] = STATUS[status?.status ?? ''] ?? ['Unknown', ''];
  return <div className="dialog-body">
    <div className="record-header"><h3>{record.reference || record.event_id || 'Unidentified record'}</h3><Tag tone={tone}>{label}</Tag></div>
    <p className="reason-box">{status?.reason}</p>
    {Object.keys(flags).length > 0 && <p className="form-error"><AlertTriangle size={14} /> This record contains text that reads like an instruction to an AI system ({Object.entries(flags).map(([f, l]) => `${f}: ${l.join(', ')}`).join('; ')}). It is treated as data only and cannot change any result.</p>}
    {correction && <p className="inline-note">{correction.kind === 'withdraw' ? 'Withdrawn' : 'Superseded'} by {correction.actor} on {date(correction.at)}. Reason: {correction.reason}. Evidence: {correction.evidence_reference}.</p>}
    {replaces && <p className="inline-note">This record is a correction entered by {replaces.actor} on {date(replaces.at)}. Reason: {replaces.reason}. Evidence: {replaces.evidence_reference}.</p>}
    <dl className="record-grid">{[['Event', record.event_id], ['Shipment', record.shipment_id], ['Product', record.product], ['Manufacturer', record.manufacturer], ['Batch', record.batch], ['Quantity', `${record.raw_quantity ?? record.quantity} ${record.unit}`], ['Location', record.location], ['Movement', record.type === 'shipment' ? 'Opening → available (awaiting containment)' : `${record.from_state} → ${record.to_state}`], ['Event time', record.occurred_at], ['Source row', String(record.source_row)]].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || 'Missing'}</dd></div>)}</dl>
    {original && <details className="original-row"><summary>Original cells as imported</summary><dl className="record-grid compact">{Object.entries(original).map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono">{v === '' ? '(empty)' : v}</dd></div>)}</dl></details>}
    <div className="source-provenance"><FileText size={18} /><div><strong>{source?.name}</strong><small>Imported {date(source?.added_at || c.created_at)}{source?.origin ? ` · ${source.origin.mode === 'mock' ? 'MOCK fixture, not Zetaris' : 'via Zetaris'} · table ${source.origin.table} · query ${source.origin.query_id.slice(0, 8)} · ${source.origin.latency_ms} ms` : ''}</small></div><button className="text-button" onClick={() => onViewSource(record.source_id)}>View source<ArrowRight size={14} /></button></div>
    {!correction && !editing && <button className="button correction-start" onClick={() => setEditing(true)}><PencilLine size={15} />Correct this record</button>}
    {editing && !correction && <CorrectionForm record={record} busy={busy} error={error} onCancel={() => setEditing(false)} onSubmit={onCorrect} />}
  </div>;
}

function CorrectionForm({ record, busy, error, onCancel, onSubmit }: { record: LedgerRecord; busy: boolean; error: string; onCancel: () => void; onSubmit: Parameters<typeof RecordDialogBody>[0]['onCorrect'] }) {
  const [kind, setKind] = useState<'supersede' | 'withdraw'>('supersede'), [reason, setReason] = useState(''), [evidence, setEvidence] = useState('');
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries(CSV_COLUMNS.map(col => [col, col === 'quantity' ? String(record.raw_quantity ?? record.quantity) : String(record[col as keyof LedgerRecord] ?? '')])));
  const ready = reason.trim().length >= 10 && evidence.trim().length >= 3;
  return <form className="correction-form form-fields" onSubmit={e => { e.preventDefault(); if (ready) onSubmit({ record_id: record.id, kind, reason: reason.trim(), evidence_reference: evidence.trim(), ...(kind === 'supersede' ? { replacement: fields } : {}) }); }}>
    <h4>Correct this record</h4>
    <p className="fine-print">The original stays in the evidence history, marked superseded. Your correction is recorded with your name, time, reason and evidence, and balances are recalculated. Earlier conclusions that relied on it are marked for recheck.</p>
    <fieldset className="segmented">
      <legend className="sr-only">Correction type</legend>
      <label className={kind === 'supersede' ? 'checked' : ''}><input type="radio" name="kind" checked={kind === 'supersede'} onChange={() => setKind('supersede')} /><span><strong>Replace with corrected values</strong><small>New record supersedes this one</small></span></label>
      <label className={kind === 'withdraw' ? 'checked' : ''}><input type="radio" name="kind" checked={kind === 'withdraw'} onChange={() => setKind('withdraw')} /><span><strong>Withdraw from balances</strong><small>No replacement record</small></span></label>
    </fieldset>
    {kind === 'supersede' && <div className="correction-grid">{CSV_COLUMNS.map(col => <label key={col}>{col}<input value={fields[col]} maxLength={500} onChange={e => setFields(f => ({ ...f, [col]: e.target.value }))} /></label>)}</div>}
    <label>Reason for the correction<textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} minLength={10} maxLength={2000} required placeholder="What was wrong, and who confirmed it. No patient details." /></label>
    <label>Evidence for the correction<input value={evidence} onChange={e => setEvidence(e.target.value)} minLength={3} maxLength={300} required placeholder="e.g. Email from Cedar Pharmacy, 5 Oct, ticket 1182" /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions"><button type="button" className="button" onClick={onCancel} disabled={busy}>Cancel</button><button type="submit" className="button primary" disabled={busy || !ready}><Check size={15} />Save correction</button></div>
  </form>;
}
