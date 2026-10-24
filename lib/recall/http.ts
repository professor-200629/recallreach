import { z } from 'zod';
import type { RecallCase } from './types.ts';
import { reconcileCase } from './engine.ts';
import { evidenceFingerprint, staleness } from './snapshot.ts';
import { ActionError, applyChange, changeSchema, createSchema, importExternal, newCase, normalizeCase } from './actions.ts';
import { rememberDecision, revalidateMemory, runCaseInvestigation } from './investigation.ts';
import { CaseMemory, MEMORY_ENGINE, type MemoryState } from './memory/hmem.ts';
import type { CaseRepository } from './repo.ts';
import type { ChatProvider, ProviderSettings } from './agent/provider.ts';
import type { ExternalSource, IntegrationEvent } from './sources/external.ts';
import { exportCase, type ExportFormat } from './export.ts';

export type Identity = { userId: string; displayName: string };
export type ExternalSetup = { source: ExternalSource | null; mode: 'live' | 'mock' | 'none'; detail: string; tables?: Record<string, string> };
export type Deps = {
  repo: CaseRepository;
  identify: (request: Request) => Promise<Identity | null>;
  provider: () => { provider: ChatProvider | null; settings: ProviderSettings };
  external: (onEvent: (e: IntegrationEvent) => void) => ExternalSetup;
  limits?: Parameters<typeof runCaseInvestigation>[0]['limits'];
};

const MAX_BODY = 900_000, MAX_CASE_BYTES = 1_700_000;
export function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } }); }

export async function handle(work: () => Promise<Response>) {
  try { return await work(); }
  catch (error) {
    if (error instanceof z.ZodError) return json({ error: error.issues.map(i => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join(' ') }, 400);
    if (error instanceof ActionError) return json({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return json({ error: 'Request is not valid JSON.' }, 400);
    console.error('RecallReach request failed', error instanceof Error ? error.message : 'unknown error');
    return json({ error: 'Could not save or load this case. Please try again.' }, 500);
  }
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
  async function save(c: RecallCase, owner: string, expected: number, now: string) {
    c.version = expected + 1;
    const payload = JSON.stringify(c);
    if (new TextEncoder().encode(payload).byteLength > MAX_CASE_BYTES) throw new ActionError('This case has reached the storage limit for this release. Export it and open a new case for additional evidence.', 413);
    if (!await deps.repo.updateCase(c.id, owner, expected, payload, c.version, now)) throw new ActionError('A concurrent update was saved. Reload before retrying.', 409);
  }
  async function saveMemory(caseId: string, owner: string, state: MemoryState | null, expected: number | null, now: string) {
    if (!state) return true;
    return deps.repo.putMemory(caseId, owner, MEMORY_ENGINE, JSON.stringify(state), expected, now);
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
      let memoryState = mem.state, extras: Record<string, unknown> = {};

      if (input.action === 'agent') {
        const { provider } = input.mode === 'rules' ? { provider: null } : deps.provider();
        const ext = deps.external(rec.onEvent);
        const out = await runCaseInvestigation({ c, memoryState, provider, external: ext.source, question: input.question, actor: identity.displayName, limits: deps.limits });
        memoryState = out.memoryState; extras = { run_id: out.run.id };
      } else if (input.action === 'external_import') {
        const ext = deps.external(rec.onEvent);
        if (!ext.source) throw new ActionError(`No connected source is configured: ${ext.detail}`, 400);
        const res = await ext.source.query(input.source, { batch: c.alert.batch }, 500);
        await rec.flush();
        if (!res.ok) throw new ActionError(`Zetaris${res.mode === 'mock' ? ' (mock)' : ''} query failed (${res.failure}): ${res.message}`, 502);
        extras = { imported: await importExternal(c, res, identity.displayName, now) };
        const re = revalidateMemory(c, memoryState, identity.displayName, 'connected-source evidence imported'); memoryState = re.state; extras.memory_invalidated = re.invalidated;
      } else {
        const effect = await applyChange(c, input, identity.displayName, now);
        if (effect.evidenceChanged) { const re = revalidateMemory(c, memoryState, identity.displayName, input.action === 'correct' ? 'a record was corrected' : 'new evidence was imported'); memoryState = re.state; extras.memory_invalidated = re.invalidated; }
        if (effect.decisionText) memoryState = rememberDecision(c, memoryState, identity.displayName, effect.decisionText.text, effect.decisionText.refs);
      }
      await save(c, identity.userId, input.version, now);
      const memorySaved = memoryState === mem.state || await saveMemory(id, identity.userId, memoryState, mem.version, now);
      await rec.flush();
      return json(view(c, memoryState, { ...extras, memory_saved: memorySaved }));
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
      const lastLive = checks.find(c => c.integration === 'zetaris' && c.mode === 'live' && c.operation === 'health');
      return json({
        agent: settings,
        zetaris: { mode: ext.mode, detail: ext.detail, tables: ext.tables ?? null, connected: ext.mode === 'live' && !!lastLive?.ok, last_live_check: lastLive ?? null },
        meterless: { engine: MEMORY_ENGINE, upstream: 'https://github.com/Meterless/Meterless (engines/hmem/reference, commit 1742dec)', storage: 'Cloudflare D1 table case_memory', note: 'Vendored, unmodified H-MEM reference implementation. Upstream conformance suite: 13/13 on 2026-10-24.' },
        checks: checks.map(c => ({ ...c, ok: !!c.ok })),
      });
    },
    async checkIntegration(request: Request) {
      const identity = await user(request, true), input = z.object({ integration: z.literal('zetaris') }).parse(await body(request));
      const rec = recorder(identity.userId), ext = deps.external(rec.onEvent);
      if (!ext.source) return json({ integration: input.integration, ok: false, mode: 'none', detail: ext.detail });
      const health = await ext.source.health();
      await rec.flush();
      return json({ integration: input.integration, ...health });
    },
  };
}
