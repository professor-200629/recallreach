'use client';

import { useState } from 'react';
import { AlertTriangle, ArrowRight, Bot, Brain, Check, CircleHelp, Clock3, Cpu, GitBranch, ListChecks, Loader2, Play, RefreshCw, Wrench } from 'lucide-react';
import type { AgentRun, LedgerRecord } from '@/lib/recall/types';
import { CiteChips, date, number, Tag, type Payload } from './shared';

const TOOL_LABELS: Record<string, string> = {
  get_recall_scope: 'Read recall scope', run_reconciliation: 'Run reconciliation', search_records: 'Search records', get_shipment_ledger: 'Open shipment ledger',
  get_source_row: 'Retrieve original row', find_reference: 'Trace reference', recall_memory: 'Recall memory (H-MEM)', compare_with_previous_run: 'Compare with previous run',
  query_connected_source: 'Query source via Zetaris', propose_follow_up: 'Propose follow-up', submit_findings: 'Submit cited findings',
};

export function AgentPanel({ data, busy, onRun, onEvidence, onRecord, onQueue }: {
  data: Payload; busy: string;
  onRun: (question: string, mode: 'auto' | 'rules') => void;
  onEvidence: (ids: string[]) => void; onRecord: (row: LedgerRecord) => void; onQueue: () => void;
}) {
  const { case: c, result: r, capabilities, staleness, memory } = data;
  const live = capabilities.agent.configured;
  const suggestions = [
    r.available > 0 ? `Why are ${r.available} ${c.alert.unit} still unresolved, and what evidence would resolve this?` : `What is still open for this batch, and what evidence would close it?`,
    'What changed since the previous run, and do earlier conclusions still hold?',
    'Which records were held for review, and could any of them explain a gap?',
  ];
  const [question, setQuestion] = useState(suggestions[0]), [mode, setMode] = useState<'auto' | 'rules'>(live ? 'auto' : 'rules');
  const [selected, setSelected] = useState<string | null>(null);
  const runs = [...c.agent_runs].reverse(), run = runs.find(x => x.id === selected) ?? runs[0];
  const open = (row: LedgerRecord | null, ids: string[]) => row ? onRecord(row) : onEvidence(ids);
  const running = busy.startsWith('Investigating');

  return <>
    <section className="panel agent-ask">
      <div className="panel-heading"><div><span className="eyebrow">INVESTIGATION AGENT</span><h2>Ask a question about this batch.</h2></div><Bot size={20} /></div>
      <form className="agent-form" onSubmit={e => { e.preventDefault(); if (question.trim().length >= 5) onRun(question.trim(), mode); }}>
        <label className="sr-only" htmlFor="agent-question">Investigation question</label>
        <textarea id="agent-question" value={question} onChange={e => setQuestion(e.target.value)} rows={2} maxLength={500} required minLength={5} />
        <div className="suggestions" role="list" aria-label="Suggested questions">{suggestions.map(s => <button key={s} type="button" role="listitem" className={`suggestion ${s === question ? 'selected' : ''}`} onClick={() => setQuestion(s)}>{s}</button>)}</div>
        <fieldset className="segmented">
          <legend className="sr-only">Investigation mode</legend>
          <label className={mode === 'auto' ? 'checked' : ''}><input type="radio" name="mode" value="auto" checked={mode === 'auto'} disabled={!live} onChange={() => setMode('auto')} /><Cpu size={15} /><span><strong>Live model</strong><small>{live ? `${capabilities.agent.provider} · ${capabilities.agent.model}` : 'Not configured'}</small></span></label>
          <label className={mode === 'rules' ? 'checked' : ''}><input type="radio" name="mode" value="rules" checked={mode === 'rules'} onChange={() => setMode('rules')} /><ListChecks size={15} /><span><strong>Rules mode</strong><small>Fixed procedure, no AI model</small></span></label>
        </fieldset>
        <div className="agent-actions">
          <p className="fine-print">The agent reads evidence through read-only tools. It cannot change stock, send messages or approve anything. {mode === 'auto' && live ? 'Free-tier rate limits can make a live run take a few minutes.' : ''}{!live ? ` ${capabilities.agent.reason}` : ''}</p>
          <button className="button primary" type="submit" disabled={!!busy || question.trim().length < 5}>{running ? <Loader2 size={16} className="spin" /> : <Play size={16} />}Investigate</button>
        </div>
      </form>
    </section>

    {staleness.stale && runs.length > 0 && <div className="message warning" role="status"><AlertTriangle size={17} /><span>Evidence changed after the last run ({date(staleness.last_run_at!)}). Its conclusions may be stale; run the investigation again to reassess.</span><button className="button small" onClick={() => onRun(suggestions[1], mode)} disabled={!!busy}><RefreshCw size={14} />Reassess</button></div>}

    {!run ? <section className="panel"><div className="empty-small"><Bot /><p>No investigation has been run on this case yet.</p><small>Each run records the tools it used, the evidence it retrieved and which statements could be verified.</small></div></section> : <RunView run={run} data={data} open={open} onQueue={onQueue} />}

    <div className="two-columns">
      <section className="panel">
        <div className="panel-heading"><div><span className="eyebrow">RUN HISTORY</span><h2>Earlier investigations <span className="count-circle">{runs.length}</span></h2></div><Clock3 size={18} /></div>
        {runs.length ? runs.map(x => <button key={x.id} className={`run-row ${x.id === run?.id ? 'selected' : ''}`} onClick={() => setSelected(x.id)} aria-pressed={x.id === run?.id}>
          <Tag tone={x.mode === 'live' ? 'teal' : ''}>{x.mode === 'live' ? 'LIVE MODEL' : 'RULES MODE'}</Tag><span><strong>{x.question}</strong><small>{date(x.started_at)} · {x.status.replace('_', ' ')} · {x.steps.length} steps{x.evidence_fingerprint !== staleness.current_fingerprint ? ' · evidence has changed since' : ''}</small></span>
        </button>) : <div className="empty-small"><small>No runs yet.</small></div>}
      </section>
      <MemoryPanel data={data} open={open} />
    </div>
  </>;
}

function RunView({ run, data, open, onQueue }: { run: AgentRun; data: Payload; open: (row: LedgerRecord | null, ids: string[]) => void; onQueue: () => void }) {
  const { case: c, result: r } = data, a = run.answer;
  const verified = a?.findings.filter(f => f.verification === 'verified').length ?? 0;
  const usage = run.mode === 'live' ? `${run.usage.model_calls} model calls · ${number(run.usage.input_tokens)} in / ${number(run.usage.output_tokens)} out tokens · ${run.usage.estimated_cost_usd === null ? 'no cost estimate (provider pricing not configured)' : `≈ $${run.usage.estimated_cost_usd.toFixed(4)}`}` : 'No model calls · no cost';
  return <>
    <section className="panel run-panel">
      <div className="run-header">
        <div className="run-tags"><Tag tone={run.mode === 'live' ? 'teal' : ''}>{run.mode === 'live' ? `LIVE MODEL · ${run.provider} ${run.model}` : 'RULES MODE · NO LANGUAGE MODEL'}</Tag><Tag tone={run.status === 'completed' ? 'teal' : 'red'}>{run.status.replace('_', ' ').toUpperCase()}</Tag></div>
        <h2>{run.question}</h2>
        <p className="run-meta">{date(run.started_at)} · {(run.duration_ms / 1000).toFixed(1)} s · {run.steps.length} tool steps · {usage}</p>
        {run.status !== 'completed' && <p className="form-error" role="alert">{run.status_detail}</p>}
      </div>
      {a && <>
        <div className="run-summary"><span className="eyebrow">{run.mode === 'live' ? 'SUMMARY WRITTEN BY THE MODEL — CHECK THE CITED FINDINGS' : 'SUMMARY COMPOSED BY RULES'}</span><p>{a.summary}</p>{a.summary_problems.length > 0 && <p className="problem-text"><AlertTriangle size={13} />{a.summary_problems.join(' ')}</p>}</div>
        <div className="run-section"><h3><Check size={15} />Findings <span className="subtle">{verified} of {a.findings.length} verified against retrieved evidence</span></h3>
          {a.findings.map((f, i) => <article key={i} className={`claim ${f.verification}`}>
            <div className="claim-head"><Tag tone={f.verification === 'verified' ? 'teal' : 'amber'}>{f.verification === 'verified' ? 'VERIFIED CITATIONS' : 'UNVERIFIED'}</Tag><span className="subtle">{f.basis === 'engine_calculated' ? 'Calculated by the reconciliation engine' : f.basis === 'source_reported' ? 'Reported by source records' : 'Marked unverified'}</span></div>
            <p>{f.claim}</p><CiteChips ids={f.citations} c={c} r={r} onOpen={open} />
            {f.problems.length > 0 && <ul className="problems">{f.problems.map(p => <li key={p}>{p}</li>)}</ul>}
          </article>)}
          {!a.findings.length && <p className="subtle pad">No findings were submitted.</p>}
        </div>
        {a.missing_evidence.length > 0 && <div className="run-section"><h3><CircleHelp size={15} />Evidence that would resolve this</h3>{a.missing_evidence.map((m, i) => <article key={i} className={`claim ${m.verification}`}><p><strong>{m.description}</strong></p><p className="subtle">Would resolve: {m.would_resolve}</p><CiteChips ids={m.citations} c={c} r={r} onOpen={open} /></article>)}</div>}
        <div className="run-section"><h3><GitBranch size={15} />Proposed follow-ups <span className="subtle">{a.follow_ups.length} awaiting human decision</span></h3>
          {a.follow_ups.map((p, i) => <article key={i} className="claim"><p><strong>{p.action}</strong></p><p className="subtle">Owner: {p.owner_role.replace(/_/g, ' ')} · Evidence requested: {p.evidence_requested}</p></article>)}
          {a.follow_ups.length > 0 && <button className="text-button pad" onClick={onQueue}>Review in the follow-up queue<ArrowRight size={14} /></button>}
        </div>
        {a.rejected_citations.length > 0 && <p className="panel-note"><AlertTriangle size={14} />Rejected citations (not retrieved in this run): {a.rejected_citations.join(', ')}</p>}
      </>}
    </section>
    <section className="panel">
      <div className="panel-heading"><div><span className="eyebrow">TOOL ACTIVITY</span><h2>What the {run.mode === 'live' ? 'agent' : 'procedure'} actually did</h2></div><Wrench size={18} /></div>
      <p className="panel-intro">Each step is a real tool call against this case's evidence. The purpose line is the {run.mode === 'live' ? 'model' : 'procedure'}'s own one-sentence reason; no hidden reasoning is shown or stored.</p>
      <ol className="tool-steps">{run.steps.map(s => <li key={s.seq} className={s.ok ? '' : 'failed'}>
        <span className="step-n">{s.seq}</span>
        <div><div className="step-title"><strong>{TOOL_LABELS[s.tool] ?? s.tool}</strong><code>{s.tool}</code>{!s.ok && <Tag tone="red">REJECTED</Tag>}<span className="subtle">{s.duration_ms} ms</span></div>
          {s.purpose && <p className="step-purpose">“{s.purpose}”</p>}
          <p>{s.ok ? s.summary : s.error}</p>
          {s.record_ids.length > 0 && <button className="text-button" onClick={() => open(null, s.record_ids)}>{s.record_ids.length} records retrieved<ArrowRight size={13} /></button>}
          <details><summary>Arguments</summary><pre>{JSON.stringify(s.args, null, 2)}</pre></details></div>
      </li>)}</ol>
      <p className="panel-note"><Brain size={14} />Memory in this run: {run.memory.recalled} recalled, {run.memory.stored} stored, {run.memory.invalidated} marked for recheck. Evidence fingerprint {run.evidence_fingerprint}.</p>
    </section>
  </>;
}

function MemoryPanel({ data, open }: { data: Payload; open: (row: LedgerRecord | null, ids: string[]) => void }) {
  const { memory, case: c, result: r } = data;
  const tone = { current: 'teal', stale: 'amber', superseded: '' } as const;
  return <section className="panel memory-panel">
    <div className="panel-heading"><div><span className="eyebrow">INVESTIGATION MEMORY · METERLESS H-MEM</span><h2>What earlier runs learned <span className="count-circle">{memory.items.length}</span></h2></div><Brain size={18} /></div>
    <p className="panel-intro">Verified findings, open questions and operator decisions are stored with their evidence. When that evidence changes, the memory is superseded by a recheck note, never deleted. Memory is context only: current records decide stock.</p>
    {memory.contradictions.length > 0 && <div className="memory-conflicts">{memory.contradictions.slice(0, 3).map(x => <p key={`${x.a}-${x.b}`}><AlertTriangle size={13} />Contradiction kept for review: {x.a} and {x.b} ({x.reason}).</p>)}</div>}
    {memory.items.slice(0, 12).map(m => <article key={m.memory_id} className={`memory-item ${m.validity}`}>
      <div className="claim-head"><Tag tone={tone[m.validity]}>{m.validity.toUpperCase()}</Tag><span className="subtle">{m.kind} · {m.review.replace('-', ' ')} · {m.memory_id} · {date(m.created_at)}</span></div>
      <p>{m.content}</p>{m.cites.length > 0 && <CiteChips ids={m.cites} c={c} r={r} onOpen={open} />}
    </article>)}
    {!memory.items.length && <div className="empty-small"><small>Nothing remembered yet. Memory is written after an investigation run or an operator decision.</small></div>}
    {memory.ledger && <p className="panel-note">H-MEM trust ledger: {memory.ledger.entries} entries ({Object.entries(memory.ledger.by_action).map(([k, v]) => `${k} ${v}`).join(', ')}){memory.ledger.dropped ? `; ${memory.ledger.dropped} oldest entries not retained` : ''}.</p>}
  </section>;
}
