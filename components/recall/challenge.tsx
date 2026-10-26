'use client';

import type { ReactNode } from 'react';
import { AlertTriangle, Calculator, CircleHelp, Database, FlaskConical, GitCompare, ShieldAlert, Stamp } from 'lucide-react';
import type { LedgerRecord } from '@/lib/recall/types';
import type { Balance, Challenge } from '@/lib/recall/explain';
import { CiteChips, Tag, type Payload } from './shared';

const STATES = ['available', 'quarantined', 'returned', 'dispensed'] as const;
const BalanceRow = ({ b }: { b: Balance }) => <span className="balance-row">{STATES.map(s => <span key={s}><small>{s}</small><strong>{b[s].toLocaleString('en-IN')}</strong></span>)}</span>;

const Section = ({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) => <section className="challenge-section"><h3>{icon}{title}</h3>{children}</section>;

/** Evidence Challenge: why a finding holds, built only from records, engine statuses and typed fields. */
export function ChallengeView({ ch, data, open }: { ch: Challenge; data: Payload; open: (row: LedgerRecord | null, ids: string[]) => void }) {
  const { case: c, result: r } = data;
  const openRecord = (id: string | null) => { const row = id ? c.records.find(x => x.id === id) : undefined; if (row) open(row, [row.id]); };
  return <div className="dialog-body challenge">
    {ch.answer && <p className="challenge-answer">{ch.answer}</p>}
    <div className="challenge-statement">
      <div className="claim-head"><Tag tone="teal">{ch.basis === 'engine_calculated' ? 'CALCULATED BY THE ENGINE' : 'REPORTED BY A SOURCE'}</Tag>{ch.snapshot && <Tag tone={ch.snapshot.changed ? 'amber' : ''}>{ch.snapshot.changed ? 'EVIDENCE HAS CHANGED SINCE' : 'CURRENT EVIDENCE'}</Tag>}</div>
      <p>{ch.statement}</p>
      {ch.snapshot && <p className="subtle">Validated against evidence snapshot {ch.snapshot.validated ?? 'unknown'}; current snapshot {ch.snapshot.current}.</p>}
      {ch.evidence.length > 0 && <CiteChips ids={ch.evidence.slice(0, 12)} c={c} r={r} onOpen={open} />}
    </div>
    {(ch.calculation.length > 0 || ch.result) && <Section icon={<Calculator size={15} />} title="How it was calculated">
      {ch.calculation.length > 0 && <ol className="challenge-steps">{ch.calculation.map((s, i) => <li key={i}><button type="button" className="text-button" onClick={() => { const row = c.records.find(x => x.id === s.record_id); if (row) open(row, [row.id]); }}>{s.text}</button><BalanceRow b={s.balance} /></li>)}</ol>}
      {ch.result && <p className="challenge-result">{ch.result}</p>}
    </Section>}
    {ch.sources.length > 0 && <Section icon={<Database size={15} />} title="What each source says">
      <ul className="challenge-sources">{ch.sources.map(src => <li key={src.source_id}><p><strong>{src.name}</strong> <span className="subtle">{src.via}</span></p>
        {src.items.length ? <ul className="challenge-list">{src.items.map((x, i) => <li key={i}><button type="button" className="text-button" onClick={() => openRecord(x.record_id)}>{x.text}</button></li>)}</ul> : <p className="subtle">No imported record from this source names this shipment.</p>}</li>)}</ul>
      {ch.reads.length > 0 && <ul className="challenge-list challenge-reads">{ch.reads.map(x => <li key={x}>{x}</li>)}</ul>}
    </Section>}
    {ch.conflicts.length > 0 && <Section icon={<ShieldAlert size={15} />} title="Not counted, conflicts and exclusions">
      <ul className="challenge-list">{ch.conflicts.map((x, i) => <li key={i}>{x.record_id ? <button type="button" className="text-button" onClick={() => { const row = c.records.find(y => y.id === x.record_id); if (row) open(row, [row.id]); }}>{x.text}</button> : x.text}</li>)}</ul>
    </Section>}
    {ch.unknowns.length > 0 && <Section icon={<CircleHelp size={15} />} title="What the evidence does not show"><ul className="challenge-list">{ch.unknowns.map(u => <li key={u}>{u}</li>)}</ul></Section>}
    {ch.could_change.length > 0 && <Section icon={<GitCompare size={15} />} title="What evidence could change this"><ul className="challenge-list">{ch.could_change.map(u => <li key={u}>{u}</li>)}</ul></Section>}
    {ch.changes.map(g => <Section key={g.heading} icon={<AlertTriangle size={15} />} title={g.heading}><ul className="challenge-list">{g.items.map((x, i) => <li key={i}><button type="button" className="text-button" onClick={() => { const row = c.records.find(y => y.id === x.record_id); if (row) open(row, [row.id]); }}>{x.text}</button></li>)}</ul></Section>)}
    {ch.approvals.length > 0 && <Section icon={<Stamp size={15} />} title="Why approval does not change it"><ul className="challenge-list">{ch.approvals.map(u => <li key={u}>{u}</li>)}</ul></Section>}
    {ch.hypothetical && <Section icon={<FlaskConical size={15} />} title="Hypothetical preview (not evidence)">
      <p className="subtle">{ch.hypothetical.description}</p>
      <div className="hypo-grid"><span>Now</span><BalanceRow b={ch.hypothetical.before} /><span>Preview</span><BalanceRow b={ch.hypothetical.after} /></div>
      {ch.hypothetical.closed.length > 0 && <p className="subtle">Would close: {ch.hypothetical.closed.join('; ')}.</p>}
      {ch.hypothetical.still_open.length > 0 && <p className="subtle">Would stay open: {ch.hypothetical.still_open.join('; ')}.</p>}
    </Section>}
    <p className="fine-print">Every line above comes from the case records, the engine’s record statuses and the finding’s typed fields. No likelihoods are estimated.</p>
  </div>;
}
