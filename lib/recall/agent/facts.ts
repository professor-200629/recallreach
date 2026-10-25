import { z } from 'zod/v4';
import type { FactDependency, FactType, LedgerRecord, StockState, ValidatedFact } from '../types.ts';
import type { ToolContext } from './tools.ts';

// The only factual statements RecallReach validates. Each one names an entity, a predicate and
// (where relevant) a quantity and unit, and is checked field by field against the engine or the
// exact evidence delivered to the agent in this run. A number that happens to appear somewhere
// else in the case is never enough. The wording shown to the operator is generated here from the
// validated fields; the agent's own prose is kept separately as unverified interpretation.
const STATES = ['available', 'quarantined', 'returned', 'dispensed'] as const;
const FROM_STATES = ['none', ...STATES] as const;
const STATUSES = ['applied', 'review', 'duplicate', 'excluded', 'superseded'] as const;
const MEASURES = ['accepted', 'available', 'quarantined', 'returned', 'dispensed', 'contained'] as const;
const snapshot = z.string().max(40).optional().describe('Evidence snapshot this fact refers to (from run_reconciliation). Omit for the current evidence.');
const note = z.string().max(300).optional().describe('Optional context. Shown as unverified interpretation, never as part of the checked fact.');
const qty = z.number().int().min(0).max(1_000_000);
const unit = z.string().min(1).max(40);

export const FACT_SCHEMA = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shipment_balance'), shipment_id: z.string().min(1).max(40), state: z.enum(STATES), quantity: qty, unit, snapshot, note })
    .describe('Engine balance of one shipment in one stock state. Requires the shipment balance from run_reconciliation or get_shipment_ledger in this run.'),
  z.object({ type: z.literal('case_total'), measure: z.enum(MEASURES), quantity: qty, unit, snapshot, note })
    .describe('Engine total across the case. Requires run_reconciliation in this run.'),
  z.object({ type: z.literal('record_report'), record: z.string().regex(/^E\d{1,4}$/), shipment_id: z.string().min(1).max(40), from_state: z.enum(FROM_STATES), to_state: z.enum(STATES), quantity: qty, unit, note })
    .describe('What one imported record reports (a source report, not proof of physical handling). The record must have been returned to you in this run.'),
  z.object({ type: z.literal('record_status'), record: z.string().regex(/^E\d{1,4}$/), status: z.enum(STATUSES), note })
    .describe('How the engine treated one record (applied, review, duplicate, excluded, superseded). The record must have been returned to you in this run.'),
  z.object({ type: z.literal('open_issue'), issue_id: z.string().min(1).max(200), note })
    .describe('An issue the current reconciliation reports as open. The issue must have been returned to you in this run.'),
  z.object({ type: z.literal('change_since_previous'), comparison: z.string().regex(/^D\d{1,3}$/), shipment_id: z.string().max(40).optional().describe('Omit for a case total.'), field: z.enum(['shipped', ...STATES]), before: qty, after: qty, note })
    .describe('A change between the previous run snapshot and now, from compare_with_previous_run in this run.'),
  z.object({ type: z.literal('source_row_report'), row: z.string().regex(/^X\d{1,4}$/), shipment_id: z.string().min(1).max(40), from_state: z.enum(FROM_STATES), to_state: z.enum(STATES), quantity: qty, unit, note })
    .describe('What one connected-source row returned by query_connected_source in this run reports. It is not case evidence until imported.'),
]);
export type FactInput = z.infer<typeof FACT_SCHEMA>;

const norm = (s: string) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
/** Units match when they are the same word, ignoring case and a plural "s" or "es" ("bottle" = "bottles", "box" = "boxes"). */
export const sameUnit = (a: string, b: string) => { const x = norm(a), y = norm(b); return !!x && [y, `${y}s`, `${y}es`].includes(x) || !!y && [`${x}s`, `${x}es`].includes(y); };
const fmt = (n: number) => n.toLocaleString('en-US');
const STATE_WORDS: Record<StockState, string> = { available: 'available (no accepted quarantine, return or dispensing record)', quarantined: 'reported quarantined', returned: 'reported returned', dispensed: 'recorded as dispensed' };
const MEASURE_WORDS: Record<(typeof MEASURES)[number], string> = { accepted: 'accepted on opening shipment records', available: 'available with no accepted containment record', quarantined: 'reported quarantined', returned: 'reported returned', dispensed: 'recorded as dispensed', contained: 'reported contained (quarantined plus returned)' };
const movementWords = (from: string, to: string) => from === '' || from === 'none' ? `an opening shipment into ${to}` : `a movement from ${from} to ${to}`;

type Check = Omit<ValidatedFact, 'type' | 'claimed' | 'status' | 'note' | 'snapshot'>;
const reject = (base: Partial<Check>, problems: string[]): Check => ({ statement: null, basis: 'engine_calculated', entity: { kind: 'case', id: 'case' }, predicate: '', quantity: null, unit: null, scope: '', evidence: [], dependencies: [], ...base, problems });

export function validateFact(input: FactInput, ctx: ToolContext): ValidatedFact {
  const caseUnit = ctx.c.alert.unit, snap = ctx.current.fingerprint;
  const claimed = { ...input } as Record<string, unknown>; delete claimed.note;
  const problems: string[] = [];
  if ('snapshot' in input && input.snapshot && input.snapshot !== snap) problems.push(`Refers to evidence snapshot ${input.snapshot}; the current snapshot is ${snap}. Re-read the current evidence.`);
  const check = run(input, ctx, caseUnit);
  const all = [...problems, ...check.problems];
  return { type: input.type as FactType, status: all.length ? 'rejected' : 'validated', claimed, ...check, statement: all.length ? null : check.statement, problems: all, snapshot: snap, ...(input.note ? { note: input.note } : {}) };
}

function run(f: FactInput, ctx: ToolContext, caseUnit: string): Check {
  const r = ctx.r, d = ctx.delivered;
  switch (f.type) {
    case 'shipment_balance': {
      const b = r.shipments.find(s => norm(s.shipment_id) === norm(f.shipment_id));
      const base: Partial<Check> = { entity: { kind: 'shipment', id: f.shipment_id }, predicate: `balance.${f.state}`, quantity: f.quantity, unit: f.unit, scope: `engine:shipment:${f.shipment_id}`, dependencies: [{ kind: 'shipment', shipment_id: b?.shipment_id ?? f.shipment_id }] };
      if (!b) return reject(base, [`The engine has no accepted opening record for shipment ${f.shipment_id}, so it has no balance.`]);
      const problems: string[] = [];
      if (!d.shipments.has(b.shipment_id)) problems.push(`The balance of ${b.shipment_id} was not returned to the agent in this run (use run_reconciliation or get_shipment_ledger).`);
      if (!sameUnit(f.unit, caseUnit)) problems.push(`Unit “${f.unit}” is not the case unit “${caseUnit}”. Balances are only kept in the case unit.`);
      if (b[f.state] !== f.quantity) problems.push(`The engine reports ${b.shipment_id} ${f.state} = ${fmt(b[f.state])} ${caseUnit}, not ${fmt(f.quantity)}.`);
      if (problems.length) return reject(base, problems);
      return { ...base, basis: 'engine_calculated', unit: caseUnit, evidence: [`engine:shipment:${b.shipment_id}`, ...b.evidence_ids], problems: [],
        statement: `Shipment ${b.shipment_id} (${b.location}): ${fmt(b[f.state])} ${caseUnit} ${STATE_WORDS[f.state]}, of ${fmt(b.quantity)} accepted. Calculated by the engine from accepted records.` } as Check;
    }
    case 'case_total': {
      const value = f.measure === 'accepted' ? r.shipped : f.measure === 'contained' ? r.contained : r[f.measure];
      const base: Partial<Check> = { entity: { kind: 'case', id: 'case' }, predicate: `total.${f.measure}`, quantity: f.quantity, unit: f.unit, scope: 'engine:totals', dependencies: [{ kind: 'case' }] };
      const problems: string[] = [];
      if (!d.totals) problems.push('Case totals were not returned to the agent in this run (use run_reconciliation).');
      if (!sameUnit(f.unit, caseUnit)) problems.push(`Unit “${f.unit}” is not the case unit “${caseUnit}”.`);
      if (value !== f.quantity) problems.push(`The engine reports ${f.measure} = ${fmt(value)} ${caseUnit} for the case, not ${fmt(f.quantity)}.`);
      if (problems.length) return reject(base, problems);
      return { ...base, basis: 'engine_calculated', unit: caseUnit, evidence: ['engine:totals'], problems: [], statement: `Across the case: ${fmt(value)} ${caseUnit} ${MEASURE_WORDS[f.measure]}. Calculated by the engine from accepted records.` } as Check;
    }
    case 'record_report':
    case 'record_status': {
      const id = ctx.handles.get(f.record), row = id ? ctx.c.records.find(x => x.id === id) : undefined;
      const base: Partial<Check> = { entity: { kind: 'record', id: id ?? f.record }, predicate: f.type === 'record_report' ? 'record.reports' : 'record.status', scope: `record:${id ?? f.record}`, dependencies: id ? [{ kind: 'record', record_id: id }] : [], basis: f.type === 'record_report' ? 'source_reported' : 'engine_calculated' };
      if (!row) return reject(base, [`${f.record} is not a record handle returned in this run.`]);
      if (!d.records.has(row.id)) return reject(base, [`${f.record} was only referenced, not returned with its contents in this run (for example by a memory or an issue list). Retrieve it with get_source_row, search_records or get_shipment_ledger first.`]);
      const source = ctx.c.sources.find(s => s.id === row.source_id), where = `${source?.name ?? 'unknown source'}, row ${row.source_row}`;
      const status = r.record_status[row.id];
      if (f.type === 'record_status') {
        if (status?.status !== f.status) return reject({ ...base, unit: null }, [`The engine treated ${f.record} as ${status?.status ?? 'unknown'}, not ${f.status}.`]);
        return { ...base, quantity: null, unit: null, evidence: [row.id], problems: [], statement: `Record ${label(row)} (${where}) is ${statusWords(status.status)}: ${status.reason}` } as Check;
      }
      const problems = recordMismatch(f, { shipment_id: row.shipment_id, from_state: row.from_state, to_state: row.to_state, quantity: row.raw_quantity !== undefined ? Number(row.raw_quantity) : row.quantity, unit: row.unit }, f.record);
      if (problems.length) return reject({ ...base, quantity: f.quantity, unit: f.unit }, problems);
      const counted = status?.status === 'applied' ? '' : ` The engine did not count it (${status?.status ?? 'unknown'}: ${status?.reason ?? 'no reason recorded'}).`;
      return { ...base, quantity: row.quantity, unit: row.unit, evidence: [row.id], problems: [],
        statement: `${where} reports ${movementWords(row.from_state, row.to_state)} of ${row.raw_quantity ?? fmt(row.quantity)} ${row.unit} for shipment ${row.shipment_id} at “${row.location}” (${row.reference || 'no reference'}, ${row.occurred_at || 'no time'}). This is a source report, not proof of physical handling.${counted}` } as Check;
    }
    case 'open_issue': {
      const issue = r.issues.find(i => i.id === f.issue_id.replace(/^issue:/, ''));
      const base: Partial<Check> = { entity: { kind: 'issue', id: f.issue_id }, predicate: 'issue.open', scope: `issue:${f.issue_id}` };
      if (!issue) return reject(base, [`${f.issue_id} is not an open issue in the current reconciliation.`]);
      if (!d.issues.has(issue.id)) return reject(base, [`Issue ${issue.id} was not returned to the agent in this run.`]);
      const deps: FactDependency[] = issue.shipment_id ? [{ kind: 'shipment', shipment_id: issue.shipment_id }] : [{ kind: 'case' }];
      return { ...base, basis: 'engine_calculated', quantity: issue.quantity ?? null, unit: issue.quantity !== undefined ? caseUnit : null, evidence: [issue.id, ...issue.evidence_ids], dependencies: deps, problems: [], statement: `Open issue, ${issue.kind}: ${issue.title}. ${issue.explanation}` } as Check;
    }
    case 'change_since_previous': {
      const diff = ctx.diffData.get(f.comparison), scopeId = f.shipment_id ? `shipment ${f.shipment_id}` : 'the case';
      const base: Partial<Check> = { entity: { kind: 'comparison', id: f.comparison }, predicate: `change.${f.field}`, quantity: f.after, unit: caseUnit, scope: `diff:${ctx.diffs.get(f.comparison) ?? f.comparison}`, dependencies: f.shipment_id ? [{ kind: 'shipment', shipment_id: f.shipment_id }] : [{ kind: 'case' }] };
      if (!diff || !d.diffs.has(f.comparison)) return reject(base, [`${f.comparison} is not a comparison returned in this run.`]);
      if (!diff.previous) return reject(base, ['There is no previous run to compare with.']);
      let before: number | undefined, after: number | undefined;
      if (f.shipment_id) {
        if (f.field === 'shipped') return reject(base, ['Per-shipment changes are reported for stock states, not for shipped totals.']);
        const s = diff.shipments.find(x => norm(x.shipment_id) === norm(f.shipment_id!));
        before = s ? s.before?.[f.field] ?? 0 : ctx.previous?.shipments[f.shipment_id]?.[f.field]; after = s ? s.after?.[f.field] ?? 0 : ctx.current.shipments[f.shipment_id]?.[f.field];
      } else {
        const t = diff.totals.find(x => x.field === f.field);
        before = t ? t.before : ctx.previous?.totals[f.field]; after = t ? t.after : ctx.current.totals[f.field];
      }
      if (before === undefined || after === undefined) return reject(base, [`The comparison has no ${f.field} figure for ${scopeId}.`]);
      if (before !== f.before || after !== f.after) return reject(base, [`The comparison shows ${scopeId} ${f.field} ${fmt(before)} → ${fmt(after)} ${caseUnit}, not ${fmt(f.before)} → ${fmt(f.after)}.`]);
      return { ...base, basis: 'engine_calculated', evidence: [ctx.diffs.get(f.comparison)!], problems: [], statement: `Since the run at ${diff.previous.at}: ${scopeId} ${f.field} changed from ${fmt(before)} to ${fmt(after)} ${caseUnit}. Calculated by the engine from the two evidence snapshots.` } as Check;
    }
    case 'source_row_report': {
      const x = ctx.externalRows.get(f.row);
      const base: Partial<Check> = { entity: { kind: 'external_row', id: f.row }, predicate: 'source_row.reports', basis: 'source_reported', scope: x ? `zetaris:${x.instance}:${x.table}:${x.row_key}` : `zetaris:${f.row}` };
      if (!x) return reject(base, [`${f.row} is not a connected-source row returned in this run.`]);
      if (!d.externals.has(f.row)) return reject(base, [`${f.row} was not delivered to the agent in this run.`]);
      const v = x.values, problems = recordMismatch(f, { shipment_id: v.shipment_id, from_state: v.from_state, to_state: v.to_state, quantity: Number(v.quantity), unit: v.unit }, f.row);
      const deps: FactDependency[] = [{ kind: 'external', instance: x.instance, table: x.table, row_key: x.row_key, content_hash: x.hash, captured_at: x.captured_at, query_scope: x.query_scope }];
      if (problems.length) return reject({ ...base, dependencies: deps }, problems);
      return { ...base, quantity: Number(v.quantity), unit: v.unit, dependencies: deps, evidence: [`zetaris:${x.instance}:${x.table}:${x.row_key}`], problems: [],
        statement: `Zetaris (${x.mode === 'mock' ? 'MOCK fixture, not a Zetaris query' : 'live'}) ${x.table} row ${x.row_key} reports ${movementWords(v.from_state, v.to_state)} of ${v.quantity} ${v.unit} for shipment ${v.shipment_id} at “${v.location}” (${v.reference || 'no reference'}, ${v.occurred_at || 'no time'}). It is not case evidence until an operator imports it, and it is not proof of physical handling.` } as Check;
    }
  }
}

function recordMismatch(f: { shipment_id: string; from_state: string; to_state: string; quantity: number; unit: string }, actual: { shipment_id: string; from_state: string; to_state: string; quantity: number; unit: string }, handle: string): string[] {
  const problems: string[] = [], from = actual.from_state || 'none';
  if (norm(f.shipment_id) !== norm(actual.shipment_id)) problems.push(`${handle} is about shipment ${actual.shipment_id || '(none)'}, not ${f.shipment_id}.`);
  if (f.from_state !== from || f.to_state !== actual.to_state) problems.push(`${handle} reports ${movementWords(actual.from_state, actual.to_state)}, not ${movementWords(f.from_state, f.to_state)}.`);
  if (f.quantity !== actual.quantity) problems.push(`${handle} reports a quantity of ${actual.quantity}, not ${f.quantity}.`);
  if (!sameUnit(f.unit, actual.unit)) problems.push(`${handle} reports the unit “${actual.unit}”, not “${f.unit}”.`);
  return problems;
}

const label = (row: LedgerRecord) => row.reference || row.event_id || row.id;
const statusWords = (s: string) => ({ applied: 'counted in the balances', review: 'held for review and not counted', duplicate: 'a duplicate, counted once', excluded: 'outside this recall scope and not counted', superseded: 'superseded by a correction and not counted' } as Record<string, string>)[s] ?? s;

/** The checked summary: generated from validated facts only, never from the model's prose. */
export function validatedSummary(facts: ValidatedFact[]): string[] {
  return facts.filter(f => f.status === 'validated' && f.statement).map(f => f.statement!);
}
