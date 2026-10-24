import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { recallCases } from '@/db/schema';
import { and, eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { reconcile } from './engine';
import { parseLedgerCsv } from './csv';
import { createSample, FOLLOWUP_CSV } from './sample';
import { appendAudit } from './audit';
import type { RecallCase } from './types';

const short = z.string().trim().min(1).max(150);
const alertSchema = z.object({ product: short, manufacturer: short, batch: short, unit: short, source_url: z.string().max(1000).refine(s => !s || /^https:\/\//i.test(s) && URL.canParse(s), 'Use a complete HTTPS source URL.'), description: z.string().max(2000) });
const createSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('sample') }), z.object({ action: z.literal('create'), name: short, alert: alertSchema })]);
const changeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('import'), version: z.number().int(), name: short, content: z.string().max(800000) }),
  z.object({ action: z.literal('investigate'), version: z.number().int() }),
  z.object({ action: z.literal('followup_sample'), version: z.number().int() }),
  z.object({ action: z.literal('decision'), version: z.number().int(), issue_id: z.string().max(200), status: z.enum(['approved', 'acknowledged']), note: z.string().trim().min(10, 'Add a note of at least 10 characters.').max(2000) }),
]);
export function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } }); }
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
export async function handle(work: () => Promise<Response>) {
  try { return await work(); }
  catch (error) {
    if (error instanceof z.ZodError) return json({ error: error.issues.map(i => i.message).join(' ') }, 400);
    if (error instanceof Error && 'status' in error) return json({ error: error.message }, Number(error.status));
    if (error instanceof SyntaxError) return json({ error: 'Request is not valid JSON.' }, 400);
    console.error('RecallReach request failed', error);
    return json({ error: 'Could not save or load this case. Please try again.' }, 500);
  }
}
async function user(request: Request, write = false) {
  if (write) {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) fail('Request origin does not match this workspace.', 403);
    if (request.headers.get('sec-fetch-site') === 'cross-site') fail('Cross-site changes are not accepted.', 403);
    if (Number(request.headers.get('content-length')) > 900000) fail('Request is too large.', 413);
  }
  const identity = await getChatGPTUser();
  if (!identity) fail('Sign in to access your private cases.', 401);
  return identity;
}
async function readBody(request: Request) {
  const text = await request.text();
  if (text.length > 900000) fail('Request is too large.', 413);
  return JSON.parse(text);
}
export async function listCases(request: Request) {
  const identity = await user(request);
  const rows = await getDb().select({ id: recallCases.id, name: recallCases.name, created_at: recallCases.createdAt, updated_at: recallCases.updatedAt }).from(recallCases).where(eq(recallCases.ownerId, identity.userId)).orderBy(desc(recallCases.updatedAt)).limit(100);
  return json({ cases: rows });
}
export async function createCase(request: Request) {
  const identity = await user(request, true), body = createSchema.parse(await readBody(request));
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const c: RecallCase = body.action === 'sample' ? createSample(id, now) : { id, name: body.name, mode: 'workspace', created_at: now, version: 1, alert: body.alert, records: [], sources: [], audit: [], decisions: [], investigated_at: null };
  await appendAudit(c, identity.displayName, 'Case created', body.action === 'sample' ? 'Fictional mock recall opened with 11 training records.' : 'Recall scope entered by operator; source authenticity requires human verification.');
  await getDb().insert(recallCases).values({ id, ownerId: identity.userId, name: c.name, payload: JSON.stringify(c), version: 1, createdAt: now, updatedAt: now });
  return json({ case: c, result: reconcile(c.alert, c.records) }, 201);
}
export async function getCase(request: Request, id: string) {
  const identity = await user(request);
  const row = await getDb().select().from(recallCases).where(and(eq(recallCases.id, id), eq(recallCases.ownerId, identity.userId))).get();
  if (!row) fail('Case not found.', 404);
  const c: RecallCase = JSON.parse(row.payload);
  return json({ case: c, result: reconcile(c.alert, c.records) });
}
export async function changeCase(request: Request, id: string) {
  const identity = await user(request, true), body = changeSchema.parse(await readBody(request));
  const db = getDb();
  const row = await db.select().from(recallCases).where(and(eq(recallCases.id, id), eq(recallCases.ownerId, identity.userId))).get();
  if (!row) fail('Case not found.', 404);
  if (row.version !== body.version) fail('This case changed in another tab. Reload it before making another change.', 409);
  const c: RecallCase = JSON.parse(row.payload), now = new Date().toISOString();
  if (body.action === 'import' || body.action === 'followup_sample') {
    if (body.action === 'followup_sample' && c.mode !== 'drill') fail('Training evidence is only available in fictional drills.');
    if (body.action === 'followup_sample' && c.sources.some(s => s.name === 'Training follow-up.csv')) fail('Training follow-up has already been added.');
    const content = body.action === 'import' ? body.content : FOLLOWUP_CSV, name = body.action === 'import' ? body.name : 'Training follow-up.csv', sourceId = crypto.randomUUID();
    let records;
    try { records = parseLedgerCsv(content, sourceId); } catch (e) { fail(e instanceof Error ? e.message : 'Invalid CSV.'); }
    if (c.records.length + records.length > 5000 || c.sources.length >= 30) fail('This release supports up to 5,000 records and 30 sources per case.');
    c.records.push(...records);
    c.sources.push({ id: sourceId, name, kind: body.action === 'import' ? 'csv' : 'sample', content, added_at: now, row_count: records.length });
    c.investigated_at = null;
    await appendAudit(c, identity.displayName, 'Evidence imported', `${name}: ${records.length} records retained. Prior evidence preserved.`);
  } else if (body.action === 'investigate') {
    const r = reconcile(c.alert, c.records); c.investigated_at = now;
    await appendAudit(c, identity.displayName, 'Investigation run', `Rules v1: ${r.shipped} ${c.alert.unit} accepted; ${r.available} available; ${r.quarantined} quarantined; ${r.returned} returned; ${r.dispensed} dispensed; ${r.review_ids.length} records need review. Quantities are source-reported.`);
  } else {
    const issue = reconcile(c.alert, c.records).issues.find(i => i.id === body.issue_id);
    if (!issue) fail('This finding is no longer current. Reload the case.', 409);
    c.decisions.push({ id: crypto.randomUUID(), issue_id: issue.id, at: now, actor: identity.displayName, status: body.status, note: body.note, evidence_ids: issue.evidence_ids });
    await appendAudit(c, identity.displayName, body.status === 'approved' ? 'Follow-up approved' : 'Finding acknowledged', `${issue.title} — ${body.note}. Approval does not change stock or confirm completion.`);
  }
  c.version += 1;
  if (new TextEncoder().encode(JSON.stringify(c)).byteLength > 1700000) fail('This case has reached the storage limit for this release. Export it and open a new case for additional evidence.');
  const updated = await db.update(recallCases).set({ payload: JSON.stringify(c), version: c.version, updatedAt: now }).where(and(eq(recallCases.id, id), eq(recallCases.ownerId, identity.userId), eq(recallCases.version, body.version))).run();
  if (!updated.meta.changes) fail('A concurrent update was saved. Reload before retrying.', 409);
  return json({ case: c, result: reconcile(c.alert, c.records) });
}
