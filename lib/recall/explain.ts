import type { Issue, LedgerRecord, RecallCase, Reconciliation, Source, StockState, ValidatedFact } from './types.ts';
import { reconcile, supersededMap } from './engine.ts';

// Evidence Challenge ("Why this finding?"). Every line is derived from the engine's record statuses,
// the case records and the fact's typed fields. Nothing is estimated and no probabilities are given.
const STATES: StockState[] = ['available', 'quarantined', 'returned', 'dispensed'];
const UNCONFIRMED = /\b(pending|unknown|unconfirmed|tbc|tbd|to be confirmed)\b/i;
const fmt = (n: number) => n.toLocaleString('en-US');
const label = (row: LedgerRecord) => row.reference || row.event_id || `row ${row.source_row}`;
const minute = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
const list = (xs: string[], word: 'and' | 'or') => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${word} ${xs.at(-1)}`;

export type Balance = Record<StockState, number>;
export type ChallengeStep = { record_id: string; text: string; balance: Balance };
export type ChallengeItem = { record_id: string | null; text: string };
/** One evidence source and the records in it that name the shipment (empty: no imported record from it does). */
export type SourceView = { source_id: string; name: string; via: string; items: ChallengeItem[] };
export type Challenge = {
  title: string; statement: string; basis: 'engine_calculated' | 'source_reported';
  /** One plain line answering the question, built from the engine balance and which sources name the shipment. */
  answer: string | null;
  sources: SourceView[];
  /** Reads of a connected source scoped to this shipment, with what they returned at the time. */
  reads: string[];
  snapshot: { validated: string | null; current: string; changed: boolean } | null;
  evidence: string[];
  calculation: ChallengeStep[]; result: string | null;
  conflicts: ChallengeItem[]; unknowns: string[]; could_change: string[]; approvals: string[];
  changes: { heading: string; items: ChallengeItem[] }[];
  hypothetical: { description: string; before: Balance; after: Balance; closed: string[]; still_open: string[] } | null;
};
type Context = { c: RecallCase; r: Reconciliation; current: string; now?: number; validatedAt?: string; validatedSnapshot?: string };

const empty = (): Balance => ({ available: 0, quarantined: 0, returned: 0, dispensed: 0 });
const balanceText = (b: Balance, unit: string) => STATES.map(s => `${fmt(b[s])} ${s}`).join(', ') + ` (${unit})`;
const byEngineOrder = (a: LedgerRecord, b: LedgerRecord) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || (a.type === b.type ? a.event_id.localeCompare(b.event_id) : a.type === 'shipment' ? -1 : 1);

/** Applied records of one shipment in the engine's order, with the running balance after each. */
function calculation(c: RecallCase, r: Reconciliation, shipmentId: string): ChallengeStep[] {
  const steps: ChallengeStep[] = [], b = empty();
  for (const row of c.records.filter(x => x.shipment_id === shipmentId && r.record_status[x.id]?.status === 'applied').sort(byEngineOrder)) {
    if (row.type === 'shipment') { b.available += row.quantity; steps.push({ record_id: row.id, text: `Opening shipment ${label(row)} at “${row.location}”: +${fmt(row.quantity)} available.`, balance: { ...b } }); continue; }
    b[row.from_state as StockState] -= row.quantity; b[row.to_state as StockState] += row.quantity;
    steps.push({ record_id: row.id, text: `${label(row)} (${row.occurred_at}): ${fmt(row.quantity)} reported moved from ${row.from_state} to ${row.to_state}.`, balance: { ...b } });
  }
  return steps;
}

const movement = (x: LedgerRecord, r: Reconciliation) => `${x.type === 'shipment' ? 'opening shipment' : `${x.from_state} → ${x.to_state}`}, ${x.raw_quantity ?? fmt(x.quantity)} ${x.unit}; ${r.record_status[x.id]?.status ?? 'unknown'}.`;
const kindLabel = (src: Source) => src.kind === 'sample' ? 'fictional training file' : src.kind === 'correction' ? 'operator correction' : src.kind === 'manual' ? 'entered by an operator' : 'CSV import';
// Imports from the same connected-source table are one source system; other sources are grouped by name.
const systemKey = (src: Source) => src.origin ? `${src.origin.mode}|${src.origin.instance ?? ''}|${src.origin.table}` : `name|${src.name}`;
const systemName = (src: Source) => src.origin ? `${src.origin.table} (${src.origin.mode === 'mock' ? 'MOCK connected source, not Zetaris' : 'through Zetaris'})` : src.name;

/** Which source says what about one shipment. Silence is reported as "no imported record names it", never as proof of absence. */
function sourceViews(c: RecallCase, r: Reconciliation, shipmentId: string) {
  const systems = new Map<string, Source[]>();
  for (const src of c.sources) systems.set(systemKey(src), [...(systems.get(systemKey(src)) ?? []), src]);
  const sources: SourceView[] = [...systems.values()].map(group => {
    const reads = group.map(src => src.origin?.fetched_at).filter((x): x is string => !!x).sort();
    return { source_id: group[0].id, name: systemName(group[0]),
      via: reads.length ? `${reads.length} import${reads.length === 1 ? '' : 's'}, last read ${minute(reads.at(-1)!)}` : group.length > 1 ? `${kindLabel(group[0])}, ${group.length} files` : kindLabel(group[0]),
      items: c.records.filter(x => x.shipment_id === shipmentId && group.some(src => src.id === x.source_id)).map(x => ({ record_id: x.id, text: `${label(x)}: ${movement(x, r)}` })) };
  });
  // Shipment-scoped reads through a connected source, grouped when several tables were read together with the same result.
  const groups = new Map<string, { live: boolean; at: string; rows: number; tables: string[] }>();
  for (const [key, o] of Object.entries(c.scope_observations ?? {})) {
    if (!key.endsWith(`|shipment=${shipmentId}`)) continue;
    const [instance, table] = key.split('|'), live = !instance.startsWith('mock:'), id = `${live}|${o.observed_at.slice(0, 16)}|${o.rows}`;
    const g = groups.get(id) ?? { live, at: o.observed_at, rows: o.rows, tables: [] };
    g.tables.push(table); groups.set(id, g);
  }
  const reads = [...groups.values()].sort((a, b) => a.at.localeCompare(b.at)).map(g => `${g.live ? 'Checked live through Zetaris' : 'Read from a MOCK connected source (not Zetaris)'} at ${minute(g.at)}: ${g.rows} row${g.rows === 1 ? '' : 's'} for ${shipmentId} in ${list(g.tables, 'and')} (as of that read).`);
  return { sources, reads };
}

function shipmentChallenge(ctx: Context, shipmentId: string, focus: Issue | null): Omit<Challenge, 'title' | 'statement' | 'basis' | 'snapshot'> {
  const { c, r } = ctx, unit = c.alert.unit, s = r.shipments.find(x => x.shipment_id === shipmentId);
  const issues = r.issues.filter(i => i.shipment_id === shipmentId && i.kind !== 'Record review');
  const steps = calculation(c, r, shipmentId);
  const result = s ? `Engine balance for ${shipmentId}: ${balanceText(s, unit)}, of ${fmt(s.quantity)} accepted.` : `${shipmentId} has no accepted opening record, so the engine keeps no balance for it.`;
  const { sources, reads } = sourceViews(c, r, shipmentId);
  const naming = sources.filter(x => x.items.length).map(x => `“${x.name}”`), silent = sources.filter(x => !x.items.length).map(x => `“${x.name}”`);
  const said = naming.length ? `${silent.length && naming.length === 1 ? 'Only ' : ''}${list(naming, 'and')} ${naming.length === 1 ? 'has an imported record' : 'have imported records'} naming ${shipmentId}${silent.length ? `; no imported record from ${list(silent, 'or')} names it` : ''}.` : `No imported record names ${shipmentId}.`;
  const units = (q: number) => `${fmt(q)} ${q === 1 ? unit.replace(/s$/, '') : unit}`;
  const answer = !s ? result : `${s.available > 0 ? `${units(s.available)} of ${shipmentId} ${s.available === 1 ? 'has' : 'have'} no accepted quarantine, return or dispensing record.` : `Nothing of ${shipmentId} is still “available”: ${units(s.quarantined + s.returned)} reported contained and ${units(s.dispensed)} recorded as dispensed.`} ${said}`;

  // Records about this shipment that were not counted, and review records elsewhere that might be about it.
  const conflicts: ChallengeItem[] = c.records.filter(x => x.shipment_id === shipmentId && r.record_status[x.id]?.status !== 'applied')
    .map(x => ({ record_id: x.id, text: `${label(x)} was not counted (${r.record_status[x.id]?.status}): ${r.record_status[x.id]?.reason}` }));
  const reviews = c.records.filter(x => r.record_status[x.id]?.status === 'review' && x.shipment_id !== shipmentId);
  const near = s ? reviews.filter(x => (s.available > 0 && x.quantity === s.available) || (x.location && x.location.toLowerCase() === s.location.toLowerCase())) : [];
  for (const x of near) conflicts.push({ record_id: x.id, text: `${label(x)} is held for review and shares ${x.quantity === s!.available ? `the quantity ${fmt(x.quantity)}` : `the location “${x.location}”`}, but names shipment ${x.shipment_id || '(none)'}: ${r.record_status[x.id]?.reason}` });
  if (s && s.available > 0 && !near.length) conflicts.push({ record_id: null, text: `None of the ${reviews.length} records held for review elsewhere names ${shipmentId}, its location or a quantity of ${fmt(s.available)}, so no rejected record explains this gap.` });

  const unknowns = ['Quantities are as the records report them; nothing here was physically checked.'];
  if (s && s.available > 0) unknowns.push(`The current status of the ${fmt(s.available)} ${unit} still “available”: no accepted record reports a quarantine, return or dispensing for them.`);
  if (s && UNCONFIRMED.test(s.location)) unknowns.push(`Who holds shipment ${shipmentId}: its opening record names “${s.location}”.${s.quarantined + s.returned > 0 ? ` A reported quarantine or return at that location says where stock is said to be held; it does not name a responsible recipient, so the destination stays unconfirmed.` : ''}`);
  if (s && s.dispensed > 0) unknowns.push(`Who received the ${fmt(s.dispensed)} ${unit} recorded as dispensed, and with what outcome. Records do not show this, and patient information is kept outside this workspace.`);

  const could: string[] = [];
  if (s && s.available > 0) {
    could.push(`A dated quarantine, return or dispensing record for ${shipmentId} (batch ${c.alert.batch}, in ${unit}, at “${s.location}”, with a full timestamp and timezone) would move up to ${fmt(s.available)} out of “available”, once it passes the engine’s identity, unit, chronology and quantity checks.`);
    for (const x of near.filter(x => /timestamp|timezone/i.test(r.record_status[x.id]?.reason ?? ''))) could.push(`Reissuing ${label(x)} with a valid timestamp and the right shipment ID would let the engine check it again.`);
  }
  const opening = steps.find(st => c.records.find(x => x.id === st.record_id)?.type === 'shipment');
  if (opening) { const row = c.records.find(x => x.id === opening.record_id)!; could.push(`An operator correction to the opening record ${label(row)} (with a reason and evidence) would change the accepted quantity.`); }
  if (issues.some(i => i.kind === 'Destination unconfirmed')) could.push('Proof of delivery naming a responsible recipient would close “Destination unconfirmed”. A quarantine or return report alone does not.');
  if (issues.some(i => i.kind === 'Pharmacist follow-up')) could.push('No evidence import closes the dispensing follow-up: a supervising pharmacist reviews the dispensing outside this workspace and the outcome is recorded as a decision.');

  // Decisions about this shipment, including on issues that have since closed.
  const decisions = c.decisions.filter(d => d.issue_id.endsWith(`:${shipmentId}`) || issues.some(i => i.id === d.issue_id) || d.issue_id === focus?.id);
  const approvals = [...decisions.map(d => `${d.actor} ${d.status} “${d.issue_id}” on ${d.at.slice(0, 10)}: ${d.note}`),
    'Approving a follow-up records who will act; it does not change stock. Only imported evidence that passes the engine’s checks changes a balance.'];

  // Evidence added since the previous run, and after this finding was validated.
  const changes: Challenge['changes'] = [];
  const affecting = (from: string, to?: string) => c.sources.filter(src => src.added_at > from && (!to || src.added_at <= to))
    .flatMap(src => c.records.filter(x => x.source_id === src.id && x.shipment_id === shipmentId).map(x => ({ record_id: x.id, text: `${label(x)} from “${src.name}” (${minute(src.added_at)}): ${movement(x, r)}` })));
  const prior = c.snapshots.filter(sn => !ctx.validatedAt || sn.at < ctx.validatedAt).at(-1);
  if (prior) { const items = affecting(prior.at, ctx.validatedAt); if (items.length) changes.push({ heading: `Added since the previous run (${prior.at.slice(0, 16).replace('T', ' ')} UTC)`, items }); }
  if (ctx.validatedAt) { const items = affecting(ctx.validatedAt); if (items.length) changes.push({ heading: 'Added after this finding was validated', items }); }

  // Hypothetical preview: what the engine would calculate if one record contained all available stock.
  let hypothetical: Challenge['hypothetical'] = null;
  if (s && s.available > 0) {
    const at = new Date(ctx.now ?? Date.now()).toISOString();
    const hyp: LedgerRecord = { id: 'hypothetical', event_id: 'HYPOTHETICAL', shipment_id: shipmentId, type: 'movement', from_state: 'available', to_state: 'quarantined', product: c.alert.product, manufacturer: c.alert.manufacturer, batch: c.alert.batch, quantity: s.available, unit, location: s.location, reference: 'HYPOTHETICAL', occurred_at: at, source_id: 'hypothetical', source_row: 0 };
    const after = reconcile(c.alert, [...c.records, hyp], { superseded: supersededMap(c), now: ctx.now });
    const a = after.shipments.find(x => x.shipment_id === shipmentId)!, open = new Set(after.issues.map(i => i.id));
    hypothetical = { description: `If a record reporting all ${fmt(s.available)} ${unit} of ${shipmentId} moved from available to quarantined at “${s.location}” were imported now. Not evidence; nothing is saved.`,
      before: { available: s.available, quarantined: s.quarantined, returned: s.returned, dispensed: s.dispensed }, after: { available: a.available, quarantined: a.quarantined, returned: a.returned, dispensed: a.dispensed },
      closed: issues.filter(i => !open.has(i.id)).map(i => i.title), still_open: issues.filter(i => open.has(i.id)).map(i => i.title) };
  }
  return { answer, sources, reads, evidence: [...(focus ? [focus.id] : []), ...(s?.evidence_ids ?? [])], calculation: steps, result, conflicts, unknowns, could_change: could, approvals, changes, hypothetical };
}

const none = { answer: null, sources: [], reads: [], calculation: [], result: null, conflicts: [], unknowns: [], could_change: [], approvals: [], changes: [], hypothetical: null };

/** "Why this finding?" for an open issue in the current reconciliation. */
export function challengeIssue(issue: Issue, ctx: Context): Challenge {
  const base = { title: issue.title, statement: `${issue.kind}: ${issue.explanation}`, basis: 'engine_calculated' as const, snapshot: null };
  if (issue.shipment_id && issue.kind !== 'Record review' && issue.kind !== 'Possible batch match') return { ...base, ...shipmentChallenge(ctx, issue.shipment_id, issue) };
  const rows = issue.evidence_ids.map(id => ctx.c.records.find(x => x.id === id)).filter((x): x is LedgerRecord => !!x);
  return { ...base, ...none, evidence: [issue.id, ...issue.evidence_ids],
    conflicts: rows.slice(0, 10).map(x => ({ record_id: x.id, text: `${label(x)}: ${ctx.r.record_status[x.id]?.status} — ${ctx.r.record_status[x.id]?.reason}` })),
    unknowns: ['Whether the record describes a real stock movement: it is not counted until it passes the engine’s checks.'],
    could_change: [issue.next_step, 'An operator correction with a reason (supersede or withdraw) would let the engine reassess it.'],
    approvals: ['Acknowledging this issue records that a person saw it; it does not change stock.'] };
}

/** "Why this finding?" for one validated fact from an investigation run. */
export function challengeFact(fact: ValidatedFact, ctx: Context): Challenge {
  const snapshot = { validated: fact.snapshot ?? null, current: ctx.current, changed: !!fact.snapshot && fact.snapshot !== ctx.current };
  const base = { title: `Why: ${fact.statement?.split('. ')[0] ?? fact.predicate}`, statement: fact.statement ?? '', basis: fact.basis, snapshot };
  const ship = fact.dependencies.find(d => d.kind === 'shipment') as { shipment_id: string } | undefined;
  const c = { ...ctx, validatedSnapshot: fact.snapshot };
  if (fact.type === 'shipment_balance' || (fact.type === 'open_issue' && ship) || (fact.type === 'change_since_previous' && ship)) {
    const issue = fact.type === 'open_issue' ? ctx.r.issues.find(i => i.id === fact.entity.id) ?? null : null;
    return { ...base, ...shipmentChallenge(c, ship!.shipment_id, issue) };
  }
  if (fact.type === 'case_total' || fact.type === 'change_since_previous') {
    const measure = fact.predicate.split('.')[1] as StockState | 'accepted' | 'contained' | 'shipped';
    return { ...base, ...none, evidence: fact.evidence,
      calculation: ctx.r.shipments.map(s => ({ record_id: s.evidence_ids[0], text: `${s.shipment_id} (${s.location}): ${measure === 'accepted' || measure === 'shipped' ? fmt(s.quantity) : measure === 'contained' ? fmt(s.quarantined + s.returned) : fmt(s[measure])} ${ctx.c.alert.unit}`, balance: { available: s.available, quarantined: s.quarantined, returned: s.returned, dispensed: s.dispensed } })),
      result: `The case figure is the sum over the ${ctx.r.shipments.length} shipments with an accepted opening record. Records outside this alert or held for review are not counted.`,
      unknowns: ['Quantities are as the records report them; nothing here was physically checked.'],
      could_change: ['Any new or corrected record for one of these shipments that passes the engine’s checks.'], approvals: ['Approvals do not change totals.'] };
  }
  if (fact.type === 'record_report' || fact.type === 'record_status') {
    const row = ctx.c.records.find(x => x.id === fact.entity.id), st = row ? ctx.r.record_status[row.id] : undefined, src = row ? ctx.c.sources.find(x => x.id === row.source_id) : undefined;
    return { ...base, ...none, evidence: fact.evidence,
      result: row ? `${src?.name ?? 'Unknown source'}, row ${row.source_row}. The engine treated it as ${st?.status}: ${st?.reason}` : 'This record is no longer in the case.',
      conflicts: row ? ctx.r.issues.filter(i => i.evidence_ids.includes(row.id) && i.kind !== 'Duplicate evidence' && i.kind !== 'Outside this alert').map(i => ({ record_id: null, text: `Linked issue: ${i.title}` })) : [],
      unknowns: ['A record reports an action; it does not prove the stock was physically handled.'],
      could_change: ['An operator correction (supersede with a replacement, or withdraw) with a reason and evidence. The original is kept.', ...(st?.status === 'review' ? [`Fixing what the engine flagged: ${st.reason}`] : [])],
      approvals: ['Approvals do not change how a record is counted.'] };
  }
  // source_row_report
  const dep = fact.dependencies.find(d => d.kind === 'external') as { captured_at: string; instance: string } | undefined;
  return { ...base, ...none, evidence: fact.evidence,
    result: 'This row was read from a connected source and is not in the case evidence. It counts only after an operator imports it; the engine then checks it like any other record.',
    unknowns: [`Whether the row still says the same at the source: it was captured at ${dep?.captured_at ?? 'an unknown time'} from ${dep?.instance ?? 'an unknown instance'}.`, 'A source row reports an action; it does not prove physical handling.'],
    could_change: ['Importing it (Evidence → Connected sources), after which the engine accepts or holds it for review.', 'A later read showing the row changed or no longer present.'],
    approvals: ['Approvals do not import rows.'] };
}
