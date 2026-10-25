'use client';

import { useState } from 'react';
import { AlertTriangle, ArrowRight, Bot, Brain, Check, CircleHelp, Clock3, Cpu, GitBranch, ListChecks, Loader2, Play, RefreshCw, Wrench } from 'lucide-react';
import type { AgentRun, LedgerRecord, ValidatedFact } from '@/lib/recall/types';
import { challengeFact, type Challenge } from '@/lib/recall/explain';
import { ChallengeView } from './challenge';
import { duration } from '@/lib/recall/format';
import { CiteChips, date, Dialog, number, Tag, type Payload } from './shared';

const TOOL_LABELS: Record<string, string> = {
  get_recall_scope: 'Read recall scope', run_reconciliation: 'Run reconciliation', search_records: 'Search records', get_shipment_ledger: 'Open shipment ledger',
  get_source_row: 'Retrieve original row', find_reference: 'Trace reference', recall_memory: 'Recall memory (H-MEM)', compare_with_previous_run: 'Compare with previous run',
  query_connected_source: 'Query source via Zetaris', propose_follow_up: 'Propose follow-up', submit_findings: 'Submit typed facts',
};

export function AgentPanel({ data, busy, onRun, onEvidence, onRecord, onQueue, onMemoryWrong }: {
  data: Payload; busy: string; onMemoryWrong: (memoryId: string, content: string) => void;
  onRun: (question: string, mode: 'auto' | 'rules') => void;
  onEvidence: (ids: string[]) => void; onRecord: (row: LedgerRecord) => void; onQueue: () => void;
}) {
  const { case: c, result: r, capabilities, staleness } = data;
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
          <p className="fine-print">The agent reads evidence through read-only tools. It cannot change stock, send messages or approve anything. {mode === 'auto' && live ? `A live run stops after ${duration(capabilities.agent.time_limit_s)}; free-tier rate limits can make it use most of that time.` : ''}{!live ? ` ${capabilities.agent.reason}` : ''}</p>
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
      <MemoryPanel data={data} open={open} busy={!!busy} onMemoryWrong={onMemoryWrong} />
    </div>
  </>;
}

const FACT_LABELS: Record<ValidatedFact['type'], string> = { shipment_balance: 'Shipment balance', case_total: 'Case total', record_report: 'What a record reports', record_status: 'How a record was counted', open_issue: 'Open issue', change_since_previous: 'Change since previous run', source_row_report: 'Connected-source row' };
const claimedText = (f: ValidatedFact) => Object.entries(f.claimed).filter(([k]) => k !== 'type').map(([k, v]) => `${k}: ${String(v)}`).join(' · ');

function RunView({ run, data, open, onQueue }: { run: AgentRun; data: Payload; open: (row: LedgerRecord | null, ids: string[]) => void; onQueue: () => void }) {
  const { case: c, result: r, staleness } = data, a = run.answer;
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const facts = a?.facts ?? [], validated = facts.filter(f => f.status === 'validated');
  const retries = [run.usage.malformed_calls ? `${run.usage.malformed_calls} malformed tool call${run.usage.malformed_calls === 1 ? '' : 's'}` : '', run.usage.oversize_retries ? `${run.usage.oversize_retries} oversized request${run.usage.oversize_retries === 1 ? '' : 's'} resent smaller` : '', run.usage.shortened_requests && run.limits?.max_request_tokens ? `${run.usage.shortened_requests} request${run.usage.shortened_requests === 1 ? '' : 's'} shortened to stay under ${number(run.limits.max_request_tokens)} tokens` : ''].filter(Boolean).map(t => ` · ${t}`).join('');
  const usage = run.mode === 'live' ? `${run.usage.model_calls} model calls · ${number(run.usage.input_tokens)} in / ${number(run.usage.output_tokens)} out tokens${retries} · ${run.usage.estimated_cost_usd === null ? 'no cost estimate (provider pricing not configured)' : `≈ $${run.usage.estimated_cost_usd.toFixed(4)}`}` : 'No model calls · no cost';
  const why = (f: ValidatedFact) => setChallenge(challengeFact(f, { c, r, current: staleness.current_fingerprint, validatedAt: run.started_at }));
  return <>
    <section className="panel run-panel">
      <div className="run-header">
        <div className="run-tags"><Tag tone={run.mode === 'live' ? 'teal' : ''}>{run.mode === 'live' ? `LIVE MODEL · ${run.provider} ${run.model}` : 'RULES MODE · NO LANGUAGE MODEL'}</Tag><Tag tone={run.status === 'completed' ? 'teal' : 'red'}>{run.status.replace('_', ' ').toUpperCase()}</Tag></div>
        <h2>{run.question}</h2>
        <p className="run-meta">{date(run.started_at)} · {(run.duration_ms / 1000).toFixed(1)} s{run.limits ? ` of a ${Math.round(run.limits.total_timeout_ms / 1000)} s limit` : ''} · {run.steps.length} tool steps · {usage}</p>
        {run.status !== 'completed' && <p className="form-error" role="alert">{run.status_detail}</p>}
      </div>
      {a && a.version === 2 && <>
        <div className="run-summary"><span className="eyebrow">CHECKED SUMMARY · GENERATED FROM {validated.length} VALIDATED FACT{validated.length === 1 ? '' : 'S'}</span>
          {validated.length ? <ul className="checked-summary">{validated.map((f, i) => <li key={i}>{f.statement}</li>)}</ul> : <p>No fact could be validated in this run.</p>}
        </div>
        <div className="run-section"><h3><CircleHelp size={15} />{run.mode === 'live' ? 'The model’s own summary' : 'Summary composed by rules'} <span className="subtle">interpretation, not verified</span></h3>
          <article className="claim unverified"><p>{a.summary}</p>{a.summary_problems.length > 0 && <p className="problem-text"><AlertTriangle size={13} />{a.summary_problems.join(' ')}</p>}</article>
        </div>
        <div className="run-section"><h3><Check size={15} />Typed facts <span className="subtle">{validated.length} of {facts.length} validated field by field against the engine and the evidence returned in this run</span></h3>
          {facts.map((f, i) => <article key={i} className={`claim ${f.status === 'validated' ? 'verified' : 'unverified'}`}>
            <div className="claim-head"><Tag tone={f.status === 'validated' ? 'teal' : 'red'}>{f.status === 'validated' ? 'VALIDATED' : 'REJECTED'}</Tag><span className="subtle">{FACT_LABELS[f.type]} · {f.basis === 'engine_calculated' ? 'calculated by the engine' : 'reported by a source, not proof of handling'}</span>
              {f.status === 'validated' && <button type="button" className="text-button why-button" onClick={() => why(f)}>Why this finding?</button>}</div>
            {f.status === 'validated' ? <p>{f.statement}</p> : <p className="subtle">Submitted: {claimedText(f)}</p>}
            {f.status === 'validated' && f.evidence.length > 0 && <CiteChips ids={f.evidence.slice(0, 8)} c={c} r={r} onOpen={open} />}
            {f.problems.length > 0 && <ul className="problems">{f.problems.map(p => <li key={p}>{p}</li>)}</ul>}
            {f.note && <p className="subtle">Agent note (unverified): {f.note}</p>}
          </article>)}
          {!facts.length && <p className="subtle pad">No typed facts were submitted.</p>}
        </div>
        {(a.interpretations ?? []).length > 0 && <div className="run-section"><h3><CircleHelp size={15} />Interpretation <span className="subtle">the {run.mode === 'live' ? 'model’s' : 'procedure’s'} reasoning, shown with the evidence it points to; never validated</span></h3>
          {a.interpretations!.map((x, i) => <article key={i} className="claim unverified"><p>{x.text}</p>{x.related.length > 0 && <CiteChips ids={x.related} c={c} r={r} onOpen={open} />}{x.problems.length > 0 && <ul className="problems">{x.problems.map(p => <li key={p}>{p}</li>)}</ul>}</article>)}
        </div>}
        {(a.evidence_requests ?? []).length > 0 && <div className="run-section"><h3><GitBranch size={15} />Evidence that could change this <span className="subtle">a possibility, not a guarantee</span></h3>
          {a.evidence_requests!.map((e, i) => <article key={i} className={`claim ${e.linked ? '' : 'unverified'}`}><div className="claim-head"><Tag tone={e.linked ? 'teal' : 'amber'}>{e.linked ? `LINKED TO ${e.issue_id}` : 'NOT LINKED TO A RETRIEVED ISSUE'}</Tag></div><p><strong>{e.description}</strong></p><p className="subtle">Could change: {e.would_change}</p>{e.problems.length > 0 && <ul className="problems">{e.problems.map(p => <li key={p}>{p}</li>)}</ul>}</article>)}
        </div>}
      </>}
      {a && a.version !== 2 && <>
        <div className="run-summary"><span className="eyebrow">EARLIER RUN · FREE-TEXT FORMAT</span><p>{a.summary}</p><p className="problem-text"><AlertTriangle size={13} />This run used the earlier free-text format, where “verified” only meant that cited records existed, not that each statement matched them. Run the investigation again for field-by-field validation.</p></div>
        <div className="run-section"><h3><Check size={15} />Findings <span className="subtle">citations checked only</span></h3>
          {a.findings.map((f, i) => <article key={i} className="claim unverified"><p>{f.claim}</p><CiteChips ids={f.citations} c={c} r={r} onOpen={open} /></article>)}
        </div>
      </>}
      {a && <>
        <div className="run-section"><h3><GitBranch size={15} />Proposed follow-ups <span className="subtle">{a.follow_ups.length} awaiting human decision</span></h3>
          {a.follow_ups.map((p, i) => <article key={i} className="claim"><p><strong>{p.action}</strong></p><p className="subtle">Owner: {p.owner_role.replace(/_/g, ' ')} · Evidence requested: {p.evidence_requested}</p></article>)}
          {a.follow_ups.length > 0 && <button className="text-button pad" onClick={onQueue}>Review in the follow-up queue<ArrowRight size={14} /></button>}
        </div>
        {a.rejected_citations.length > 0 && <p className="panel-note"><AlertTriangle size={14} />Rejected citations (not returned with their contents in this run): {a.rejected_citations.join(', ')}</p>}
      </>}
    </section>
    {challenge && <Dialog title={challenge.title} wide onClose={() => setChallenge(null)}><ChallengeView ch={challenge} data={data} open={(row, ids) => { setChallenge(null); open(row, ids); }} /></Dialog>}
    <section className="panel">
      <div className="panel-heading"><div><span className="eyebrow">TOOL ACTIVITY</span><h2>What the {run.mode === 'live' ? 'agent' : 'procedure'} actually did</h2></div><Wrench size={18} /></div>
      <p className="panel-intro">Each step is a real tool call against this case’s evidence. The purpose line is the {run.mode === 'live' ? 'model' : 'procedure'}’s own one-sentence reason; no hidden reasoning is shown or stored.</p>
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

function MemoryPanel({ data, open, busy, onMemoryWrong }: { data: Payload; open: (row: LedgerRecord | null, ids: string[]) => void; busy: boolean; onMemoryWrong: (memoryId: string, content: string) => void }) {
  const { memory, case: c, result: r } = data;
  const tone = { current: 'teal', stale: 'amber', superseded: '', unknown: 'amber' } as const;
  return <section className="panel memory-panel">
    <div className="panel-heading"><div><span className="eyebrow">INVESTIGATION MEMORY · METERLESS H-MEM</span><h2>What earlier runs learned <span className="count-circle">{memory.items.length}</span></h2></div><Brain size={18} /></div>
    <p className="panel-intro">Validated facts and operator decisions are stored in RecallReach&apos;s wording, with the evidence each depends on. When that evidence changes, the memory is superseded by a recheck note. If a dependency cannot be checked here (for example a Zetaris row not read again), it is shown as unknown, never current. Memory is context only: current records decide stock.</p>
    {memory.contradictions.length > 0 && <div className="memory-conflicts">{memory.contradictions.slice(0, 3).map(x => <p key={`${x.a}-${x.b}`}><AlertTriangle size={13} />Contradiction kept for review: {x.a} and {x.b} ({x.reason}).</p>)}</div>}
    {memory.items.slice(0, 12).map(m => <article key={m.memory_id} className={`memory-item ${m.validity}`}>
      <div className="claim-head"><Tag tone={tone[m.validity]}>{m.validity.toUpperCase()}</Tag>{m.disputed && <Tag tone="red">MARKED WRONG</Tag>}<span className="subtle">{m.kind} · {m.review.replace('-', ' ')} · {m.memory_id} · {date(m.created_at)}</span>{!m.disputed && m.validity !== 'superseded' && <button className="text-button memory-wrong" onClick={() => onMemoryWrong(m.memory_id, m.content)} disabled={busy}>Mark as wrong</button>}</div>
      <p>{m.content}</p>{m.validity !== 'current' && <p className="subtle">{m.validity_reason}</p>}{m.cites.length > 0 && <CiteChips ids={m.cites} c={c} r={r} onOpen={open} />}
    </article>)}
    {!memory.items.length && <div className="empty-small"><small>Nothing remembered yet. Memory is written after an investigation run or an operator decision.</small></div>}
    {memory.ledger && <p className="panel-note">Retention: the newest {memory.ledger.record_limit ?? 200} memories and {memory.ledger.ledger_limit ?? 800} ledger entries are kept per case{memory.ledger.records_dropped || memory.ledger.dropped ? `; ${memory.ledger.records_dropped ?? 0} older memories and ${memory.ledger.dropped} older ledger entries have been dropped` : '; nothing has been dropped yet'}. H-MEM trust ledger: {memory.ledger.entries} entries ({Object.entries(memory.ledger.by_action).map(([k, v]) => `${k} ${v}`).join(', ')}).</p>}
  </section>;
}
