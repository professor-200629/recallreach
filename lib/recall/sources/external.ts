import { CSV_COLUMNS } from '../csv.ts';

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

export type ExternalRow = { values: Record<string, string>; row_key: string };
export type ExternalFailure = 'not_configured' | 'unreachable' | 'auth_failed' | 'query_failed' | 'timeout' | 'invalid_response' | 'invalid_filter';
export type ExternalQueryResult =
  | { ok: true; mode: 'live' | 'mock'; source: ExternalSourceKey; table: string; sql: string; query_id: string; latency_ms: number; rows: ExternalRow[]; truncated: boolean }
  | { ok: false; mode: 'live' | 'mock'; source: ExternalSourceKey; table: string; failure: ExternalFailure; message: string; latency_ms: number; query_id: string };
export type HealthResult = { ok: boolean; mode: 'live' | 'mock'; latency_ms: number; detail: string; failure?: ExternalFailure };
export type IntegrationEvent = { integration: 'zetaris'; mode: 'live' | 'mock'; operation: string; ok: boolean; latency_ms: number; detail: string };

export interface ExternalSource {
  readonly system: 'zetaris';
  readonly mode: 'live' | 'mock';
  health(): Promise<HealthResult>;
  query(source: ExternalSourceKey, filter: { batch: string; shipment_id?: string }, limit: number): Promise<ExternalQueryResult>;
}

// Filter values become SQL string literals, so they are restricted to the characters
// batch and shipment identifiers actually use, then quote-escaped as a second guard.
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9 ._()/-]{0,79}$/;
const SAFE_TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,2}$/;
export const isSafeFilterValue = (v: string) => SAFE_VALUE.test(v);
export const isSafeTableName = (v: string) => SAFE_TABLE.test(v);
const literal = (v: string) => `'${v.replaceAll("'", "''")}'`;

export function buildSelect(source: ExternalSourceKey, table: string, filter: { batch: string; shipment_id?: string }, limit: number): string {
  const s = EXTERNAL_SOURCES[source];
  if (!isSafeTableName(table)) throw new Error(`Configured table name for ${source} is not a plain identifier.`);
  if (!isSafeFilterValue(filter.batch) || (filter.shipment_id !== undefined && !isSafeFilterValue(filter.shipment_id))) throw new Error('Filter values may only contain letters, digits, spaces and . _ ( ) / -');
  const n = Math.max(1, Math.min(500, Math.trunc(limit)));
  const where = [`${s.batchColumn} = ${literal(filter.batch)}`, ...(filter.shipment_id ? [`${s.shipmentColumn} = ${literal(filter.shipment_id)}`] : [])].join(' AND ');
  return `SELECT ${s.select} FROM ${table} WHERE ${where} ORDER BY ${s.orderColumn}, row_no LIMIT ${n}`;
}

/** Maps one positional result row (13 ledger columns plus row_no) to named ledger values. */
export function mapRow(row: unknown[]): ExternalRow {
  if (!Array.isArray(row) || row.length < CSV_COLUMNS.length + 1) throw new Error(`Expected ${CSV_COLUMNS.length + 1} columns, received ${Array.isArray(row) ? row.length : typeof row}.`);
  const values = Object.fromEntries(CSV_COLUMNS.map((col, i) => [col, row[i] === null || row[i] === undefined ? '' : String(row[i]).trim()]));
  // Zetaris REST returns numbers as strings and may use exponent notation ("1.0E2").
  const q = Number(values.quantity);
  if (values.quantity && Number.isFinite(q) && Number.isInteger(q) && !/^\d+$/.test(values.quantity)) values.quantity = String(q);
  return { values, row_key: String(row[CSV_COLUMNS.length] ?? '') };
}
