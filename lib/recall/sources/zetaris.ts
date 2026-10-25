import { buildCount, buildSelect, EXTERNAL_SOURCES, mapRow, type ExternalCountResult, type ExternalFailure, type ExternalFilter, type ExternalQueryResult, type ExternalSource, type ExternalSourceKey, type HealthResult, type IntegrationEvent, type QueryOptions } from './external.ts';

// Read-only client for the Zetaris REST API documented in zetaris/getting-started
// (docs/connections/client-setup.md, scripts/zetaris_sql.py): POST {base}/sql-editor/sqls/run
// with a bearer API key, the numeric organisation ID and a request UUID.
export type ZetarisConfig = {
  restUrl: string; apiKey: string; orgId: string;
  tables: Record<ExternalSourceKey, string>;
  timeoutMs?: number;
};

export const DEFAULT_ZETARIS_TABLES: Record<ExternalSourceKey, string> = {
  distributor_dispatches: 'recall_distributor.dispatches',
  pharmacy_stock_events: 'recall_pharmacy.stock_events',
  return_records: 'recall_returns.return_notes',
};

/** Reads Zetaris settings from server-side environment values. Returns null when not configured. */
export function zetarisConfigFromEnv(env: Record<string, unknown>): ZetarisConfig | null {
  const restUrl = String(env.ZETARIS_REST_URL ?? '').trim().replace(/\/+$/, ''), apiKey = String(env.ZETARIS_API_KEY ?? '').trim(), orgId = String(env.ZETARIS_ORG_ID ?? '').trim();
  if (!restUrl || !apiKey || !orgId) return null;
  if (!/^https?:\/\/[^/\s]+(\/[^\s]*)?$/.test(restUrl) || !/^\d+$/.test(orgId)) throw new Error('ZETARIS_REST_URL must be an http(s) URL and ZETARIS_ORG_ID a numeric ID.');
  let tables = DEFAULT_ZETARIS_TABLES;
  if (env.ZETARIS_TABLES) tables = { ...DEFAULT_ZETARIS_TABLES, ...JSON.parse(String(env.ZETARIS_TABLES)) };
  return { restUrl, apiKey, orgId, tables };
}

class ZetarisRequestError extends Error {
  constructor(readonly failure: ExternalFailure, message: string) { super(message); }
}

export class ZetarisSource implements ExternalSource {
  readonly system = 'zetaris' as const;
  readonly mode = 'live' as const;
  readonly instance: string;
  constructor(private config: ZetarisConfig, private onEvent: (e: IntegrationEvent) => void = () => {}, private fetcher: typeof fetch = fetch) {
    this.instance = `zetaris://${new URL(config.restUrl).host}/org/${config.orgId}`;
  }

  private async run(sql: string, limit: number, queryId: string, signal?: AbortSignal): Promise<unknown[][]> {
    let response: Response;
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 20_000);
    try {
      response = await this.fetcher(`${this.config.restUrl}/sql-editor/sqls/run`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'X-Org-ID': this.config.orgId, 'X-Request-ID': crypto.randomUUID(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ queryId, sql, source: 'SqlEditor', limit }),
        // The caller's signal carries the investigation deadline; the timeout bounds a single request.
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (error) {
      const name = (error as Error)?.name;
      if (signal?.aborted) throw new ZetarisRequestError('timeout', 'Cancelled: the investigation time limit was reached.');
      if (name === 'TimeoutError' || name === 'AbortError') throw new ZetarisRequestError('timeout', `Zetaris did not respond within ${(this.config.timeoutMs ?? 20_000) / 1000} s.`);
      throw new ZetarisRequestError('unreachable', `Cannot reach Zetaris at ${new URL(this.config.restUrl).host}.`);
    }
    const errorText = response.ok ? '' : await response.text();
    // Zetaris 2.4 answers a wrong API key or organisation ID with HTTP 400 {"msg":"Not Allowed"}, not 401.
    if (response.status === 401 || response.status === 403 || (response.status === 400 && /"msg"\s*:\s*"Not Allowed"/.test(errorText))) throw new ZetarisRequestError('auth_failed', `Zetaris rejected the API key or organisation ID (HTTP ${response.status}).`);
    // The response body may echo SQL or internal detail; keep only a short, single-line excerpt.
    if (!response.ok) throw new ZetarisRequestError('query_failed', `Zetaris query failed (HTTP ${response.status}): ${errorText.replace(/\s+/g, ' ').slice(0, 200)}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new ZetarisRequestError('invalid_response', 'Zetaris returned a response that is not JSON.'); }
    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data) || data.some(row => !Array.isArray(row))) throw new ZetarisRequestError('invalid_response', 'Zetaris response did not contain a row array in "data".');
    return data as unknown[][];
  }

  /** One read-only diagnostic statement (SELECT, SHOW or DESCRIBE), used by scripts/zetaris-check.ts. */
  async probe(sql: string, limit = 50): Promise<{ ok: true; rows: unknown[][]; latency_ms: number } | { ok: false; failure: ExternalFailure; message: string; latency_ms: number }> {
    if (!/^\s*(SELECT|SHOW|DESCRIBE)\b/i.test(sql) || sql.includes(';')) return { ok: false, failure: 'invalid_filter', message: 'Only a single SELECT, SHOW or DESCRIBE statement is allowed.', latency_ms: 0 };
    const start = Date.now();
    try { return { ok: true, rows: await this.run(sql, limit, crypto.randomUUID()), latency_ms: Date.now() - start }; }
    catch (error) { return { ok: false, failure: error instanceof ZetarisRequestError ? error.failure : 'invalid_response', message: (error as Error).message, latency_ms: Date.now() - start }; }
  }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const rows = await this.run('SELECT 1', 1, crypto.randomUUID());
      const ok = String(rows[0]?.[0]) === '1', latency = Date.now() - start;
      const detail = ok ? 'SELECT 1 returned 1.' : `SELECT 1 returned ${JSON.stringify(rows).slice(0, 80)}.`;
      this.onEvent({ integration: 'zetaris', mode: 'live', operation: 'health', ok, latency_ms: latency, detail });
      return { ok, mode: 'live', latency_ms: latency, detail, ...(ok ? {} : { failure: 'invalid_response' as const }) };
    } catch (error) {
      const e = error as ZetarisRequestError, latency = Date.now() - start;
      this.onEvent({ integration: 'zetaris', mode: 'live', operation: 'health', ok: false, latency_ms: latency, detail: e.message });
      return { ok: false, mode: 'live', latency_ms: latency, detail: e.message, failure: e.failure ?? 'unreachable' };
    }
  }

  async query(source: ExternalSourceKey, filter: ExternalFilter, limit: number, opts: QueryOptions = {}): Promise<ExternalQueryResult> {
    const table = this.config.tables[source], queryId = crypto.randomUUID(), start = Date.now(), instance = this.instance;
    let sql: string;
    try { sql = buildSelect(source, table, filter, limit, opts.after); }
    catch (error) { return { ok: false, mode: 'live', instance, source, table, failure: 'invalid_filter', message: (error as Error).message, latency_ms: 0, query_id: queryId }; }
    try {
      const data = await this.run(sql, limit, queryId, opts.signal), rows = data.map(mapRow), latency = Date.now() - start;
      this.onEvent({ integration: 'zetaris', mode: 'live', operation: `query ${EXTERNAL_SOURCES[source].label}`, ok: true, latency_ms: latency, detail: `${rows.length} rows from ${table}${opts.after ? ' (next page)' : ''}.` });
      const full = rows.length >= Math.min(500, limit);
      return { ok: true, mode: 'live', instance, source, table, sql, query_id: queryId, latency_ms: latency, rows, truncated: full, next: full ? rows.at(-1)!.cursor ?? null : null };
    } catch (error) {
      const latency = Date.now() - start, failure = error instanceof ZetarisRequestError ? error.failure : 'invalid_response', message = (error as Error).message;
      this.onEvent({ integration: 'zetaris', mode: 'live', operation: `query ${EXTERNAL_SOURCES[source].label}`, ok: false, latency_ms: latency, detail: message });
      return { ok: false, mode: 'live', instance, source, table, failure, message, latency_ms: latency, query_id: queryId };
    }
  }

  async count(source: ExternalSourceKey, filter: ExternalFilter, opts: { signal?: AbortSignal } = {}): Promise<ExternalCountResult> {
    const table = this.config.tables[source], start = Date.now();
    let sql: string;
    try { sql = buildCount(source, table, filter); } catch (error) { return { ok: false, failure: 'invalid_filter', message: (error as Error).message, latency_ms: 0 }; }
    try {
      const data = await this.run(sql, 1, crypto.randomUUID(), opts.signal), n = Number(data[0]?.[0]);
      if (!Number.isInteger(n) || n < 0) return { ok: false, failure: 'invalid_response', message: `Count query returned ${JSON.stringify(data[0]).slice(0, 60)}.`, latency_ms: Date.now() - start };
      return { ok: true, count: n, latency_ms: Date.now() - start };
    } catch (error) {
      return { ok: false, failure: error instanceof ZetarisRequestError ? error.failure : 'invalid_response', message: (error as Error).message, latency_ms: Date.now() - start };
    }
  }
}
