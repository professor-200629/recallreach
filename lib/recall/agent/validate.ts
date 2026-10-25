import type { EvidenceRequest, Interpretation, ProposedFollowUp, VerifiedAnswer } from '../types.ts';
import { citesDelivered, citesIn, notDeliveredReason, TOOLS, type FinalArgs, type ToolContext } from './tools.ts';
import { validateFact, validatedSummary } from './facts.ts';

const TOOL_NAMES = new Set<string>([...TOOLS.map(t => t.name), 'submit_findings']);

// Builds the checked answer. Only typed facts can be validated, and each is checked field by field
// (validateFact). Everything else the agent writes (its summary, interpretations and evidence
// requests) is kept and shown, but never labelled verified. The patterns below only warn when free
// text states a conclusion RecallReach can never establish; they are not how facts are checked.
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

/** Maps a citation to a stable identifier, or null if it names nothing the run returned. Memory IDs map to memory:<id> (context, not evidence). */
export function resolveCitation(token: string, ctx: ToolContext): string | null {
  const t = token.trim();
  if (ctx.handles.has(t)) return ctx.handles.get(t)!;
  if (ctx.externalRows.has(t)) { const x = ctx.externalRows.get(t)!; return `zetaris:${x.instance}:${x.table}:${x.row_key}`; }
  const issue = t.replace(/^issue:/, '');
  if (ctx.issueIds.has(issue)) return issue;
  if (ctx.diffs.has(t)) return ctx.diffs.get(t)!;
  if (ctx.memoryIds.has(t)) return `memory:${t}`;
  return null;
}

export function verifyAnswer(args: FinalArgs, ctx: ToolContext): VerifiedAnswer {
  const rejected: string[] = [];
  const facts = args.facts.map(f => validateFact(f, ctx));
  const interpretations: Interpretation[] = args.interpretations.map(i => {
    const related: string[] = [], problems = overreach(i.text);
    for (const token of i.related) {
      const t = token.trim();
      if (ctx.memoryIds.has(t)) { related.push(`memory:${t}`); if (ctx.disputedMemoryIds.has(t)) problems.push(`Points to ${t}, which an operator marked wrong.`); continue; }
      if (citesDelivered(t, ctx)) { related.push(resolveCitation(t, ctx)!); continue; }
      rejected.push(t);
      problems.push(TOOL_NAMES.has(t) ? `Pointed to the tool name “${t}” instead of an identifier it returned.` : `“${t}” is not evidence the agent had read: ${notDeliveredReason(t, ctx)}.`);
    }
    return { text: i.text, related: [...new Set(related)], problems };
  });
  const evidence_requests: EvidenceRequest[] = args.evidence_requests.map(e => {
    const id = e.issue_id.trim().replace(/^issue:/, ''), exists = ctx.r.issues.some(i => i.id === id), linked = exists && ctx.delivered.issues.has(id);
    return { issue_id: id, description: e.description, would_change: e.would_change, linked,
      problems: [...(linked ? [] : [exists ? `Issue ${id} is not evidence the agent had read: ${citesIn(id, ctx, ctx.pending) || citesIn(id, ctx, ctx.summarised) ? notDeliveredReason(id, ctx) : 'it was not returned to the agent in this run'}.` : `${id} is not an open issue in the current reconciliation.`]), ...overreach(`${e.description} ${e.would_change}`)] };
  });
  const follow_ups: ProposedFollowUp[] = ctx.proposals.map(p => ({
    issue_id: p.issue_id, action: p.action, owner_role: p.owner_role, evidence_requested: p.evidence_requested,
    citations: p.citations.map(h => resolveCitation(h, ctx)).filter((x): x is string => !!x), accepted: true, problems: overreach(`${p.action} ${p.evidence_requested}`),
  }));
  return {
    version: 2, summary: args.summary, summary_problems: overreach(args.summary), validated_summary: validatedSummary(facts),
    facts, interpretations, evidence_requests, findings: [], missing_evidence: [], follow_ups, rejected_citations: [...new Set(rejected)],
  };
}
