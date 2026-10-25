import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteD1 } from './helpers/sqlite-d1.ts';
import { CaseRepository } from '../lib/recall/repo.ts';
import { createHandlers, handle, type Deps, type ExternalSetup } from '../lib/recall/http.ts';
import { MockZetarisSource } from '../lib/recall/sources/mock.ts';
import type { ExternalSource } from '../lib/recall/sources/external.ts';
import { ZetarisSource } from '../lib/recall/sources/zetaris.ts';
import { verifyAudit } from '../lib/recall/audit.ts';
import { CSV_COLUMNS } from '../lib/recall/csv.ts';
import { MISSING_40 } from '../lib/recall/sample.ts';

// Identities are injected by the test harness, standing in for the Sites dispatcher.
const USERS: Record<string, { userId: string; displayName: string }> = { alice: { userId: 'u-alice', displayName: 'Alice (coordinator)' }, bob: { userId: 'u-bob', displayName: 'Bob' } };
const dir = mkdtempSync(join(tmpdir(), 'recallreach-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function app(file = ':memory:', external?: (onEvent: Parameters<Deps['external']>[0]) => ExternalSetup) {
  const db = sqliteD1(file), repo = new CaseRepository(db);
  const h = createHandlers({
    repo, identify: async req => USERS[req.headers.get('x-test-user') ?? ''] ?? null,
    provider: () => ({ provider: null, settings: { provider: 'none', model: '', configured: false, reason: 'test', time_limit_s: 240 } }),
    external: external ?? (onEvent => ({ source: new MockZetarisSource(onEvent), mode: 'mock', detail: 'MOCK for tests' })),
  });
  // Response bodies are asserted field by field, so they are typed loosely here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (method: string, path: string, opts: { user?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Headers; data: any }> => {
    const headers: Record<string, string> = { ...(opts.user ? { 'x-test-user': opts.user } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers };
    const req = new Request(`http://recallreach.test${path}`, { method, headers, body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) });
    const [, , seg, id, sub] = path.split('?')[0].split('/');
    const res = await handle(async () => seg === 'integrations' ? (method === 'GET' ? h.integrations(req) : h.checkIntegration(req))
      : id ? (sub === 'export' ? h.exportCase(req, id) : method === 'GET' ? h.getCase(req, id) : h.changeCase(req, id))
      : method === 'GET' ? h.listCases(req) : h.createCase(req));
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, data: type.includes('application/json') && !res.headers.get('content-disposition') ? await res.json() : await res.text() };
  };
  return { db, repo, call };
}
const change = (a: ReturnType<typeof app>, id: string, version: number, body: Record<string, unknown>, user = 'alice') => a.call('POST', `/api/cases/${id}`, { user, body: { version, ...body } });

test('unauthenticated requests are refused', async () => {
  const a = app();
  for (const [m, p] of [['GET', '/api/cases'], ['POST', '/api/cases'], ['GET', '/api/cases/x'], ['GET', '/api/integrations']] as const) {
    const res = await a.call(m, p, m === 'POST' ? { body: { action: 'sample' } } : {});
    assert.equal(res.status, 401, `${m} ${p}`);
  }
});

test('cases are private to their owner on every read and write', async () => {
  const a = app(), created = await a.call('POST', '/api/cases', { user: 'alice', body: { action: 'sample' } });
  assert.equal(created.status, 201);
  const id = created.data.case.id;
  assert.equal((await a.call('GET', '/api/cases', { user: 'alice' })).data.cases.length, 1);
  assert.equal((await a.call('GET', '/api/cases', { user: 'bob' })).data.cases.length, 0);
  assert.equal((await a.call('GET', `/api/cases/${id}`, { user: 'bob' })).status, 404);
  assert.equal((await change(a, id, 1, { action: 'investigate' }, 'bob')).status, 404);
  assert.equal((await a.call('GET', `/api/cases/${id}/export?format=archive`, { user: 'bob' })).status, 404);
  assert.equal((await a.repo.updateCase(id, 'u-bob', 1, '{}', 2, 'x')), false, 'the SQL itself filters by owner');
});

test('cross-site, non-JSON and oversized writes are rejected', async () => {
  const a = app();
  assert.equal((await a.call('POST', '/api/cases', { user: 'alice', body: { action: 'sample' }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await a.call('POST', '/api/cases', { user: 'alice', body: { action: 'sample' }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await a.call('POST', '/api/cases', { user: 'alice', body: JSON.stringify({ action: 'sample' }), headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await a.call('POST', '/api/cases', { user: 'alice', body: 'x'.repeat(900_001) })).status, 413);
  assert.equal((await a.call('POST', '/api/cases', { user: 'alice', body: '{not json' })).status, 400);
  assert.equal((await a.call('POST', '/api/cases', { user: 'alice', body: { action: 'create', name: 'x', alert: { product: 'p', manufacturer: 'm', batch: 'b', unit: 'u', source_url: 'javascript:alert(1)', description: '' } } })).status, 400);
});

test('concurrent updates: the second writer with a stale version gets 409 and nothing is lost', async () => {
  const a = app(), { data } = await a.call('POST', '/api/cases', { user: 'alice', body: { action: 'sample' } }), id = data.case.id;
  const [first, second] = await Promise.all([change(a, id, 1, { action: 'investigate' }), change(a, id, 1, { action: 'followup_sample' })]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  const now = (await a.call('GET', `/api/cases/${id}`, { user: 'alice' })).data;
  assert.equal(now.case.version, 2);
  assert.equal(await a.repo.updateCase(id, 'u-alice', 1, '{}', 2, 'x'), false, 'conditional UPDATE refuses a stale version');
});

test('the demo flow: approval does not move stock; new evidence does; dispensed follow-up stays open', async () => {
  const a = app(), created = await a.call('POST', '/api/cases', { user: 'alice', body: { action: 'sample' } }), id = created.data.case.id;
  let v = 1;
  const step = async (body: Record<string, unknown>) => { const res = await change(a, id, v, body); assert.equal(res.status, 200, JSON.stringify(res.data)); v = res.data.case.version; return res.data; };
  const run1 = await step({ action: 'agent', question: 'Why are 40 bottles still unresolved, and what evidence would resolve this?', mode: 'rules' });
  assert.equal(run1.case.agent_runs[0].mode, 'rules');
  const proposal = run1.case.proposals.find((p: { issue_id: string }) => p.issue_id === 'stock:RR-104');
  assert.ok(proposal); assert.equal(run1.memory.items.length > 0, true);

  const approved = await step({ action: 'proposal_decision', proposal_id: proposal.id, status: 'approved', note: 'Coordinator will call the distributor today.' });
  assert.equal(approved.result.available, 40, 'approval alone does not change the 40');
  assert.equal(approved.case.proposals.find((p: { id: string }) => p.id === proposal.id).status, 'approved');
  assert.equal(approved.memory.items.some((m: { kind: string; review: string }) => m.kind === 'decision' && m.review === 'operator-approved'), true);

  const after = await step({ action: 'followup_sample' });
  assert.deepEqual([after.result.contained, after.result.dispensed, after.result.available], [940, 60, 0]);
  assert.equal(after.result.issues.some((i: { id: string }) => i.id === 'dispensed:RR-103'), true, 'pharmacist follow-up remains');
  assert.equal(after.result.issues.some((i: { id: string }) => i.id === 'destination:RR-104'), true, 'destination is still not established');
  assert.equal(after.staleness.stale, true, 'the earlier run is now stale');
  assert.equal(after.memory_invalidated > 0, true);

  const run2 = await step({ action: 'agent', question: 'What changed after the new evidence, and what is still open?', mode: 'rules' });
  assert.equal(run2.staleness.stale, false);
  assert.equal(run2.case.agent_runs[1].steps.some((s: { tool: string; summary: string }) => s.tool === 'compare_with_previous_run' && /changed/.test(s.summary)), true);
  assert.equal(await verifyAudit(run2.case.audit), true);
});

test('corrections preserve the original, need a reason and recalculate', async () => {
  const a = app(), { data } = await a.call('POST', '/api/cases', { user: 'alice', body: { action: 'sample' } }), id = data.case.id;
  const original = data.case.records.find((r: { event_id: string }) => r.event_id === 'R-B');
  const replacement = Object.fromEntries(CSV_COLUMNS.map(c => [c, String(original[c])]));
  replacement.event_id = 'R-B'; replacement.quantity = '20';
  assert.equal((await change(a, id, 1, { action: 'correct', record_id: original.id, kind: 'supersede', reason: 'short', evidence_reference: 'x', replacement })).status, 400);
  const res = await change(a, id, 1, { action: 'correct', record_id: original.id, kind: 'supersede', reason: 'Cedar confirmed 20 bottles were returned, not 25.', evidence_reference: 'Cedar email 2026-10-05', replacement });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const r = res.data.result, c = res.data.case;
  assert.equal(r.record_status[original.id].status, 'superseded');
  assert.equal(c.records.find((x: { id: string }) => x.id === original.id).quantity, original.quantity, 'original preserved');
  assert.equal(c.sources.at(-1).kind, 'correction');
  assert.match(c.audit.at(-1).detail, /The original is preserved/);
  assert.equal((await change(a, id, 2, { action: 'correct', record_id: original.id, kind: 'withdraw', reason: 'A second correction attempt.', evidence_reference: 'n/a' })).status, 409);
});

test('exports download as attachments with readable content and neutralized formulas', async () => {
  const a = app(), { data } = await a.call('POST', '/api/cases', { user: 'alice', body: { action: 'sample' } }), id = data.case.id;
  const row = ['F-1', 'RR-101', 'movement', 'available', 'quarantined', 'Nivara oral solution', 'Example Pharma (fictional)', 'DEMO-042', '1', 'bottles', 'Harbor Pharmacy', '=HYPERLINK("http://x")', '2026-10-02T12:00:00Z'];
  const content = [CSV_COLUMNS.join(','), row.map(v => /[",]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v).join(',')].join('\n');
  assert.equal((await change(a, id, 1, { action: 'import', name: 'Formula test.csv', content })).status, 200);
  const md = await a.call('GET', `/api/cases/${id}/export?format=report`, { user: 'alice' });
  assert.equal(md.status, 200); assert.match(md.headers.get('content-disposition')!, /attachment; filename="recallreach-DEMO-042-report\.md"/);
  assert.match(md.data, /## Source-reported quantities \(bottles\)/); assert.match(md.data, /\| Available \/ awaiting containment \| 40 \|/);
  assert.match(md.data, /does not make the history tamper-proof/);
  const csv = await a.call('GET', `/api/cases/${id}/export?format=evidence`, { user: 'alice' });
  assert.match(csv.headers.get('content-type')!, /text\/csv/); assert.match(csv.data, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  const json = await a.call('GET', `/api/cases/${id}/export?format=archive`, { user: 'alice' });
  const archive = JSON.parse(json.data);
  assert.equal(archive.case.id, id); assert.equal(await verifyAudit(archive.case.audit), true);
  assert.equal((await a.call('GET', `/api/cases/${id}/export?format=exe`, { user: 'alice' })).status, 400);
});

test('data persists after the database is reopened in a fresh session', async () => {
  const file = join(dir, 'persist.sqlite');
  const first = app(file), { data } = await first.call('POST', '/api/cases', { user: 'alice', body: { action: 'sample', scenario: 'velora-pens' } }), id = data.case.id;
  await change(first, id, 1, { action: 'agent', question: 'Which shipments still have pens without a containment or dispensing record, and why?', mode: 'rules' });
  first.db.close();
  const second = app(file), reloaded = await second.call('GET', `/api/cases/${id}`, { user: 'alice' });
  assert.equal(reloaded.status, 200); assert.equal(reloaded.data.case.version, 2);
  assert.equal(reloaded.data.case.agent_runs.length, 1); assert.equal(reloaded.data.memory.items.length > 0, true);
  assert.equal(reloaded.data.result.available, 47);
  second.db.close();
});

test('mock source imports are labelled mock and recorded; Zetaris is not reported connected', async () => {
  const a = app(), { data } = await a.call('POST', '/api/cases', { user: 'alice', body: { action: 'create', name: 'Mock import', alert: { product: 'Velora insulin pen', manufacturer: 'Northwind Biologics (fictional)', batch: 'VL-2207', unit: 'pens', source_url: '', description: '' } } });
  const res = await change(a, data.case.id, 1, { action: 'external_import', source: 'pharmacy_stock_events' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const src = res.data.case.sources[0];
  assert.equal(src.kind, 'zetaris-mock'); assert.equal(src.origin.mode, 'mock'); assert.match(src.name, /MOCK/);
  const status = (await a.call('GET', '/api/integrations', { user: 'alice' })).data;
  assert.equal(status.zetaris.mode, 'mock'); assert.equal(status.zetaris.connected, false);
  assert.equal(status.checks[0].mode, 'mock');
});

test('re-importing a connected source adds only new or changed rows, and the result is what was saved', async () => {
  let followup = false;
  const extra = { values: Object.fromEntries(CSV_COLUMNS.map((col, i) => [col, String(MISSING_40.followup!.rows[0][i])])), row_key: 'missing-40:followup:1' };
  const external = (onEvent: Parameters<Deps['external']>[0]): ExternalSetup => {
    const mock = new MockZetarisSource(onEvent);
    const source: ExternalSource = { system: 'zetaris', mode: 'mock', instance: mock.instance, health: () => mock.health(),
      count: async (s, f) => { const r = await mock.count(s, f); return r.ok && followup && s === 'pharmacy_stock_events' ? { ...r, count: r.count + 1 } : r; },
      query: async (s, f, limit, opts) => { const res = await mock.query(s, f, limit, opts); if (res.ok && followup && s === 'pharmacy_stock_events' && !res.next) res.rows.push(extra); return res; } };
    return { mode: 'mock', detail: 'MOCK for tests', source };
  };
  const a = app(':memory:', external), { data } = await a.call('POST', '/api/cases', { user: 'alice', body: { action: 'create', name: 'Re-import', alert: { product: 'Nivara oral solution', manufacturer: 'Example Pharma (fictional)', batch: 'DEMO-042', unit: 'bottles', source_url: '', description: '' } } });
  let version = 1, res: Awaited<ReturnType<typeof change>> | undefined;
  for (const source of ['distributor_dispatches', 'pharmacy_stock_events', 'return_records']) { res = await change(a, data.case.id, version++, { action: 'external_import', source }); assert.equal(res.status, 200, JSON.stringify(res.data)); }
  assert.equal(res!.data.result.available, 40);
  assert.equal(res!.data.case.sources[0].origin.instance, 'mock://fixtures');
  const again = await change(a, data.case.id, version++, { action: 'external_import', source: 'pharmacy_stock_events' });
  assert.deepEqual([again.data.imported, again.data.updated, again.data.unchanged, again.data.case.sources.length], [0, 0, 6, 3], 'nothing new: no rows and no empty source are added');
  assert.equal(again.data.result.available, 40, 'unchanged rows are not counted twice');
  followup = true;
  const after = await change(a, data.case.id, version++, { action: 'external_import', source: 'pharmacy_stock_events' });
  assert.deepEqual([after.data.imported, after.data.unchanged, after.data.case.sources.length], [1, 6, 4]);
  assert.equal(after.data.result.available, 0);
  const saved = (await a.call('GET', `/api/cases/${data.case.id}`, { user: 'alice' })).data;
  assert.equal(saved.case.version, after.data.case.version, 'the response reflects the persisted case');
});

test('an unreachable Zetaris instance is reported as a failure, not as connected', async () => {
  const live = (onEvent: Parameters<Deps['external']>[0]): ExternalSetup => ({ source: new ZetarisSource({ restUrl: 'http://127.0.0.1:9/api/v1.0', apiKey: 'test-key', orgId: '1', tables: { distributor_dispatches: 'a.b', pharmacy_stock_events: 'a.c', return_records: 'a.d' }, timeoutMs: 3000 }, onEvent), mode: 'live', detail: 'test' });
  const a = app(':memory:', live);
  const check = await a.call('POST', '/api/integrations', { user: 'alice', body: { integration: 'zetaris' } });
  assert.equal(check.data.ok, false); assert.match(check.data.failure, /unreachable|timeout/);
  const { data } = await a.call('POST', '/api/cases', { user: 'alice', body: { action: 'sample' } });
  assert.equal((await change(a, data.case.id, 1, { action: 'external_import', source: 'return_records' })).status, 502);
  const status = (await a.call('GET', '/api/integrations', { user: 'alice' })).data;
  assert.equal(status.zetaris.connected, false); assert.equal(status.checks.every((c: { ok: boolean }) => !c.ok), true);
  assert.equal(JSON.stringify(status).includes('test-key'), false, 'secrets are never returned');
});

test('operators can mark a memory wrong; it is kept, flagged, and the agent is told not to rely on it', async () => {
  const a = app(), { data } = await a.call('POST', '/api/cases', { user: 'alice', body: { action: 'sample' } }), id = data.case.id;
  const run = await change(a, id, 1, { action: 'agent', question: 'Why are 40 bottles still unresolved, and what evidence would resolve this?', mode: 'rules' });
  const target = run.data.memory.items[0];
  assert.equal((await change(a, id, 2, { action: 'memory_feedback', memory_id: 'mem-x', kind: 'wrong', note: 'Not a valid memory id at all.' })).status, 400);
  assert.equal((await change(a, id, 2, { action: 'memory_feedback', memory_id: 'mem-999', kind: 'wrong', note: 'This memory does not exist here.' })).status, 404);
  const res = await change(a, id, 2, { action: 'memory_feedback', memory_id: target.memory_id, kind: 'wrong', note: 'Contradicts what the pharmacy told us on the phone.' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const after = res.data.memory.items.find((m: { memory_id: string }) => m.memory_id === target.memory_id);
  assert.equal(after.disputed, true); assert.equal(after.content, target.content); assert.ok(after.confidence < target.confidence);
  assert.match(res.data.case.audit.at(-1).action, /Memory marked wrong/);
  assert.equal(res.data.memory.ledger.by_action.feedback, 1);
});
