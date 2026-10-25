import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteD1 } from './helpers/sqlite-d1.ts';
import { CaseRepository } from '../lib/recall/repo.ts';
import { createHandlers, handle } from '../lib/recall/http.ts';
import { MockZetarisSource } from '../lib/recall/sources/mock.ts';
import { identityFromHeaders } from '../lib/recall/identity.ts';
import { sites } from '../scripts/vite/sites-vite-plugin.ts';
import { createScenarioCase } from '../lib/recall/sample.ts';
import { reconcileCase } from '../lib/recall/engine.ts';
import { takeSnapshot } from '../lib/recall/snapshot.ts';
import { createContext } from '../lib/recall/agent/tools.ts';
import { investigate } from '../lib/recall/agent/runner.ts';
import { ScriptedProvider, turn } from '../lib/recall/agent/provider.ts';
import type { ExternalSource } from '../lib/recall/sources/external.ts';

// Persistence, identity and time boundaries.
const NOW = '2026-10-24T00:00:00Z';
function app() {
  const db = sqliteD1(), repo = new CaseRepository(db);
  const h = createHandlers({
    repo, identify: async req => req.headers.get('x-test-user') === 'alice' ? { userId: 'u-alice', displayName: 'Alice' } : null,
    provider: () => ({ provider: null, settings: { provider: 'none', model: '', configured: false, reason: 'test', time_limit_s: 240, request_token_limit: null } }),
    external: onEvent => ({ source: new MockZetarisSource(onEvent), mode: 'mock', detail: 'MOCK for tests' }),
  });
  const post = async (path: string, body: unknown) => {
    const req = new Request(`http://recallreach.test${path}`, { method: 'POST', headers: { 'x-test-user': 'alice', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const id = path.split('/')[3];
    const res = await handle(() => id ? h.changeCase(req, id) : h.createCase(req));
    // Response bodies are asserted field by field, so they are typed loosely here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, data: await res.json() as any };
  };
  return { db, repo, post };
}
const agentRun = { action: 'agent', question: 'Why are 40 bottles still unresolved, and what evidence would resolve this?', mode: 'rules' };

test('case and memory are saved atomically: a failed memory write leaves the case unchanged', async () => {
  const a = app(), created = await a.post('/api/cases', { action: 'sample' }), id = created.data.case.id;
  a.db.raw.exec("CREATE TRIGGER fail_memory BEFORE INSERT ON case_memory BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;");
  const res = await a.post(`/api/cases/${id}`, { version: 1, ...agentRun });
  assert.equal(res.status, 500);
  const row = await a.repo.getCase(id, 'u-alice');
  assert.equal(row!.version, 1, 'the case write was rolled back with the memory write');
  assert.equal(JSON.parse(row!.payload).agent_runs.length, 0);
  assert.equal(await a.repo.getMemory(id, 'u-alice'), null);
  a.db.raw.exec('DROP TRIGGER fail_memory');
  const ok = await a.post(`/api/cases/${id}`, { version: 1, ...agentRun });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.memory.items.length > 0, 'the response shows the memory as read back after the commit');
  assert.equal(ok.data.case.version, 2);
});

test('a memory-version conflict rolls back the case write too', async () => {
  const a = app(), created = await a.post('/api/cases', { action: 'sample' }), id = created.data.case.id;
  await a.post(`/api/cases/${id}`, { version: 1, ...agentRun });
  const row = (await a.repo.getCase(id, 'u-alice'))!, mem = (await a.repo.getMemory(id, 'u-alice'))!;
  const token = 'tok-1', payload = JSON.stringify({ ...JSON.parse(row.payload), version: 3, save_token: token }), state = JSON.stringify({ ...JSON.parse(mem.state), save_token: token });
  assert.equal(await a.repo.saveCaseAndMemory(id, 'u-alice', 2, payload, 3, NOW, token, { engine: mem.engine, state, expectedVersion: mem.version + 5 }), 'memory_conflict');
  assert.equal((await a.repo.getCase(id, 'u-alice'))!.version, 2, 'case unchanged');
  assert.equal(await a.repo.saveCaseAndMemory(id, 'u-alice', 1, payload, 3, NOW, token, { engine: mem.engine, state, expectedVersion: mem.version }), 'case_conflict');
  assert.equal((await a.repo.getMemory(id, 'u-alice'))!.version, mem.version, 'memory unchanged');
  assert.equal(await a.repo.saveCaseAndMemory(id, 'u-alice', 2, payload, 3, NOW, token, { engine: mem.engine, state, expectedVersion: mem.version }), 'saved');
});

test('concurrent investigation runs on one version: one saves, the other gets 409 and writes nothing', async () => {
  const a = app(), created = await a.post('/api/cases', { action: 'sample' }), id = created.data.case.id;
  const results = await Promise.all([a.post(`/api/cases/${id}`, { version: 1, ...agentRun }), a.post(`/api/cases/${id}`, { version: 1, ...agentRun })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const row = (await a.repo.getCase(id, 'u-alice'))!, mem = (await a.repo.getMemory(id, 'u-alice'))!;
  assert.equal(JSON.parse(row.payload).agent_runs.length, 1);
  assert.equal(JSON.parse(mem.state).save_token, JSON.parse(row.payload).save_token, 'case and memory come from the same save');
});

test('identity: both dispatcher headers are required, and the full name is decoded only when declared', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  assert.equal(identityFromHeaders(h({ 'oai-authenticated-user-id': 'u1' })), null);
  assert.equal(identityFromHeaders(h({ 'oai-authenticated-user-email': 'a@b.test' })), null);
  assert.deepEqual(identityFromHeaders(h({ 'oai-authenticated-user-id': 'u1', 'oai-authenticated-user-email': 'a@b.test', 'oai-authenticated-user-full-name': 'Ana%20M', 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8' })), { userId: 'u1', displayName: 'Ana M', email: 'a@b.test', fullName: 'Ana M' });
  assert.equal(identityFromHeaders(h({ 'oai-authenticated-user-id': 'u1', 'oai-authenticated-user-email': 'a@b.test', 'oai-authenticated-user-full-name': '%E0%A4' , 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8' }))!.displayName, 'a@b.test', 'a malformed name falls back to the email');
});

test('entry boundary (local dispatcher stand-in): forged identity headers from a client are stripped', async () => {
  let middleware: ((req: never, res: never, next: () => void) => void) | undefined;
  const plugin = sites() as { configureServer: (s: unknown) => void };
  plugin.configureServer({ config: { server: { https: false }, logger: { info: () => {} } }, middlewares: { use: (fn: typeof middleware) => { middleware = fn; } } });
  const forged = { 'oai-authenticated-user-id': 'victim', 'oai-authenticated-user-email': 'victim@example.test' };
  const send = (headers: Record<string, string>, remoteAddress: string) => {
    const req = { url: '/api/cases', method: 'GET', headers: { host: 'localhost:5173', ...headers }, rawHeaders: Object.entries({ host: 'localhost:5173', ...headers }).flat(), socket: { remoteAddress } };
    let passed = false;
    middleware!(req as never, { setHeader() {}, end() {} } as never, () => { passed = true; });
    return { passed, identity: identityFromHeaders(new Headers(req.headers as Record<string, string>)) };
  };
  const remote = send(forged, '203.0.113.9');
  assert.equal(remote.passed, true); assert.equal(remote.identity, null, 'a remote client cannot inject an identity');
  const local = send(forged, '127.0.0.1');
  assert.equal(local.identity, null, 'headers alone, without the local sign-in, are stripped even on loopback');
  const signedIn = send({ ...forged, cookie: '__sites_local_auth=1' }, '127.0.0.1');
  assert.equal(signedIn.identity?.userId, 'local_seedy', 'only the dispatcher-set identity survives');
});

// Deadline tests use a fake clock and a fake timer, so no real time passes.
function clock(start = Date.parse(NOW)) {
  let t = start, fire: (() => void) | null = null;
  return { now: () => t, advance(ms: number) { t += ms; }, schedule: (_ms: number, fn: () => void) => { fire = fn; return () => { fire = null; }; }, fireDeadline() { fire?.(); } };
}
const ctxFor = (external: ExternalSource | null = null) => {
  const c = createScenarioCase('missing-40', 'deadline', NOW), r = reconcileCase(c);
  return createContext({ c, r, memory: null, external, previous: undefined, current: takeSnapshot(c, r, 'agent-live', 'T', null, NOW) });
};

test('deadline: no tool in a batch starts after the deadline, and the run is not reported completed', async () => {
  const k = clock();
  const run = await investigate({ question: 'q', ctx: ctxFor(), actor: 'T', now: k.now, schedule: k.schedule, sleep: async () => {}, limits: { totalTimeoutMs: 60_000 },
    provider: new ScriptedProvider([() => { k.advance(61_000); return turn([['run_reconciliation', {}], ['search_records', {}], ['submit_findings', { summary: 'Late summary text.', facts: [], interpretations: [], evidence_requests: [] }]]); }]) });
  assert.equal(run.status, 'limit_reached');
  assert.equal(run.steps.every(s => !s.ok && /time limit/.test(s.error!)), true, JSON.stringify(run.steps.map(s => s.error)));
});

test('deadline: an answer that arrives after the deadline is not accepted, and the run is not reported completed', async () => {
  const k = clock();
  const run = await investigate({ question: 'q', ctx: ctxFor(), actor: 'T', now: k.now, schedule: k.schedule, sleep: async () => {}, limits: { totalTimeoutMs: 60_000 },
    provider: new ScriptedProvider([() => turn([['submit_findings', { summary: 'Summary text here.', facts: [], interpretations: [], evidence_requests: [] }]]) ]) });
  assert.equal(run.status, 'completed');
  const k2 = clock();
  const late = await investigate({ question: 'q', ctx: ctxFor(), actor: 'T', now: k2.now, schedule: k2.schedule, sleep: async () => {}, limits: { totalTimeoutMs: 60_000 },
    provider: { name: 'fake', model: 'm', pricing: null, complete: async () => { k2.advance(70_000); return turn([['submit_findings', { summary: 'Summary text here.', facts: [], interpretations: [], evidence_requests: [] }]]); } } });
  assert.equal(late.status, 'limit_reached'); assert.equal(late.answer, null);
  assert.match(late.steps[0].error!, /Not run: the time limit was reached/);
});

test('deadline: cancellation reaches a connected-source request that is in flight', async () => {
  const k = clock();
  let sawAbort = false;
  const slow: ExternalSource = { system: 'zetaris', mode: 'live', instance: 'zetaris://slow/org/1', health: async () => ({ ok: true, mode: 'live', latency_ms: 0, detail: '' }), count: async () => ({ ok: true, count: 0, latency_ms: 0 }),
    query: (source, _f, _l, opts = {}) => new Promise(resolve => {
      opts.signal!.addEventListener('abort', () => { sawAbort = true; resolve({ ok: false, mode: 'live', instance: 'zetaris://slow/org/1', source, table: 't', failure: 'timeout', message: 'Cancelled: the investigation time limit was reached.', latency_ms: 0, query_id: 'q' }); });
      k.advance(61_000); k.fireDeadline();
    }) };
  const run = await investigate({ question: 'q', ctx: ctxFor(slow), actor: 'T', now: k.now, schedule: k.schedule, sleep: async () => {}, limits: { totalTimeoutMs: 60_000 },
    provider: new ScriptedProvider([() => turn([['query_connected_source', { source: 'return_records' }]]), () => turn([['submit_findings', { summary: 'Should not be reached.', facts: [], interpretations: [], evidence_requests: [] }]])]) });
  assert.equal(sawAbort, true, 'the in-flight request received the cancellation');
  assert.equal(run.status, 'limit_reached'); assert.equal(run.answer, null);
});

test('deadline: a rate-limit wait that would pass the deadline ends the run as limit_reached, not as a provider fault', async () => {
  const k = clock();
  const { ProviderError } = await import('../lib/recall/agent/provider.ts');
  const run = await investigate({ question: 'q', ctx: ctxFor(), actor: 'T', now: k.now, schedule: k.schedule, sleep: async ms => k.advance(ms), limits: { totalTimeoutMs: 20_000 },
    provider: new ScriptedProvider([() => { throw new ProviderError('rate_limit', 'wait', true, 25_000); }]) });
  assert.equal(run.status, 'limit_reached'); assert.match(run.status_detail, /would pass the deadline/);
});

test('rules mode stops at the deadline or its tool-call limit and composes no answer from partial evidence', async () => {
  const k = clock(), ctx = ctxFor();
  const timed = await investigate({ question: 'Why are 40 bottles unresolved?', ctx: { ...ctx, now: () => { k.advance(5_000); return k.now(); } } as typeof ctx, actor: 'T', provider: null, now: () => { k.advance(5_000); return k.now(); }, schedule: k.schedule, limits: { totalTimeoutMs: 30_000 } });
  assert.equal(timed.status, 'limit_reached'); assert.equal(timed.answer, null); assert.match(timed.status_detail, /No answer was composed/);
  const capped = await investigate({ question: 'Why are 40 bottles unresolved?', ctx: ctxFor(), actor: 'T', provider: null, limits: { rulesMaxToolCalls: 3 } });
  assert.equal(capped.status, 'limit_reached'); assert.match(capped.status_detail, /after 3 tool calls/); assert.equal(capped.steps.length, 3);
});

test('run time limit: Groq defaults to 480 s for free-tier waits, others to 240 s, and AGENT_TIME_LIMIT_S overrides within 60 to 900 s', async () => {
  const { providerFromEnv } = await import('../lib/recall/agent/provider.ts');
  const groq = (extra: Record<string, string> = {}) => providerFromEnv({ GROQ_API_KEY: 'test-key', ...extra }).settings;
  assert.equal(groq().time_limit_s, 480);
  assert.equal(groq({ AGENT_TIME_LIMIT_S: '300' }).time_limit_s, 300);
  for (const bad of ['abc', '30', '1000', '300.5', '-5']) {
    const s = groq({ AGENT_TIME_LIMIT_S: bad });
    assert.equal(s.time_limit_s, 480, bad); assert.match(s.reason, /AGENT_TIME_LIMIT_S must be a whole number of seconds from 60 to 900; using 480 s/);
  }
  assert.equal(providerFromEnv({ AGENT_PROVIDER: 'openai', OPENAI_API_KEY: 'k', AGENT_MODEL: 'm' }).settings.time_limit_s, 240);
  assert.equal(providerFromEnv({}).settings.time_limit_s, 240);
  assert.equal(JSON.stringify(groq()).includes('test-key'), false, 'settings never carry the key');
});

test('every run records the limits it ran under; a live run in the app gets the provider time limit', async () => {
  const rules = await investigate({ question: 'Why are 40 bottles unresolved?', ctx: ctxFor(), actor: 'T', provider: null });
  assert.deepEqual(rules.limits, { total_timeout_ms: 240_000, max_model_calls: 0, max_tool_calls: 40, max_request_tokens: null });
  const submit = () => turn([['submit_findings', { summary: 'Scripted summary text.', facts: [], interpretations: [], evidence_requests: [] }]]);
  const live = (limits?: Record<string, number>) => {
    const db = sqliteD1(), repo = new CaseRepository(db);
    const h = createHandlers({ repo, identify: async () => ({ userId: 'u', displayName: 'U' }), limits,
      provider: () => ({ provider: new ScriptedProvider([submit]), settings: { provider: 'scripted', model: 'm', configured: true, reason: 'test', time_limit_s: 480, request_token_limit: null } }),
      external: () => ({ source: null, mode: 'none', detail: 'none' }) });
    const req = (body: unknown, id?: string) => new Request(`http://recallreach.test/api/cases${id ? `/${id}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { h, req };
  };
  for (const [limits, expected] of [[undefined, 480_000], [{ totalTimeoutMs: 90_000 }, 90_000]] as const) {
    const { h, req } = live(limits as Record<string, number> | undefined);
    const created = await (await h.createCase(req({ action: 'sample' }))).json() as { case: { id: string } };
    const res = await (await h.changeCase(req({ version: 1, action: 'agent', mode: 'auto', question: 'Why are 40 bottles unresolved?' }), created.case.id)).json() as { case: { agent_runs: { mode: string; limits: { total_timeout_ms: number; max_model_calls: number } }[] } };
    const run = res.case.agent_runs.at(-1)!;
    assert.equal(run.mode, 'live'); assert.equal(run.limits.total_timeout_ms, expected); assert.equal(run.limits.max_model_calls, 10);
  }
});

test('a live run answers at once and keeps the connection alive, then sends the saved result; failures arrive in the body', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const submit = () => turn([['submit_findings', { summary: 'Scripted summary text.', facts: [], interpretations: [], evidence_requests: [] }]]);
  const db = sqliteD1(), repo = new CaseRepository(db);
  const h = createHandlers({ repo, identify: async () => ({ userId: 'u', displayName: 'U' }), heartbeatMs: 5,
    provider: () => ({ provider: new ScriptedProvider([async () => { await gate; return submit(); }]), settings: { provider: 'scripted', model: 'm', configured: true, reason: 'test', time_limit_s: 480, request_token_limit: null } }),
    external: () => ({ source: null, mode: 'none', detail: 'none' }) });
  const req = (body: unknown, id?: string) => new Request(`http://recallreach.test/api/cases${id ? `/${id}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const created = await (await h.createCase(req({ action: 'sample' }))).json() as { case: { id: string } };
  const ask = { action: 'agent', mode: 'auto', question: 'Why are 40 bottles unresolved?' };
  // Two runs on the same version: both start streaming before either model call returns.
  const [a, b] = await Promise.all([h.changeCase(req({ version: 1, ...ask }), created.case.id), h.changeCase(req({ version: 1, ...ask }), created.case.id)]);
  assert.deepEqual([a.status, b.status], [200, 200], 'headers are sent before the run finishes');
  await new Promise(r => setTimeout(r, 30));
  release();
  const [ta, tb] = await Promise.all([a.text(), b.text()]);
  assert.match(ta + tb, /^ {2,}/m, 'keep-alive spaces precede the payload');
  const bodies = [JSON.parse(ta), JSON.parse(tb)] as { error?: string; status?: number; case?: { version: number } }[];
  assert.equal(bodies.filter(x => x.case?.version === 2).length, 1, 'one run is saved');
  const failed = bodies.find(x => x.error)!;
  assert.equal(failed.status, 409); assert.match(failed.error!, /concurrent update/);
  // A rules-mode run is quick and keeps an ordinary JSON response with a real status code.
  const rules = await handle(() => h.changeCase(req({ version: 1, action: 'agent', mode: 'rules', question: 'Why are 40 bottles unresolved?' }), created.case.id));
  assert.equal(rules.status, 409); assert.match((await rules.json() as { error: string }).error, /changed in another tab/);
});

test('provider error text never keeps an account identifier; time limits are worded exactly', async () => {
  const { OpenAICompatibleProvider } = await import('../lib/recall/agent/provider.ts');
  const p = new OpenAICompatibleProvider({ name: 'groq', baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', fetcher: (async () => new Response('{"error":{"message":"Request too large for model in organization `org_01abcDEF123` on tokens per minute"}}', { status: 413 })) as unknown as typeof fetch });
  await assert.rejects(p.complete({ messages: [], tools: [], maxTokens: 10, signal: AbortSignal.timeout(1000) }), (e: Error) => !/org_01abc/.test(e.message) && /org_\[redacted\]/.test(e.message));
  const { duration } = await import('../lib/recall/format.ts');
  assert.deepEqual([60, 89, 90, 240, 480, 870, 45].map(duration), ['1 minute', '1 minute 29 s', '1 minute 30 s', '4 minutes', '8 minutes', '14 minutes 30 s', '45 s']);
});
