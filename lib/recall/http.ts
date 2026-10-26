import { z } from 'zod';
import type { RecallCase } from './types.ts';
import { reconcileCase } from './engine.ts';
import { evidenceFingerprint, staleness } from './snapshot.ts';
import { ActionError, applyChange, changeSchema, createSchema, importExternal, newCase, normalizeCase } from './actions.ts';
import { rememberDecision, revalidateMemory, runCaseInvestigation } from './investigation.ts';
import { CaseMemory, MEMORY_ENGINE, type MemoryState } from './memory/hmem.ts';
import type { CaseRepository } from './repo.ts';
import type { ChatProvider, ProviderSettings } from './agent/provider.ts';
import { readAll, type ExternalSource, type GapResult, type IntegrationEvent } from './sources/external.ts';
import { exportCase, type ExportFormat } from './export.ts';
import { appendAudit } from './audit.ts';

export type Identity = { userId: string; displayName: string };
export type ExternalSetup = { source: ExternalSource | null; mode: 'live' | 'mock' | 'none'; detail: string; tables?: Record<string, string> };
export type Deps = {
  repo: CaseRepository;
  identify: (request: Request) => Promise<Identity | null>;
  provider: () => { provider: ChatProvider | null; settings: ProviderSettings };
  external: (onEvent: (e: IntegrationEvent) => void) => ExternalSetup;
  limits?: Parameters<typeof runCaseInvestigation>[0]['limits'];
  /** Interval between keep-alive spaces on a streamed live run (tests shorten it). */
  heartbeatMs?: number;
};

const MAX_BODY = 900_000, MAX_CASE_BYTES = 1_700_000;
export function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } }); }

/** Maps an error to the status and message the client sees; internal details are only logged. */
function errorBody(error: unknown): { status: number; error: string } {
  if (error instanceof z.ZodError) return { status: 400, error: error.issues.map(i => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join(' ') };
  if (error instanceof ActionError) return { status: error.status, error: error.message };
  if (error instanceof SyntaxError) return { status: 400, error: 'Request is not valid JSON.' };
  console.error('RecallReach request failed', error instanceof Error ? error.message : 'unknown error');
  return { status: 500, error: 'Could not save or load this case. Please try again.' };
}

export async function handle(work: () => Promise<Response>) {
  try { return await work(); }
  catch (error) { const { status, error: message } = errorBody(error); return json({ error: message }, status); }
}

export const HEARTBEAT_MS = 15_000;
/**
 * A long live run keeps one request open for minutes. Some clients give up when no response
 * headers arrive within a few minutes (Firefox: 300 s over HTTP/1.1), which would lose the run.
 * So the response starts at once and sends a space every HEARTBEAT_MS (JSON allows leading
 * whitespace); the payload follows when the run is saved. The HTTP status is then always 200, so
 * a failure is sent as { error, status } in the body.
 */
function streamJson(work: () => Promise<unknown>, heartbeatMs = HEARTBEAT_MS): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(' '));
      timer = setInterval(() => { try { controller.enqueue(encoder.encode(' ')); } catch { clearInterval(timer); } }, heartbeatMs);
      void work().then(data => JSON.stringify(data), error => JSON.stringify(errorBody(error)))
        .then(text => { clearInterval(timer); try { controller.enqueue(encoder.encode(text)); controller.close(); } catch { /* the client went away */ } });
    },
    cancel() { clearInterval(timer); },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export function createHandlers(deps: Deps) {
  async function user(request: Request, write = false): Promise<Identity> {
    if (write) {
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) throw new ActionError('Request origin does not match this workspace.', 403);
      if (request.headers.get('sec-fetch-site') === 'cross-site') throw new ActionError('Cross-site changes are not accepted.', 403);
      if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new ActionError('Send changes as application/json.', 415);
      if (Number(request.headers.get('content-length')) > MAX_BODY) throw new ActionError('Request is too large.', 413);
    }
    const identity = await deps.identify(request);
    if (!identity) throw new ActionError('Sign in to access your private cases.', 401);
    return identity;
  }
  async function body(request: Request) {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new ActionError('Request is too large.', 413);
    return JSON.parse(text);
  }
  async function load(id: string, owner: string) {
    const row = await deps.repo.getCase(id, owner);
    if (!row) throw new ActionError('Case not found.', 404);
    return { row, c: normalizeCase(JSON.parse(row.payload) as RecallCase) };
  }
  async function loadMemory(id: string, owner: string) {
    const row = await deps.repo.getMemory(id, owner);
    return { version: row?.version ?? null, state: row ? JSON.parse(row.state) as MemoryState : null };
  }
  function view(c: RecallCase, memoryState: MemoryState | null, extras: Record<string, unknown> = {}) {
    const r = reconcileCase(c), st = staleness(c, r), memory = memoryState ? new CaseMemory(c.id, 'viewer', memoryState) : null;
    const { settings } = deps.provider(), ext = deps.external(() => {});
    return {
      case: c, result: r, staleness: { stale: st.stale, last_run_at: st.last?.at ?? null, last_trigger: st.last?.trigger ?? null, current_fingerprint: evidenceFingerprint(c, r) },
      memory: memory ? { engine: MEMORY_ENGINE, items: memory.list({ c, r }).slice(0, 60), contradictions: memory.contradictions(), ledger: memory.ledgerSummary() } : { engine: MEMORY_ENGINE, items: [], contradictions: [], ledger: null },
      capabilities: { agent: settings, external: { mode: ext.mode, detail: ext.detail } }, ...extras,
    };
  }
  /** Saves the case and (if it changed) its memory atomically: both are written, or neither is. */
  async function save(c: RecallCase, owner: string, expected: number, now: string, memory: { state: MemoryState; expected: number | null } | null) {
    const token = crypto.randomUUID();
    c.version = expected + 1; c.save_token = token;
    const payload = JSON.stringify(c);
    if (new TextEncoder().encode(payload).byteLength > MAX_CASE_BYTES) throw new ActionError('This case has reached the storage limit for this release. Export it and open a new case for additional evidence.', 413);
    const result = await deps.repo.saveCaseAndMemory(c.id, owner, expected, payload, c.version, now, token,
      memory ? { engine: MEMORY_ENGINE, state: JSON.stringify({ ...memory.state, save_token: token }), expectedVersion: memory.expected } : null);
    if (result === 'case_conflict') throw new ActionError('A concurrent update was saved. Reload before retrying.', 409);
    if (result === 'memory_conflict') throw new ActionError('Investigation memory was changed by another request. Nothing was saved; reload before retrying.', 409);
  }
  function recorder(owner: string) {
    const events: IntegrationEvent[] = [];
    return { onEvent: (e: IntegrationEvent) => events.push(e), flush: async () => { for (const e of events.splice(0)) await deps.repo.recordCheck({ id: crypto.randomUUID(), owner_id: owner, integration: e.integration, mode: e.mode, operation: e.operation, ok: e.ok ? 1 : 0, latency_ms: e.latency_ms, detail: e.detail, at: new Date().toISOString() }); } };
  }

  return {
    async listCases(request: Request) {
      const identity = await user(request);
      return json({ cases: await deps.repo.listCases(identity.userId) });
    },
    async createCase(request: Request) {
      const identity = await user(request, true), input = createSchema.parse(await body(request));
      const id = crypto.randomUUID(), now = new Date().toISOString(), c = await newCase(input, identity.displayName, id, now);
      await deps.repo.insertCase({ id, owner_id: identity.userId, name: c.name, payload: JSON.stringify(c), version: 1, created_at: now, updated_at: now });
      return json(view(c, null), 201);
    },
    async getCase(request: Request, id: string) {
      const identity = await user(request), { c } = await load(id, identity.userId), mem = await loadMemory(id, identity.userId);
      return json(view(c, mem.state));
    },
    async changeCase(request: Request, id: string) {
      const identity = await user(request, true), input = changeSchema.parse(await body(request));
      const { row, c } = await load(id, identity.userId);
      if (row.version !== input.version) throw new ActionError('This case changed in another tab. Reload it before making another change.', 409);
      const now = new Date().toISOString(), mem = await loadMemory(id, identity.userId), rec = recorder(identity.userId);
      const live = input.action === 'agent' && input.mode !== 'rules' ? deps.provider() : null;
      const apply = async () => {
      let memoryState = mem.state, extras: Record<string, unknown> = {};

      if (input.action === 'agent') {
        const { provider, settings } = live ?? { provider: null, settings: null };
        const ext = deps.external(rec.onEvent);
        // A live run gets the provider's time limit (longer for Groq's free tier); explicit server limits win.
        const limits = provider && settings ? { totalTimeoutMs: settings.time_limit_s * 1000, maxRequestTokens: settings.request_token_limit, ...deps.limits } : deps.limits;
        const out = await runCaseInvestigation({ c, memoryState, provider, external: ext.source, question: input.question, actor: identity.displayName, limits });
        memoryState = out.memoryState; extras = { run_id: out.run.id };
      } else if (input.action === 'external_import') {
        const ext = deps.external(rec.onEvent);
        if (!ext.source) throw new ActionError(`No connected source is configured: ${ext.detail}`, 400);
        const filter = { batch: c.alert.batch }, read = await readAll(ext.source, input.source, filter);
        await rec.flush();
        if (!read.ok) throw new ActionError(`Zetaris${read.mode === 'mock' ? ' (mock)' : ''} read failed (${read.failure}): ${read.message}`, 502);
        extras = { ...await importExternal(c, read, filter, identity.displayName, now) };
        const re = revalidateMemory(c, memoryState, identity.displayName, 'connected-source evidence imported'); memoryState = re.state; extras.memory_invalidated = re.invalidated;
      } else if (input.action === 'memory_feedback') {
        if (!memoryState) throw new ActionError('This case has no investigation memory yet.', 404);
        const memory = new CaseMemory(c.id, `recallreach:${identity.displayName}`, memoryState);
        let content = '';
        try { content = memory.feedback(input.memory_id, input.kind); } catch (e) { throw new ActionError((e as Error).message, 404); }
        memoryState = memory.toState();
        await appendAudit(c, identity.displayName, input.kind === 'wrong' ? 'Memory marked wrong' : 'Memory marked helpful', `${input.memory_id}: “${content.slice(0, 200)}” — ${input.note}`);
      } else {
        const effect = await applyChange(c, input, identity.displayName, now);
        if (effect.evidenceChanged) { const re = revalidateMemory(c, memoryState, identity.displayName, input.action === 'correct' ? 'a record was corrected' : 'new evidence was imported'); memoryState = re.state; extras.memory_invalidated = re.invalidated; }
        if (effect.decisionText) memoryState = rememberDecision(c, memoryState, identity.displayName, effect.decisionText.text, effect.decisionText.refs);
      }
      await save(c, identity.userId, input.version, now, memoryState && memoryState !== mem.state ? { state: memoryState, expected: mem.version } : null);
      await rec.flush();
      // Respond with what was persisted, read back after the commit.
      const saved = await load(id, identity.userId), savedMemory = await loadMemory(id, identity.userId);
      return view(saved.c, savedMemory.state, { ...extras, memory_saved: true });
      };
      return live?.provider ? streamJson(apply, deps.heartbeatMs) : json(await apply());
    },
    async exportCase(request: Request, id: string) {
      const identity = await user(request), { c } = await load(id, identity.userId), url = new URL(request.url);
      const format = (url.searchParams.get('format') ?? 'report') as ExportFormat;
      if (!['report', 'evidence', 'archive'].includes(format)) throw new ActionError('Unknown export format.', 400);
      const mem = await loadMemory(id, identity.userId), file = exportCase(c, format, mem.state, new Date().toISOString());
      return new Response(file.content, { headers: { 'Content-Type': `${file.type}; charset=utf-8`, 'Content-Disposition': `attachment; filename="${file.name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    },
    async integrations(request: Request) {
      const identity = await user(request), { settings } = deps.provider(), ext = deps.external(() => {});
      const checks = await deps.repo.listChecks(identity.userId, 20);
      // Looked up on its own: queries after the health check can push it out of the recent list.
      const lastLive = await deps.repo.lastCheck(identity.userId, 'zetaris', 'live', 'health');
      return json({
        agent: settings,
        zetaris: { mode: ext.mode, detail: ext.detail, tables: ext.tables ?? null, connected: ext.mode === 'live' && !!lastLive?.ok, last_live_check: lastLive ?? null },
        meterless: { engine: MEMORY_ENGINE, upstream: 'https://github.com/Meterless/Meterless (engines/hmem/reference, commit 1742dec)', storage: 'Cloudflare D1 table case_memory', note: 'Vendored, unmodified H-MEM reference implementation. Upstream conformance suite: 13/13 on 2026-10-24.' },
        checks: checks.map(c => ({ ...c, ok: !!c.ok })),
      });
    },
    async checkIntegration(request: Request) {
      const identity = await user(request, true), input = z.object({ integration: z.literal('zetaris'), check: z.enum(['health', 'gaps']).default('health'), batch: z.string().max(80).optional() }).parse(await body(request));
      const rec = recorder(identity.userId), ext = deps.external(rec.onEvent);
      if (!ext.source) return json({ integration: input.integration, ok: false, mode: 'none', detail: ext.detail });
      if (input.check === 'gaps') {
        // Only a live Zetaris runs the cross-source query; the mock never stands in for it.
        const src = ext.source as ExternalSource & { gaps?: (batch: string) => Promise<GapResult> };
        if (src.mode !== 'live' || !src.gaps) return json({ integration: input.integration, ok: false, mode: src.mode, detail: 'The cross-source query runs only against a live Zetaris connection, not the MOCK.' });
        if (!input.batch) throw new ActionError('A batch is required.', 400);
        const gaps = await src.gaps(input.batch);
        await rec.flush();
        return json({ integration: input.integration, mode: 'live', ...gaps });
      }
      const health = await ext.source.health();
      await rec.flush();
      return json({ integration: input.integration, ...health });
    },
  };
}
