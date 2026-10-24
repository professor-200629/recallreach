import type { CitedClaim, MissingEvidence, ProposedFollowUp, VerifiedAnswer } from '../types.ts';
import { TOOLS, type FinalArgs, type ToolContext } from './tools.ts';

const TOOL_NAMES = new Set<string>([...TOOLS.map(t => t.name), 'submit_findings']);

// Checks a submitted answer against what the run actually retrieved. Claims keep their
// text, but anything unsupported is labelled unverified with the reason, and citations
// to records the run never retrieved are rejected.
const OVERREACH: [RegExp, string, boolean][] = [
  [/\brecall (is |has been |was )?(now )?(complete|completed|closed|finished|resolved)\b/i, 'declares the recall complete', true],
  [/\b(physically|visually) (verified|confirmed|checked|inspected)\b/i, 'claims physical verification', true],
  [/\b(destination|recipient|location) (is |was |has been )?(now )?(confirmed|verified|established)\b/i, 'claims the destination is verified', true],
  [/\b(all|every)\b[^.]{0,25}\b(stock|bottles?|pens?|units?|packs?|vials?|boxes?)\b[^.]{0,20}\b(safe|contained|quarantined|accounted for|resolved)\b/i, 'declares all stock contained', true],
  [/\b(no|zero|none of the) (patients?|people|one)\b[^.]{0,20}\b(harmed|affected|exposed|at risk)\b/i, 'asserts a patient outcome', false],
  [/\bpatients?\b[^.]{0,30}\b(were|was|are) (harmed|injured|exposed|unaffected|safe)\b/i, 'asserts a patient outcome', false],
];
const NEGATION = /\b(not|cannot|can't|isn't|aren't|wasn't|weren't|unable|doesn't|don't|hasn't|haven't|never|without|no evidence|unconfirmed|unverified|until)\b/i;

export function overreach(text: string): string[] {
  const problems: string[] = [];
  for (const sentence of text.split(/(?<=[.!?;])\s+/)) {
    for (const [re, label, negatable] of OVERREACH) {
      const m = re.exec(sentence);
      if (m && !(negatable && NEGATION.test(sentence.slice(0, m.index + m[0].length)))) problems.push(`States a conclusion RecallReach cannot establish: ${label}.`);
    }
  }
  return [...new Set(problems)];
}

function quantities(text: string, unit: string): number[] {
  const stem = unit.trim().toLowerCase().replace(/e?s$/, '');
  const words = ['bottle', 'pen', 'unit', 'pack', 'box', 'boxe', 'tablet', 'vial', 'item', stem].filter(Boolean).map(w => w.replace(/[^a-z]/g, '')).filter(Boolean);
  const re = new RegExp(`(?<![\\d.,])(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)\\s*(%|percent\\b|(?:${[...new Set(words)].join('|')})(?:e?s)?\\b)`, 'gi');
  return [...text.matchAll(re)].map(m => Number(m[1].replaceAll(',', '')));
}

export function resolveCitation(token: string, ctx: ToolContext): string | null {
  const t = token.trim();
  if (ctx.handles.has(t)) return ctx.handles.get(t)!;
  if (ctx.externalRows.has(t)) { const x = ctx.externalRows.get(t)!; return `${x.mode === 'mock' ? 'zetaris-mock' : 'zetaris'}:${x.table}:${x.row_key}`; }
  const issue = t.replace(/^issue:/, '');
  if (ctx.issueIds.has(issue)) return issue;
  if (ctx.diffs.has(t)) return ctx.diffs.get(t)!;
  if (ctx.memoryIds.has(t)) return `memory:${t}`;
  return null;
}

const UNRESOLVED = /\b(unresolved|awaiting containment|unaccounted|not (yet )?contained|without (an? )?(accepted )?(containment|quarantine)|lacks? (an? |any )?(accepted )?containment|still available|remains? available)\b/i;
const CONTAINED = /\b(quarantined|returned|contained|dispensed)\b/i;
const PRESENT = /\b(remain|remains|still|currently|now|is|are|has|have)\b/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A present-tense "N units unresolved" statement about a shipment must match the engine's current balance. */
export function contradictsEngine(text: string, ctx: ToolContext, unit: string): string[] {
  if (!UNRESOLVED.test(text) || !PRESENT.test(text) || CONTAINED.test(text)) return [];
  const mentioned = ctx.r.shipments.filter(s => new RegExp(`\\b${escapeRe(s.shipment_id)}\\b`).test(text));
  if (mentioned.length !== 1) return [];
  // Ignore the shipment's opening total when stated as context ("out of 200 pens accepted").
  const s = mentioned[0], stated = quantities(text.replace(/\bout of [\d,]+\s*\w+\s+accepted\b/gi, ''), unit);
  return stated.some(n => n !== s.available) ? [`Contradicts the current reconciliation: ${s.shipment_id} has ${s.available} ${unit} awaiting containment.`] : [];
}

function check(text: string, citations: string[], ctx: ToolContext, unit: string, basis: CitedClaim['basis'] | null) {
  const problems: string[] = [], resolved: string[] = [], rejected: string[] = [];
  for (const token of citations) { const id = resolveCitation(token, ctx); if (id) resolved.push(id); else rejected.push(token); }
  for (const token of rejected) problems.push(TOOL_NAMES.has(token) ? `Cited the tool name “${token}” instead of an identifier it returned.` : `Citation “${token}” was not retrieved in this run.`);
  if (!resolved.length) problems.push('No valid citation supports this statement.');
  else if (resolved.every(id => id.startsWith('memory:'))) problems.push('Supported only by earlier memory. Memory is context, not current evidence; cite current records or issues.');
  for (const id of resolved) if (id.startsWith('memory:') && ctx.disputedMemoryIds.has(id.slice(7))) problems.push(`Cites ${id.slice(7)}, which an operator marked wrong.`);
  problems.push(...contradictsEngine(text, ctx, unit));
  for (const n of quantities(text, unit)) if (!ctx.numbers.has(n)) problems.push(`Quantity ${n} does not match any retrieved record or reconciliation figure.`);
  if (basis === 'engine_calculated' && !ctx.toolsUsed.has('run_reconciliation') && !ctx.toolsUsed.has('get_shipment_ledger')) problems.push('Marked as engine-calculated, but the reconciliation was not consulted.');
  if (basis === 'unverified') problems.push('The agent itself marked this as unverified.');
  problems.push(...overreach(text));
  return { resolved: [...new Set(resolved)], rejected, problems };
}

export function verifyAnswer(args: FinalArgs, ctx: ToolContext): VerifiedAnswer & { summary_problems: string[] } {
  const unit = ctx.c.alert.unit, rejected: string[] = [];
  const findings: CitedClaim[] = args.findings.map(f => {
    const v = check(f.claim, f.citations, ctx, unit, f.basis); rejected.push(...v.rejected);
    return { claim: f.claim, citations: v.resolved, basis: f.basis, verification: v.problems.length ? 'unverified' : 'verified', problems: v.problems };
  });
  const missing: MissingEvidence[] = args.missing_evidence.map(m => {
    const v = check(`${m.description} ${m.would_resolve}`, m.citations, ctx, unit, null); rejected.push(...v.rejected);
    return { description: m.description, would_resolve: m.would_resolve, citations: v.resolved, verification: v.problems.length ? 'unverified' : 'verified', problems: v.problems };
  });
  const follow_ups: ProposedFollowUp[] = ctx.proposals.map(p => ({
    issue_id: p.issue_id, action: p.action, owner_role: p.owner_role, evidence_requested: p.evidence_requested,
    citations: p.citations.map(h => resolveCitation(h, ctx)).filter((x): x is string => !!x), accepted: true, problems: overreach(`${p.action} ${p.evidence_requested}`),
  }));
  const summaryProblems = [...overreach(args.summary), ...quantities(args.summary, unit).filter(n => !ctx.numbers.has(n)).map(n => `Summary quantity ${n} does not match retrieved evidence.`)];
  return { summary: args.summary, summary_problems: summaryProblems, findings, missing_evidence: missing, follow_ups, rejected_citations: [...new Set(rejected)] };
}
