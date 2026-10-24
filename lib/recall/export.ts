import type { RecallCase } from './types.ts';
import { reconcileCase, RULES_VERSION } from './engine.ts';
import { CSV_COLUMNS, toCsv } from './csv.ts';
import { staleness } from './snapshot.ts';
import { CaseMemory, MEMORY_ENGINE, type MemoryState } from './memory/hmem.ts';

export type ExportFormat = 'report' | 'evidence' | 'archive';
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'case';
// Markdown tables and headings must not be broken or spoofed by imported text.
const md = (s: unknown) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]#|<>])/g, '\\$1');

export function exportCase(c: RecallCase, format: ExportFormat, memoryState: MemoryState | null, now: string): { name: string; type: string; content: string } {
  const r = reconcileCase(c), base = `recallreach-${safeName(c.alert.batch)}`;
  const ref = (id: string) => c.records.find(row => row.id === id)?.reference || id;
  if (format === 'evidence') {
    const rows = c.records.map(row => ({ ...row, source_name: c.sources.find(s => s.id === row.source_id)?.name ?? '', result: r.record_status[row.id]?.status, reason: r.record_status[row.id]?.reason }));
    return { name: `${base}-evidence.csv`, type: 'text/csv', content: toCsv(rows, [...CSV_COLUMNS, 'source_name', 'source_row', 'result', 'reason']) };
  }
  const memory = memoryState ? new CaseMemory(c.id, 'export', memoryState).list({ c, r }) : [];
  if (format === 'archive') {
    return { name: `${base}-case.json`, type: 'application/json', content: JSON.stringify({
      exported_at: now, rules_version: RULES_VERSION, note: 'Quantities are source-reported. The audit hash chain checks internal consistency only; it does not make this file tamper-proof.',
      case: c, result: r, memory: { engine: MEMORY_ENGINE, records: memory },
    }, null, 2) };
  }
  const st = staleness(c, r), run = c.agent_runs.at(-1);
  const lines = [
    '# RecallReach investigation report', '',
    `- Case: ${md(c.name)}`, `- Mode: ${c.mode === 'drill' ? 'Fictional training drill' : 'Operator-created investigation'}`,
    `- Exported: ${now} (case version ${c.version}, rules v${RULES_VERSION})`,
    `- Scope: ${md(c.alert.manufacturer)} / ${md(c.alert.product)} / batch ${md(c.alert.batch)} (unit: ${md(c.alert.unit)})`,
    `- Source notice: ${md(c.alert.source_url || 'Not supplied')}`,
    `- Last investigation: ${c.investigated_at ?? 'never'}${st.stale ? ' — evidence has changed since then; conclusions may be stale' : ''}`, '',
    `## Source-reported quantities (${md(c.alert.unit)})`, '',
    '| State | Quantity |', '| --- | ---: |',
    `| Accepted opening | ${r.shipped} |`, `| Available / awaiting containment | ${r.available} |`, `| Quarantined | ${r.quarantined} |`, `| Returned | ${r.returned} |`, `| Dispensed | ${r.dispensed} |`, `| Reported contained (quarantined + returned) | ${r.contained} (${r.coverage}%) |`, '',
    `Evidence: ${r.applied_ids.length} accepted, ${r.duplicate_ids.length} duplicates counted once, ${r.review_ids.length} held for review, ${r.excluded_ids.length} outside this alert, ${r.superseded_ids.length} superseded by corrections.`, '',
    'Quantities reflect imported records, not physical inspection. Records held for review are excluded from totals. Complete distribution coverage is not established. Dispensed quantities are not evidence of consumption or harm. Approval is not completion.', '',
    '## Findings', '',
    ...r.issues.flatMap(i => [`### ${md(i.title)}`, '', `${md(i.kind)} (${i.severity}). ${md(i.explanation)}`, '', `Next step: ${md(i.next_step)}`, '', `Evidence: ${i.evidence_ids.slice(0, 12).map(id => md(ref(id))).join(', ')}${i.evidence_ids.length > 12 ? ` and ${i.evidence_ids.length - 12} more` : ''}`, '']),
    ...(run ? ['## Latest investigation run', '', `- ${run.mode === 'live' ? `Live model: ${md(run.provider)} ${md(run.model)}` : 'Rules mode (no language model)'}; status ${run.status}; ${run.steps.length} tool steps; ${run.duration_ms} ms`, `- Question: ${md(run.question)}`, `- Summary (${run.mode === 'live' ? 'model-written' : 'rules-written'}): ${md(run.answer?.summary ?? run.status_detail)}`, '',
      ...(run.answer?.findings ?? []).map(f => `- [${f.verification}] ${md(f.claim)} (cites: ${f.citations.map(id => md(ref(id))).join(', ') || 'none'})${f.problems.length ? ` — ${md(f.problems.join(' '))}` : ''}`), ''] : []),
    '## Proposed and decided follow-ups', '',
    ...(c.proposals.length ? c.proposals.map(p => `- ${p.status.toUpperCase()}: ${md(p.action)} (owner: ${p.owner_role.replace(/_/g, ' ')}; issue ${md(p.issue_id)})${p.decided_by ? ` — ${md(p.decided_by)}, ${p.decided_at}` : ''}`) : ['- None']), '',
    '## Human decisions', '', ...(c.decisions.length ? c.decisions.map(d => `- ${d.at} | ${md(d.actor)} | ${d.status} | ${md(d.issue_id)} | ${md(d.note)}`) : ['- None']), '',
    '## Corrections', '', ...(c.corrections.length ? c.corrections.map(k => `- ${k.at} | ${md(k.actor)} | ${k.kind} ${md(ref(k.original_id))}${k.replacement_id ? ` → ${md(ref(k.replacement_id))}` : ''} | ${md(k.reason)} | evidence: ${md(k.evidence_reference)}`) : ['- None']), '',
    `## Investigation memory (${MEMORY_ENGINE})`, '', ...(memory.length ? memory.slice(0, 30).map(m => `- [${m.validity}] ${m.kind}, ${m.review}: ${md(m.content)}`) : ['- None']), '',
    '## Activity (hash-chained)', '', ...c.audit.map(a => `- ${a.at} | ${md(a.actor)} | ${md(a.action)} | ${md(a.detail)} | SHA-256 ${a.hash}`), '',
    'The hash chain lets a reader check that this history is internally consistent. It does not make the history tamper-proof or prove that any source or physical action is authentic. RecallReach sends no messages and gives no clinical advice.',
  ];
  return { name: `${base}-report.md`, type: 'text/markdown', content: lines.join('\n') };
}
