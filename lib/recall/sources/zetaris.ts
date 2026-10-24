import { buildSelect, EXTERNAL_SOURCES, mapRow, type ExternalFailure, type ExternalQueryResult, type ExternalSource, type ExternalSourceKey, type HealthResult, type IntegrationEvent } from './external.ts';

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
  constructor(private config: ZetarisConfig, private onEvent: (e: IntegrationEvent) => void = () => {}, private fetcher: typeof fetch = fetch) {}

  private async run(sql: string, limit: number, queryId: string): Promise<unknown[][]> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.restUrl}/sql-editor/sqls/run`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'X-Org-ID': this.config.orgId, 'X-Request-ID': crypto.randomUUID(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ queryId, sql, source: 'SqlEditor', limit }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 20_000),
      });
    } catch (error) {
      const name = (error as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new ZetarisRequestError('timeout', `Zetaris did not respond within ${(this.config.timeoutMs ?? 20_000) / 1000} s.`);
      throw new ZetarisRequestError('unreachable', `Cannot reach Zetaris at ${new URL(this.config.restUrl).host}.`);
    }
    if (response.status === 401 || response.status === 403) throw new ZetarisRequestError('auth_failed', `Zetaris rejected the API key or organisation ID (HTTP ${response.status}).`);
    // The response body may echo SQL or internal detail; keep only a short, single-line excerpt.
    if (!response.ok) throw new ZetarisRequestError('query_failed', `Zetaris query failed (HTTP ${response.status}): ${(await response.text()).replace(/\s+/g, ' ').slice(0, 200)}`);
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

  async query(source: ExternalSourceKey, filter: { batch: string; shipment_id?: string }, limit: number): Promise<ExternalQueryResult> {
    const table = this.config.tables[source], queryId = crypto.randomUUID(), start = Date.now();
    let sql: string;
    try { sql = buildSelect(source, table, filter, limit); }
    catch (error) { return { ok: false, mode: 'live', source, table, failure: 'invalid_filter', message: (error as Error).message, latency_ms: 0, query_id: queryId }; }
    try {
      const data = await this.run(sql, limit, queryId), rows = data.map(mapRow), latency = Date.now() - start;
      this.onEvent({ integration: 'zetaris', mode: 'live', operation: `query ${EXTERNAL_SOURCES[source].label}`, ok: true, latency_ms: latency, detail: `${rows.length} rows from ${table}.` });
      return { ok: true, mode: 'live', source, table, sql, query_id: queryId, latency_ms: latency, rows, truncated: rows.length >= limit };
    } catch (error) {
      const latency = Date.now() - start, failure = error instanceof ZetarisRequestError ? error.failure : 'invalid_response', message = (error as Error).message;
      this.onEvent({ integration: 'zetaris', mode: 'live', operation: `query ${EXTERNAL_SOURCES[source].label}`, ok: false, latency_ms: latency, detail: message });
      return { ok: false, mode: 'live', source, table, failure, message, latency_ms: latency, query_id: queryId };
    }
  }
}
