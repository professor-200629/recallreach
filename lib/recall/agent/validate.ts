import type { CitedClaim, MissingEvidence, ProposedFollowUp, VerifiedAnswer } from '../types.ts';
import type { FinalArgs, ToolContext } from './tools.ts';

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
  return null;
}

function check(text: string, citations: string[], ctx: ToolContext, unit: string, basis: CitedClaim['basis'] | null) {
  const problems: string[] = [], resolved: string[] = [], rejected: string[] = [];
  for (const token of citations) { const id = resolveCitation(token, ctx); if (id) resolved.push(id); else rejected.push(token); }
  for (const token of rejected) problems.push(`Citation “${token}” was not retrieved in this run.`);
  if (!resolved.length) problems.push('No valid citation supports this statement.');
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
