import { CSV_COLUMNS } from '../csv.ts';
import { SCENARIOS } from '../sample.ts';
import { buildSelect, isSafeFilterValue, type Cursor, type ExternalCountResult, type ExternalFilter, type ExternalQueryResult, type ExternalRow, type ExternalSource, type ExternalSourceKey, type HealthResult, type IntegrationEvent, type QueryOptions } from './external.ts';

// MOCK. Serves the fictional scenario fixtures through the same interface as the
// Zetaris adapter so the workflow can be exercised without an instance. Every result
// is labelled mode "mock"; nothing here contacts Zetaris or proves an integration.
export class MockZetarisSource implements ExternalSource {
  readonly system = 'zetaris' as const;
  readonly mode = 'mock' as const;
  readonly instance = 'mock://fixtures';
  constructor(private onEvent: (e: IntegrationEvent) => void = () => {}, private unavailable = false) {}

  async health(): Promise<HealthResult> {
    const result: HealthResult = this.unavailable
      ? { ok: false, mode: 'mock', latency_ms: 0, detail: 'Mock source is configured to be unavailable.', failure: 'unreachable' }
      : { ok: true, mode: 'mock', latency_ms: 0, detail: 'Local fixture mock. Not a Zetaris connection.' };
    this.onEvent({ integration: 'zetaris', mode: 'mock', operation: 'health', ok: result.ok, latency_ms: 0, detail: result.detail });
    return result;
  }

  /** All fixture rows for a filter, in the same order the SQL uses: ordering column, then row number. */
  private rows(source: ExternalSourceKey, filter: ExternalFilter): ExternalRow[] {
    return Object.values(SCENARIOS).flatMap(s => s.sources.filter(src => src.key === source).flatMap(src => src.rows.map((row, i) => ({ row, key: `${s.id}:${String(i + 1).padStart(4, '0')}` }))))
      .filter(({ row }) => String(row[7]) === filter.batch && (!filter.shipment_id || String(row[1]) === filter.shipment_id))
      .map(({ row, key }) => ({ values: Object.fromEntries(CSV_COLUMNS.map((col, i) => [col, String(row[i])])), row_key: key, cursor: { order: String(row[12]), row_no: key } }))
      .sort((a, b) => cmp(a.cursor!, b.cursor!));
  }

  async query(source: ExternalSourceKey, filter: ExternalFilter, limit: number, opts: QueryOptions = {}): Promise<ExternalQueryResult> {
    const table = `mock.${source}`, queryId = crypto.randomUUID(), instance = this.instance;
    if (this.unavailable) return { ok: false, mode: 'mock', instance, source, table, failure: 'unreachable', message: 'Mock source is configured to be unavailable.', latency_ms: 0, query_id: queryId };
    if (!isSafeFilterValue(filter.batch) || (filter.shipment_id !== undefined && !isSafeFilterValue(filter.shipment_id))) return { ok: false, mode: 'mock', instance, source, table, failure: 'invalid_filter', message: 'Filter values may only contain letters, digits, spaces and . _ ( ) / -', latency_ms: 0, query_id: queryId };
    const n = Math.max(1, Math.min(500, limit)), start = Date.now();
    const after = opts.after, page = this.rows(source, filter).filter(r => !after || cmp(r.cursor!, after) > 0).slice(0, n);
    const latency = Date.now() - start;
    this.onEvent({ integration: 'zetaris', mode: 'mock', operation: `query ${source}`, ok: true, latency_ms: latency, detail: `${page.length} fixture rows (mock).` });
    return { ok: true, mode: 'mock', instance, source, table, sql: `-- mock, equivalent to: ${buildSelect(source, `mock_${source}`, filter, n, after)}`, query_id: queryId, latency_ms: latency, rows: page, truncated: page.length >= n, next: page.length >= n ? page.at(-1)!.cursor! : null };
  }

  async count(source: ExternalSourceKey, filter: ExternalFilter): Promise<ExternalCountResult> {
    if (this.unavailable) return { ok: false, failure: 'unreachable', message: 'Mock source is configured to be unavailable.', latency_ms: 0 };
    return { ok: true, count: this.rows(source, filter).length, latency_ms: 0 };
  }
}

const cmp = (a: Cursor, b: Cursor) => a.order < b.order ? -1 : a.order > b.order ? 1 : a.row_no < b.row_no ? -1 : a.row_no > b.row_no ? 1 : 0;
