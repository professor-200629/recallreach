import { CSV_COLUMNS } from '../csv.ts';
import { SCENARIOS } from '../sample.ts';
import { buildSelect, isSafeFilterValue, type ExternalQueryResult, type ExternalSource, type ExternalSourceKey, type HealthResult, type IntegrationEvent } from './external.ts';

// MOCK. Serves the fictional scenario fixtures through the same interface as the
// Zetaris adapter so the workflow can be exercised without an instance. Every result
// is labelled mode "mock"; nothing here contacts Zetaris or proves an integration.
export class MockZetarisSource implements ExternalSource {
  readonly system = 'zetaris' as const;
  readonly mode = 'mock' as const;
  constructor(private onEvent: (e: IntegrationEvent) => void = () => {}, private unavailable = false) {}

  async health(): Promise<HealthResult> {
    const result: HealthResult = this.unavailable
      ? { ok: false, mode: 'mock', latency_ms: 0, detail: 'Mock source is configured to be unavailable.', failure: 'unreachable' }
      : { ok: true, mode: 'mock', latency_ms: 0, detail: 'Local fixture mock. Not a Zetaris connection.' };
    this.onEvent({ integration: 'zetaris', mode: 'mock', operation: 'health', ok: result.ok, latency_ms: 0, detail: result.detail });
    return result;
  }

  async query(source: ExternalSourceKey, filter: { batch: string; shipment_id?: string }, limit: number): Promise<ExternalQueryResult> {
    const table = `mock.${source}`, queryId = crypto.randomUUID();
    if (this.unavailable) return { ok: false, mode: 'mock', source, table, failure: 'unreachable', message: 'Mock source is configured to be unavailable.', latency_ms: 0, query_id: queryId };
    if (!isSafeFilterValue(filter.batch) || (filter.shipment_id !== undefined && !isSafeFilterValue(filter.shipment_id))) return { ok: false, mode: 'mock', source, table, failure: 'invalid_filter', message: 'Filter values may only contain letters, digits, spaces and . _ ( ) / -', latency_ms: 0, query_id: queryId };
    const start = Date.now();
    const rows = Object.values(SCENARIOS).flatMap(s => s.sources.filter(src => src.key === source).flatMap(src => src.rows.map((row, i) => ({ row, key: `${s.id}:${i + 1}` }))))
      .filter(({ row }) => String(row[7]) === filter.batch && (!filter.shipment_id || String(row[1]) === filter.shipment_id))
      .slice(0, limit)
      .map(({ row, key }) => ({ values: Object.fromEntries(CSV_COLUMNS.map((col, i) => [col, String(row[i])])), row_key: key }));
    const latency = Date.now() - start;
    this.onEvent({ integration: 'zetaris', mode: 'mock', operation: `query ${source}`, ok: true, latency_ms: latency, detail: `${rows.length} fixture rows (mock).` });
    return { ok: true, mode: 'mock', source, table, sql: `-- mock, equivalent to: ${buildSelect(source, `mock_${source}`, filter, limit)}`, query_id: queryId, latency_ms: latency, rows, truncated: rows.length >= limit };
  }
}
