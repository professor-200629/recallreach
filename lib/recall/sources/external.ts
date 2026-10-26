import { CSV_COLUMNS } from '../csv.ts';
import { hash64 } from '../snapshot.ts';

// Connected sources are separately owned systems. Each has its own native table;
// a fixed, code-owned SELECT maps it to RecallReach's ledger columns. Neither the
// model nor the operator supplies SQL: only validated filter values are bound in.
export const EXTERNAL_SOURCES = {
  distributor_dispatches: {
    label: 'Distributor dispatches', native: 'dispatches',
    select: `dispatch_id, consignment_ref, 'shipment', '', 'available', product_name, manufacturer_name, batch_no, qty, qty_unit, consignee, invoice_no, dispatched_at, row_no`,
    batchColumn: 'batch_no', shipmentColumn: 'consignment_ref', orderColumn: 'dispatched_at',
    assumption: 'Each dispatch row is an opening shipment into available stock.',
  },
  pharmacy_stock_events: {
    label: 'Pharmacy stock events', native: 'stock_events',
    select: `txn_id, consignment_ref, 'movement', from_status, to_status, product_name, manufacturer_name, batch_no, qty, qty_unit, pharmacy_name, doc_ref, recorded_at, row_no`,
    batchColumn: 'batch_no', shipmentColumn: 'consignment_ref', orderColumn: 'recorded_at',
    assumption: 'Pharmacy status columns map directly to RecallReach stock states.',
  },
  return_records: {
    label: 'Returns register', native: 'return_notes',
    select: `rma_id, consignment_ref, 'movement', 'quarantined', 'returned', product_name, manufacturer_name, batch_no, qty, qty_unit, returned_from, rma_ref, received_at, row_no`,
    batchColumn: 'batch_no', shipmentColumn: 'consignment_ref', orderColumn: 'received_at',
    assumption: 'A return note records stock moving from quarantine to returned. The register does not state the prior state.',
  },
} as const;
export type ExternalSourceKey = keyof typeof EXTERNAL_SOURCES;
export const EXTERNAL_SOURCE_KEYS = Object.keys(EXTERNAL_SOURCES) as ExternalSourceKey[];

/** A row as mapped to ledger columns, its key at the source, and the raw ordering values used to page past it. */
export type ExternalRow = { values: Record<string, string>; row_key: string; cursor?: Cursor };
/** Keyset position: the row's ordering column and row number exactly as the source returned them. */
export type Cursor = { order: string; row_no: string };
export type ExternalFilter = { batch: string; shipment_id?: string };
export type QueryOptions = { signal?: AbortSignal; after?: Cursor };
export type ExternalFailure = 'not_configured' | 'unreachable' | 'auth_failed' | 'query_failed' | 'timeout' | 'invalid_response' | 'invalid_filter' | 'incomplete' | 'too_large';
export type ExternalQueryResult =
  | { ok: true; mode: 'live' | 'mock'; instance: string; source: ExternalSourceKey; table: string; sql: string; query_id: string; latency_ms: number; rows: ExternalRow[]; truncated: boolean; next: Cursor | null }
  | { ok: false; mode: 'live' | 'mock'; instance: string; source: ExternalSourceKey; table: string; failure: ExternalFailure; message: string; latency_ms: number; query_id: string };
export type ExternalCountResult = { ok: true; count: number; latency_ms: number } | { ok: false; failure: ExternalFailure; message: string; latency_ms: number };
export type HealthResult = { ok: boolean; mode: 'live' | 'mock'; latency_ms: number; detail: string; failure?: ExternalFailure };
export type IntegrationEvent = { integration: 'zetaris'; mode: 'live' | 'mock'; operation: string; ok: boolean; latency_ms: number; detail: string };

export interface ExternalSource {
  readonly system: 'zetaris';
  readonly mode: 'live' | 'mock';
  /** Identifies the source instance (host and organisation, or "mock"), so equal row keys from two instances stay distinct. */
  readonly instance: string;
  health(): Promise<HealthResult>;
  query(source: ExternalSourceKey, filter: ExternalFilter, limit: number, opts?: QueryOptions): Promise<ExternalQueryResult>;
  count(source: ExternalSourceKey, filter: ExternalFilter, opts?: { signal?: AbortSignal }): Promise<ExternalCountResult>;
}

/** Identity of one source row across imports: instance, table and the source's own row key. */
export const rowIdentity = (instance: string, table: string, rowKey: string) => `${instance}|${table}|${rowKey}`;
/** Scope of one read, used to tell whether a later complete read still returned a row. */
export const scopeKey = (instance: string, table: string, filter: ExternalFilter) => `${instance}|${table}|batch=${filter.batch}${filter.shipment_id ? `|shipment=${filter.shipment_id}` : ''}`;
/** Content hash of a mapped row (change detection, not a security hash). */
export const rowContentHash = (values: Record<string, string>) => hash64(CSV_COLUMNS.map(c => (values[c] ?? '').trim()).join('\u001f'));

// Filter values become SQL string literals, so they are restricted to the characters
// batch and shipment identifiers actually use, then quote-escaped as a second guard.
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9 ._()/-]{0,79}$/;
const SAFE_TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,2}$/;
export const isSafeFilterValue = (v: string) => SAFE_VALUE.test(v);
export const isSafeTableName = (v: string) => SAFE_TABLE.test(v);
const literal = (v: string) => `'${v.replaceAll("'", "''")}'`;

function whereClause(source: ExternalSourceKey, table: string, filter: ExternalFilter): string {
  const s = EXTERNAL_SOURCES[source];
  if (!isSafeTableName(table)) throw new Error(`Configured table name for ${source} is not a plain identifier.`);
  if (!isSafeFilterValue(filter.batch) || (filter.shipment_id !== undefined && !isSafeFilterValue(filter.shipment_id))) throw new Error('Filter values may only contain letters, digits, spaces and . _ ( ) / -');
  return [`${s.batchColumn} = ${literal(filter.batch)}`, ...(filter.shipment_id ? [`${s.shipmentColumn} = ${literal(filter.shipment_id)}`] : [])].join(' AND ');
}

/**
 * One page of a source's rows for a batch, in a stable order (ordering column, then row_no as the
 * tie-breaker). With `after`, the page starts strictly after that keyset position, so consecutive
 * pages neither skip nor repeat rows that exist in both reads. Cursor values are bound as literals.
 */
export function buildSelect(source: ExternalSourceKey, table: string, filter: ExternalFilter, limit: number, after?: Cursor): string {
  const s = EXTERNAL_SOURCES[source], n = Math.max(1, Math.min(500, Math.trunc(limit)));
  let where = whereClause(source, table, filter);
  if (after) {
    if (after.order.length > 120 || after.row_no.length > 120) throw new Error('Cursor values are too long.');
    // row_no is an integer key in the fixture tables; compare it as a number when it is one.
    const rowNo = /^\d{1,18}$/.test(after.row_no) ? after.row_no : literal(after.row_no);
    where += ` AND (${s.orderColumn} > ${literal(after.order)} OR (${s.orderColumn} = ${literal(after.order)} AND row_no > ${rowNo}))`;
  }
  return `SELECT ${s.select} FROM ${table} WHERE ${where} ORDER BY ${s.orderColumn}, row_no LIMIT ${n}`;
}

/**
 * One read-only statement across all three sources: consignments of a batch that the distributor
 * dispatched but that no pharmacy stock event and no return note mentions. It gives a lead for
 * follow-up, not a stock figure; the engine still reconciles each source's imported rows on their own.
 */
export function buildGapQuery(tables: Record<ExternalSourceKey, string>, batch: string): string {
  const d = EXTERNAL_SOURCES.distributor_dispatches, p = EXTERNAL_SOURCES.pharmacy_stock_events, r = EXTERNAL_SOURCES.return_records;
  if (!EXTERNAL_SOURCE_KEYS.every(k => isSafeTableName(tables[k]))) throw new Error('Configured table names must be plain identifiers.');
  if (!isSafeFilterValue(batch)) throw new Error('Filter values may only contain letters, digits, spaces and . _ ( ) / -');
  const on = (alias: string, s: typeof p | typeof r) => `${alias}.${s.shipmentColumn} = d.${d.shipmentColumn} AND ${alias}.${s.batchColumn} = d.${d.batchColumn}`;
  return `SELECT d.${d.shipmentColumn}, d.qty, d.qty_unit, d.consignee, d.invoice_no FROM ${tables.distributor_dispatches} d`
    + ` LEFT JOIN ${tables.pharmacy_stock_events} p ON ${on('p', p)} LEFT JOIN ${tables.return_records} r ON ${on('r', r)}`
    + ` WHERE d.${d.batchColumn} = ${literal(batch)} AND p.${p.shipmentColumn} IS NULL AND r.${r.shipmentColumn} IS NULL ORDER BY d.${d.shipmentColumn} LIMIT 100`;
}
export type GapRow = { shipment_id: string; quantity: string; unit: string; consignee: string; reference: string };
export type GapResult = { ok: true; instance: string; sql: string; rows: GapRow[]; latency_ms: number; at: string } | { ok: false; failure: ExternalFailure; message: string; latency_ms: number };

/** How many rows match the batch filter, used to check that paging read every row. */
export function buildCount(source: ExternalSourceKey, table: string, filter: ExternalFilter): string {
  return `SELECT COUNT(*) FROM ${table} WHERE ${whereClause(source, table, filter)}`;
}

/** Maps one positional result row (13 ledger columns plus row_no) to named ledger values. */
export function mapRow(row: unknown[]): ExternalRow {
  if (!Array.isArray(row) || row.length < CSV_COLUMNS.length + 1) throw new Error(`Expected ${CSV_COLUMNS.length + 1} columns, received ${Array.isArray(row) ? row.length : typeof row}.`);
  const raw = (v: unknown) => v === null || v === undefined ? '' : String(v);
  const values = Object.fromEntries(CSV_COLUMNS.map((col, i) => [col, raw(row[i]).trim()]));
  // Zetaris REST returns numbers as strings and may use exponent notation ("1.0E2").
  const q = Number(values.quantity);
  if (values.quantity && Number.isFinite(q) && Number.isInteger(q) && !/^\d+$/.test(values.quantity)) values.quantity = String(q);
  // The ordering column is the last ledger column (occurred_at); the cursor keeps it untrimmed.
  return { values, row_key: raw(row[CSV_COLUMNS.length]), cursor: { order: raw(row[CSV_COLUMNS.length - 1]), row_no: raw(row[CSV_COLUMNS.length]) } };
}

export type CompleteRead =
  | { ok: true; mode: 'live' | 'mock'; instance: string; source: ExternalSourceKey; table: string; sql: string; query_ids: string[]; latency_ms: number; rows: ExternalRow[]; pages: number; count: number }
  | { ok: false; mode: 'live' | 'mock'; instance: string; source: ExternalSourceKey; table: string; failure: ExternalFailure; message: string; latency_ms: number; pages: number; rows_read: number };

/**
 * Reads every row a source holds for a filter: a COUNT, then keyset pages until the source has no
 * more. The read only succeeds if the pages returned exactly the counted number of distinct rows.
 * A failed page, a repeated row or a count mismatch fails the whole read, so nothing partial is imported.
 */
export async function readAll(src: ExternalSource, source: ExternalSourceKey, filter: ExternalFilter, opts: { pageSize?: number; maxRows?: number; signal?: AbortSignal } = {}): Promise<CompleteRead> {
  const pageSize = Math.max(1, Math.min(500, opts.pageSize ?? 200)), maxRows = opts.maxRows ?? 2000, start = Date.now();
  const base = { mode: src.mode, instance: src.instance, source, table: '' };
  const failed = (failure: ExternalFailure, message: string, pages: number, rows_read: number): CompleteRead => ({ ok: false, ...base, failure, message, latency_ms: Date.now() - start, pages, rows_read });
  const counted = await src.count(source, filter, { signal: opts.signal });
  if (!counted.ok) return failed(counted.failure, `Count query failed: ${counted.message}`, 0, 0);
  if (counted.count > maxRows) return failed('too_large', `The source holds ${counted.count} rows for this filter; this release imports at most ${maxRows} per read. Nothing was imported.`, 0, 0);
  const rows: ExternalRow[] = [], keys = new Set<string>(), queryIds: string[] = [];
  let after: Cursor | undefined, pages = 0, sql = '';
  for (;;) {
    if (pages * pageSize > maxRows) return failed('too_large', `Paging went past ${maxRows} rows. Nothing was imported.`, pages, rows.length);
    const page = await src.query(source, filter, pageSize, { signal: opts.signal, after });
    base.table = page.table;
    if (!page.ok) return failed(page.failure, `Page ${pages + 1} failed after ${rows.length} of ${counted.count} rows were read (${page.message}). Nothing was imported.`, pages, rows.length);
    pages++; queryIds.push(page.query_id); sql ||= page.sql;
    for (const row of page.rows) {
      if (row.row_key && keys.has(row.row_key)) return failed('incomplete', `Row ${row.row_key} was returned twice while paging; the source may have changed during the read. Nothing was imported.`, pages, rows.length);
      if (row.row_key) keys.add(row.row_key);
      rows.push(row);
    }
    if (!page.next || !page.rows.length) break;
    after = page.next;
  }
  if (rows.length !== counted.count) return failed('incomplete', `The count query reported ${counted.count} rows but paging returned ${rows.length}; the source may have changed during the read. Nothing was imported.`, pages, rows.length);
  return { ok: true, ...base, sql, query_ids: queryIds, latency_ms: Date.now() - start, rows, pages, count: counted.count };
}
