import { z } from 'zod';
import type { LedgerRecord, RecallCase } from './types.ts';
import { reconcileCase } from './engine.ts';
import { CSV_COLUMNS, parseLedgerCsv, sourceRow } from './csv.ts';
import { createScenarioCase, FOLLOWUP_CSV, FOLLOWUP_SOURCE_NAME, SCENARIOS, toLedgerCsv } from './sample.ts';
import { appendAudit } from './audit.ts';
import { recordSnapshot, takeSnapshot } from './snapshot.ts';
import { EXTERNAL_SOURCE_KEYS, EXTERNAL_SOURCES, rowContentHash, rowIdentity, scopeKey, type CompleteRead, type ExternalFilter, type ExternalRow, type ExternalSourceKey } from './sources/external.ts';

export class ActionError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const fail = (message: string, status = 400): never => { throw new ActionError(message, status); };

const short = z.string().trim().min(1).max(150);
const note = z.string().trim().min(10, 'Add a note of at least 10 characters.').max(2000);
const alertSchema = z.object({ product: short, manufacturer: short, batch: short, unit: short, source_url: z.string().max(1000).refine(s => !s || /^https:\/\//i.test(s) && URL.canParse(s), 'Use a complete HTTPS source URL.'), description: z.string().max(2000) });
export const createSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('sample'), scenario: z.enum(Object.keys(SCENARIOS) as [string, ...string[]]).default('missing-40') }),
  z.object({ action: z.literal('create'), name: short, alert: alertSchema }),
]);
const replacementSchema = z.object(Object.fromEntries(CSV_COLUMNS.map(c => [c, z.string().max(500)])) as Record<string, z.ZodString>);
export const changeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('import'), version: z.number().int(), name: short, content: z.string().max(800000) }),
  z.object({ action: z.literal('investigate'), version: z.number().int() }),
  z.object({ action: z.literal('followup_sample'), version: z.number().int() }),
  z.object({ action: z.literal('decision'), version: z.number().int(), issue_id: z.string().max(200), status: z.enum(['approved', 'acknowledged']), note }),
  z.object({ action: z.literal('proposal_decision'), version: z.number().int(), proposal_id: z.string().max(100), status: z.enum(['approved', 'rejected']), note }),
  z.object({ action: z.literal('correct'), version: z.number().int(), record_id: z.string().max(300), kind: z.enum(['supersede', 'withdraw']), reason: note, evidence_reference: z.string().trim().min(3, 'Name the evidence for this correction.').max(300), replacement: replacementSchema.optional() }),
  z.object({ action: z.literal('agent'), version: z.number().int(), question: z.string().trim().min(5).max(500), mode: z.enum(['auto', 'rules']).default('auto') }),
  z.object({ action: z.literal('external_import'), version: z.number().int(), source: z.enum(EXTERNAL_SOURCE_KEYS as [ExternalSourceKey, ...ExternalSourceKey[]]) }),
  z.object({ action: z.literal('memory_feedback'), version: z.number().int(), memory_id: z.string().regex(/^mem-\d{1,6}$/), kind: z.enum(['wrong', 'helpful']), note }),
]);
export type ChangeBody = z.infer<typeof changeSchema>;

const MAX_RECORDS = 5000, MAX_SOURCES = 40;

/** Fills fields added after the first release so older saved cases keep loading. */
export function normalizeCase(c: RecallCase): RecallCase {
  c.corrections ??= []; c.proposals ??= []; c.snapshots ??= []; c.agent_runs ??= []; c.decisions ??= [];
  return c;
}

export async function newCase(body: z.infer<typeof createSchema>, actor: string, id: string, now: string): Promise<RecallCase> {
  const c: RecallCase = body.action === 'sample' ? createScenarioCase(body.scenario, id, now)
    : { id, name: body.name, mode: 'workspace', created_at: now, version: 1, alert: body.alert, records: [], sources: [], audit: [], decisions: [], investigated_at: null, corrections: [], proposals: [], snapshots: [], agent_runs: [] };
  await appendAudit(c, actor, 'Case created', body.action === 'sample' ? `Fictional training scenario “${c.name}” opened with ${c.records.length} records in ${c.sources.length} sources.` : 'Recall scope entered by operator; source authenticity requires human verification.');
  return c;
}

function addSource(c: RecallCase, name: string, kind: RecallCase['sources'][number]['kind'], content: string, now: string, origin?: RecallCase['sources'][number]['origin']): LedgerRecord[] {
  const sourceId = crypto.randomUUID();
  let records: LedgerRecord[] = [];
  try { records = parseLedgerCsv(content, sourceId); } catch (e) { fail(e instanceof Error ? e.message : 'Invalid CSV.'); }
  if (c.records.length + records.length > MAX_RECORDS || c.sources.length >= MAX_SOURCES) fail(`This release supports up to ${MAX_RECORDS.toLocaleString('en-US')} records and ${MAX_SOURCES} sources per case.`);
  c.records.push(...records);
  c.sources.push({ id: sourceId, name, kind, content, added_at: now, row_count: records.length, ...(origin ? { origin } : {}) });
  return records;
}

/** Applies an operator change that needs no network access. Agent runs and external imports are handled by the caller. */
export async function applyChange(c: RecallCase, body: ChangeBody, actor: string, now: string): Promise<{ evidenceChanged: boolean; decisionText?: { text: string; refs: string[] } }> {
  if (body.action === 'import' || body.action === 'followup_sample') {
    if (body.action === 'followup_sample' && (c.mode !== 'drill' || c.name !== SCENARIOS['missing-40'].name)) fail('This training evidence belongs to “The missing 40 bottles” drill.');
    if (body.action === 'followup_sample' && c.sources.some(s => s.name === FOLLOWUP_SOURCE_NAME)) fail('Training follow-up has already been added.');
    const name = body.action === 'import' ? body.name : FOLLOWUP_SOURCE_NAME;
    const records = addSource(c, name, body.action === 'import' ? 'csv' : 'sample', body.action === 'import' ? body.content : FOLLOWUP_CSV, now);
    c.investigated_at = null;
    await appendAudit(c, actor, 'Evidence imported', `${name}: ${records.length} records retained. Prior evidence preserved.${body.action === 'followup_sample' ? ' Fictional training evidence.' : ''}`);
    return { evidenceChanged: true };
  }
  if (body.action === 'investigate') {
    const r = reconcileCase(c);
    recordSnapshot(c, takeSnapshot(c, r, 'rules', actor, null, now));
    c.investigated_at = now;
    await appendAudit(c, actor, 'Reconciliation run', `Rules v2: ${r.shipped} ${c.alert.unit} accepted; ${r.available} available; ${r.quarantined} quarantined; ${r.returned} returned; ${r.dispensed} dispensed; ${r.review_ids.length} records need review. Quantities are source-reported.`);
    return { evidenceChanged: false };
  }
  if (body.action === 'decision') {
    const issue = reconcileCase(c).issues.find(i => i.id === body.issue_id);
    if (!issue) fail('This finding is no longer current. Reload the case.', 409);
    c.decisions.push({ id: crypto.randomUUID(), issue_id: issue!.id, at: now, actor, status: body.status, note: body.note, evidence_ids: issue!.evidence_ids });
    await appendAudit(c, actor, body.status === 'approved' ? 'Follow-up approved' : 'Finding acknowledged', `${issue!.title} — ${body.note}. Approval does not change stock or confirm completion.`);
    return { evidenceChanged: false, decisionText: { text: `${actor} ${body.status} follow-up for “${issue!.title}” (${issue!.id}): ${body.note}. Approval does not change stock or confirm completion.`, refs: issue!.evidence_ids } };
  }
  if (body.action === 'proposal_decision') {
    const p = c.proposals.find(x => x.id === body.proposal_id);
    if (!p) fail('Proposal not found.', 404);
    if (p!.status !== 'proposed') fail(`This proposal was already ${p!.status}.`, 409);
    const issue = reconcileCase(c).issues.find(i => i.id === p!.issue_id);
    if (!issue && body.status === 'approved') fail('The issue behind this proposal is no longer open. Reject it or rerun the investigation.', 409);
    p!.status = body.status; p!.decided_by = actor; p!.decided_at = now;
    c.decisions.push({ id: crypto.randomUUID(), issue_id: p!.issue_id, at: now, actor, status: body.status, note: body.note, evidence_ids: p!.citations, proposal_id: p!.id });
    await appendAudit(c, actor, body.status === 'approved' ? 'Agent proposal approved' : 'Agent proposal rejected', `${p!.action} (${p!.owner_role.replace(/_/g, ' ')}) — ${body.note}. No message was sent; stock is unchanged until evidence arrives.`);
    return { evidenceChanged: false, ...(body.status === 'approved' ? { decisionText: { text: `${actor} approved proposed follow-up for ${p!.issue_id}: ${p!.action} Owner: ${p!.owner_role}. Evidence requested: ${p!.evidence_requested}. Approval does not change stock.`, refs: p!.citations } } : {}) };
  }
  if (body.action === 'correct') {
    const original = c.records.find(r => r.id === body.record_id);
    if (!original) fail('Record not found.', 404);
    if (c.corrections.some(k => k.original_id === body.record_id)) fail('This record has already been corrected. Correct its replacement instead.', 409);
    let replacementId: string | null = null;
    if (body.kind === 'supersede') {
      if (!body.replacement) fail('A replacement record is required to supersede a record.');
      const row = CSV_COLUMNS.map(col => body.replacement![col] ?? '');
      const [rec] = addSource(c, `Correction of ${original!.reference || original!.event_id || 'record'} (${now.slice(0, 10)})`, 'correction', toLedgerCsv([row]), now);
      replacementId = rec.id;
    }
    const correction = { id: crypto.randomUUID(), at: now, actor, kind: body.kind, original_id: original!.id, replacement_id: replacementId, reason: body.reason, evidence_reference: body.evidence_reference };
    c.corrections.push(correction);
    c.investigated_at = null;
    await appendAudit(c, actor, body.kind === 'supersede' ? 'Record superseded' : 'Record withdrawn',
      `${original!.reference || original!.event_id} (${original!.id}) ${body.kind === 'supersede' ? `superseded by ${replacementId}` : 'withdrawn from balances'}. Reason: ${body.reason}. Evidence: ${body.evidence_reference}. The original is preserved.`);
    return { evidenceChanged: true };
  }
  return fail('This change needs a server connection.', 500);
}

type Imported = { record_id: string; hash: string };

/** The latest imported version of each source row, per table at one source instance, in import order. */
function importedVersions(c: RecallCase, instance: string, mode: 'live' | 'mock', table: string): { latest: Map<string, Imported>; legacy: number } {
  const latest = new Map<string, Imported>();
  let legacy = 0;
  for (const s of c.sources) {
    const o = s.origin;
    if (!o || o.system !== 'zetaris' || o.mode !== mode || o.table !== table) continue;
    // Imports made before instances were recorded are assumed to be from this instance (counted in the audit).
    if (o.instance && o.instance !== instance) continue;
    if (!o.instance) legacy++;
    const records = c.records.filter(r => r.source_id === s.id).sort((a, b) => a.source_row - b.source_row);
    (o.row_keys ?? []).forEach((key, i) => {
      const record = records[i];
      if (!key || !record) return;
      // Older imports stored no content hash; it is recomputed from the retained row.
      const hash = o.row_hashes?.[i] ?? rowContentHash(Object.fromEntries(CSV_COLUMNS.map(col => [col, String(sourceRow(s, record.source_row)?.[col] ?? '')])));
      latest.set(key, { record_id: record.id, hash });
    });
  }
  return { latest, legacy };
}

/**
 * Imports a complete read of a connected source (see readAll) as a new, provenance-labelled source.
 * Each row is identified by source instance, table and the source's row key, and compared by content:
 * - unchanged rows are skipped, so re-importing never double counts;
 * - a row whose content changed at the source is imported as a new version, and the earlier version
 *   is superseded by a correction (kept, audited, and no longer counted);
 * - a previously imported row the source no longer returns is reported, never reversed;
 * - a read with no matching rows is a successful check, not a failure.
 */
export async function importExternal(c: RecallCase, read: Extract<CompleteRead, { ok: true }>, filter: ExternalFilter, actor: string, now: string) {
  const { latest, legacy } = importedVersions(c, read.instance, read.mode, read.table);
  const fresh: { row: ExternalRow; hash: string; replaces?: Imported }[] = [], conflicts: string[] = [];
  let unchanged = 0;
  const corrected = new Set(c.corrections.map(k => k.original_id));
  for (const row of read.rows) {
    const hash = rowContentHash(row.values), prev = row.row_key ? latest.get(row.row_key) : undefined;
    if (prev && prev.hash === hash) { unchanged++; continue; }
    // An operator already corrected the earlier version; a second automatic correction could double count or undo theirs.
    if (prev && corrected.has(prev.record_id)) { conflicts.push(row.row_key); continue; }
    fresh.push({ row, hash, replaces: prev });
  }
  const returned = new Set(read.rows.map(r => r.row_key));
  const missing = [...latest.entries()].filter(([key, v]) => !returned.has(key) && !corrected.has(v.record_id)).map(([key]) => key);

  c.source_observations ??= {}; c.scope_observations ??= {};
  for (const row of read.rows) if (row.row_key) c.source_observations[rowIdentity(read.instance, read.table, row.row_key)] = { hash: rowContentHash(row.values), seen_at: now };
  c.scope_observations[scopeKey(read.instance, read.table, filter)] = { observed_at: now, rows: read.count };

  const label = `${EXTERNAL_SOURCES[read.source].label} via Zetaris${read.mode === 'mock' ? ' (MOCK fixture)' : ''} ${now.slice(0, 16).replace('T', ' ')}`;
  const where = `${read.table} at ${read.instance}`, how = `${read.count} rows read in ${read.pages} page${read.pages === 1 ? '' : 's'}, matching the count query; ${read.latency_ms} ms`;
  const list = (keys: string[]) => `${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', and more' : ''}`;
  const notes = [
    ...(missing.length ? [`${missing.length} previously imported row(s) are no longer returned by the source (${list(missing)}); they were not reversed and still count until an operator corrects them.`] : []),
    ...(conflicts.length ? [`${conflicts.length} changed row(s) were not imported because an operator already corrected the earlier version (${list(conflicts)}); review them manually.`] : []),
    ...(legacy ? [`${legacy} earlier import(s) did not record a source instance and were assumed to be from ${read.instance}.`] : []),
  ];
  const result = { imported: fresh.filter(f => !f.replaces).length, updated: fresh.filter(f => f.replaces).length, unchanged, skipped: unchanged, conflicts, missing_at_source: missing, pages: read.pages, source_count: read.count };
  if (!fresh.length) {
    await appendAudit(c, actor, read.mode === 'mock' ? 'Mock source checked' : 'Zetaris source checked',
      `${label}: ${read.count ? `all ${read.count} rows from ${where} are already in this case unchanged` : `no rows in ${where} match batch ${filter.batch}`}; nothing imported (${how}).${notes.length ? ` ${notes.join(' ')}` : ''}`);
    return result;
  }
  const content = toLedgerCsv(fresh.map(f => CSV_COLUMNS.map(col => f.row.values[col] ?? '')));
  const records = addSource(c, label, read.mode === 'mock' ? 'zetaris-mock' : 'zetaris', content, now, {
    system: 'zetaris', mode: read.mode, instance: read.instance, table: read.table, query_id: read.query_ids[0], fetched_at: now, latency_ms: read.latency_ms, sql: read.sql,
    row_keys: fresh.map(f => f.row.row_key), row_hashes: fresh.map(f => f.hash),
    coverage: { pages: read.pages, rows: read.rows.length, source_count: read.count, note: `Complete read: ${how}. Query IDs ${read.query_ids.join(', ')}.` },
  });
  fresh.forEach((f, i) => {
    if (!f.replaces) return;
    c.corrections.push({ id: crypto.randomUUID(), at: now, actor, kind: 'supersede', original_id: f.replaces.record_id, replacement_id: records[i].id,
      reason: `Source row ${f.row.row_key} changed at ${where} after it was imported. The new version replaces it; the earlier version is kept.`,
      evidence_reference: `zetaris:${read.instance}:${read.table}:${f.row.row_key} content ${f.replaces.hash} to ${f.hash}` });
  });
  c.investigated_at = null;
  await appendAudit(c, actor, read.mode === 'mock' ? 'Mock source imported' : 'Zetaris source imported',
    `${label}: ${result.imported} new and ${result.updated} changed rows from ${where}${unchanged ? `; ${unchanged} unchanged rows skipped` : ''} (${how}).${result.updated ? ' Each changed row supersedes its earlier version, which is kept and no longer counted.' : ''}${notes.length ? ` ${notes.join(' ')}` : ''} Mapping: ${EXTERNAL_SOURCES[read.source].assumption}`);
  return result;
}
