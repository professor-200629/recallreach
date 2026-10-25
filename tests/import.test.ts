import test from 'node:test';
import assert from 'node:assert/strict';
import { newCase, importExternal } from '../lib/recall/actions.ts';
import { reconcileCase } from '../lib/recall/engine.ts';
import { toLedgerCsv } from '../lib/recall/sample.ts';
import { CSV_COLUMNS, parseLedgerCsv } from '../lib/recall/csv.ts';
import { buildSelect, readAll, type Cursor, type ExternalCountResult, type ExternalFilter, type ExternalQueryResult, type ExternalRow, type ExternalSource, type ExternalSourceKey, type HealthResult, type QueryOptions } from '../lib/recall/sources/external.ts';
import type { RecallCase } from '../lib/recall/types.ts';

// Connected-source import correctness: identity is instance + table + row key, change is detected by
// content, reads are complete (count + keyset pages) or fail as a whole.
const NOW = '2026-10-24T00:00:00Z', LATER = '2026-10-24T01:00:00Z', LATEST = '2026-10-24T02:00:00Z';
const ALERT = { product: 'Nivara oral solution', manufacturer: 'Example Pharma (fictional)', batch: 'DEMO-042', unit: 'bottles', source_url: '', description: '' };
const FILTER: ExternalFilter = { batch: 'DEMO-042' };
const SOURCE: ExternalSourceKey = 'distributor_dispatches';

/** An opening-shipment row. Many rows share a timestamp so paging must rely on the row_no tie-breaker. */
const dispatch = (i: number, quantity = 10) => ({
  event_id: `S-${i}`, shipment_id: `SH-${i}`, type: 'shipment', from_state: '', to_state: 'available', product: ALERT.product, manufacturer: ALERT.manufacturer, batch: ALERT.batch,
  quantity: String(quantity), unit: 'bottles', location: `Pharmacy ${i}`, reference: `INV-${i}`, occurred_at: `2026-10-01T09:${String(Math.floor(i / 300)).padStart(2, '0')}:00Z`,
});

/** A source that pages like the SQL does (ordering column, then numeric row_no), with failure switches. */
class FakeSource implements ExternalSource {
  readonly system = 'zetaris' as const;
  readonly mode = 'live' as const;
  rows: Map<number, Record<string, string>> = new Map();
  failOnPage = 0; countDelta = 0; repeatFirstRowOnPage = 0; queries = 0;
  private page = 0;
  constructor(readonly instance = 'zetaris://zetaris.test/org/1', n = 0) { for (let i = 1; i <= n; i++) this.rows.set(i, dispatch(i)); }
  async health(): Promise<HealthResult> { return { ok: true, mode: 'live', latency_ms: 0, detail: 'fake' }; }
  async count(): Promise<ExternalCountResult> { this.page = 0; return { ok: true, count: this.rows.size + this.countDelta, latency_ms: 0 }; }
  async query(source: ExternalSourceKey, filter: ExternalFilter, limit: number, opts: QueryOptions = {}): Promise<ExternalQueryResult> {
    this.queries++; this.page++;
    const base = { mode: 'live' as const, instance: this.instance, source, table: 'recall_distributor.dispatches', query_id: `q${this.queries}`, latency_ms: 1 };
    if (this.page === this.failOnPage) return { ok: false, ...base, failure: 'query_failed', message: 'HTTP 500' };
    const all: ExternalRow[] = [...this.rows.entries()].map(([k, v]) => ({ values: v, row_key: String(k), cursor: { order: v.occurred_at, row_no: String(k) } }))
      .sort((a, b) => cmp(a.cursor!, b.cursor!));
    const after = opts.after, page = all.filter(r => !after || cmp(r.cursor!, after) > 0).slice(0, limit);
    if (this.page === this.repeatFirstRowOnPage && page.length) page[0] = all[0];
    return { ok: true, ...base, sql: buildSelect(source, base.table, filter, limit, after), rows: page, truncated: page.length >= limit, next: page.length >= limit ? page.at(-1)!.cursor! : null };
  }
}
const cmp = (a: Cursor, b: Cursor) => a.order < b.order ? -1 : a.order > b.order ? 1 : Number(a.row_no) - Number(b.row_no);

const freshCase = () => newCase({ action: 'create', name: 'Import test', alert: ALERT }, 'T', 'import-case', NOW);
async function importFrom(c: RecallCase, src: FakeSource, at = NOW, pageSize = 200) {
  const read = await readAll(src, SOURCE, FILTER, { pageSize });
  if (!read.ok) throw new Error(read.message);
  return importExternal(c, read, FILTER, 'T', at);
}

test('keyset paging uses the ordering column with row_no as the tie-breaker, bound as literals', () => {
  const sql = buildSelect(SOURCE, 'recall_distributor.dispatches', FILTER, 200, { order: "2026-10-01T09:00:00Z", row_no: '17' });
  assert.match(sql, /WHERE batch_no = 'DEMO-042' AND \(dispatched_at > '2026-10-01T09:00:00Z' OR \(dispatched_at = '2026-10-01T09:00:00Z' AND row_no > 17\)\) ORDER BY dispatched_at, row_no LIMIT 200$/);
  assert.match(buildSelect(SOURCE, 't', FILTER, 5, { order: "x' OR '1'='1", row_no: "1; DROP" }), /'x'' OR ''1''=''1'.*row_no > '1; DROP'/, 'cursor values are quoted, never spliced');
});

test('more than 500 rows are read completely across pages, sharing timestamps, with no row skipped or repeated', async () => {
  const c = await freshCase(), src = new FakeSource(undefined, 1200);
  const out = await importFrom(c, src);
  assert.deepEqual([out.imported, out.pages, out.source_count], [1200, 7, 1200]);
  assert.equal(new Set(c.records.map(r => r.event_id)).size, 1200);
  assert.equal(reconcileCase(c).shipped, 12_000);
  assert.match(c.sources[0].origin!.coverage!.note, /1200 rows read in 7 pages, matching the count query/);
});

test('unchanged re-import adds nothing and counts nothing twice', async () => {
  const c = await freshCase(), src = new FakeSource(undefined, 3);
  await importFrom(c, src);
  const again = await importFrom(c, src, LATER);
  assert.deepEqual([again.imported, again.updated, again.unchanged, c.sources.length, c.records.length], [0, 0, 3, 1, 3]);
  assert.equal(reconcileCase(c).shipped, 30);
  assert.match(c.audit.at(-1)!.detail, /already in this case unchanged/);
});

test('a row corrected at the source under the same key becomes a new version that supersedes the old one', async () => {
  const c = await freshCase(), src = new FakeSource(undefined, 3);
  await importFrom(c, src);
  const oldId = c.records.find(r => r.event_id === 'S-2')!.id;
  src.rows.set(2, dispatch(2, 7));
  const out = await importFrom(c, src, LATER);
  assert.deepEqual([out.imported, out.updated, out.unchanged], [0, 1, 2]);
  const r = reconcileCase(c);
  assert.equal(r.shipped, 27, 'the corrected quantity replaces the original; nothing is double counted');
  assert.equal(r.record_status[oldId].status, 'superseded');
  assert.ok(c.records.some(x => x.id === oldId), 'the earlier version is kept');
  assert.match(c.corrections[0].reason, /changed at recall_distributor\.dispatches at zetaris:\/\/zetaris\.test\/org\/1/);
  src.rows.set(2, dispatch(2, 5));
  assert.equal((await importFrom(c, src, LATEST)).updated, 1);
  assert.equal(reconcileCase(c).shipped, 25, 'a second change supersedes the latest version');
});

test('a changed row whose earlier version an operator already corrected is held for manual review', async () => {
  const c = await freshCase(), src = new FakeSource(undefined, 2);
  await importFrom(c, src);
  const original = c.records.find(r => r.event_id === 'S-1')!;
  c.corrections.push({ id: 'k1', at: NOW, actor: 'Operator', kind: 'withdraw', original_id: original.id, replacement_id: null, reason: 'Wrong pharmacy', evidence_reference: 'call note' });
  src.rows.set(1, dispatch(1, 9));
  const out = await importFrom(c, src, LATER);
  assert.deepEqual([out.imported, out.updated, out.conflicts], [0, 0, ['1']]);
  assert.match(c.audit.at(-1)!.detail, /operator already corrected the earlier version/);
});

test('a page failure part-way through fails the whole read; nothing is imported', async () => {
  const src = new FakeSource(undefined, 1200);
  src.failOnPage = 3;
  const read = await readAll(src, SOURCE, FILTER, { pageSize: 200 });
  assert.equal(read.ok, false);
  assert.ok(!read.ok && read.failure === 'query_failed' && /Page 3 failed after 400 of 1200 rows were read.*Nothing was imported/.test(read.message));
});

test('a count mismatch or a row repeated across pages fails the read as incomplete', async () => {
  const short = new FakeSource(undefined, 5); short.countDelta = 1;
  const a = await readAll(short, SOURCE, FILTER);
  assert.ok(!a.ok && a.failure === 'incomplete' && /reported 6 rows but paging returned 5/.test(a.message));
  const repeat = new FakeSource(undefined, 10); repeat.repeatFirstRowOnPage = 2;
  const b = await readAll(repeat, SOURCE, FILTER, { pageSize: 4 });
  assert.ok(!b.ok && b.failure === 'incomplete' && /returned twice/.test(b.message));
  const big = new FakeSource(undefined, 30);
  const d = await readAll(big, SOURCE, FILTER, { maxRows: 20 });
  assert.ok(!d.ok && d.failure === 'too_large');
});

test('no matching rows is a successful, recorded check, distinct from a failed query', async () => {
  const c = await freshCase(), empty = new FakeSource(undefined, 0);
  const out = await importFrom(c, empty);
  assert.deepEqual([out.imported, out.source_count, c.sources.length], [0, 0, 0]);
  assert.match(c.audit.at(-1)!.detail, /no rows in recall_distributor\.dispatches at .* match batch DEMO-042/);
  assert.equal(Object.values(c.scope_observations!)[0].rows, 0);
  const failing = new FakeSource(undefined, 0); failing.failOnPage = 1;
  const read = await readAll(failing, SOURCE, FILTER);
  assert.equal(read.ok, false, 'a failed query is reported as a failure, never as "no rows"');
});

test('identical row keys from two source instances are different rows', async () => {
  const c = await freshCase(), a = new FakeSource('zetaris://a.test/org/1', 2), b = new FakeSource('zetaris://b.test/org/1', 0);
  b.rows.set(1, dispatch(101)); b.rows.set(2, dispatch(102));
  await importFrom(c, a); const out = await importFrom(c, b, LATER);
  assert.deepEqual([out.imported, out.updated, c.corrections.length, c.sources.length], [2, 0, 0, 2]);
  assert.equal(reconcileCase(c).shipped, 40);
});

test('a row that disappears from the source is reported, not treated as a reversal', async () => {
  const c = await freshCase(), src = new FakeSource(undefined, 3);
  await importFrom(c, src);
  src.rows.delete(3);
  const out = await importFrom(c, src, LATER);
  assert.deepEqual([out.imported, out.missing_at_source], [0, ['3']]);
  assert.equal(reconcileCase(c).shipped, 30, 'its stock effect stays until an operator corrects it');
  assert.match(c.audit.at(-1)!.detail, /no longer returned by the source \(3\); they were not reversed/);
});

test('imports saved before instances and content hashes were recorded are still recognised', async () => {
  const c = await freshCase(), content = toLedgerCsv([1, 2].map(i => CSV_COLUMNS.map(col => dispatch(i)[col as keyof ReturnType<typeof dispatch>])));
  const records = parseLedgerCsv(content, 'legacy');
  c.records.push(...records);
  c.sources.push({ id: 'legacy', name: 'Old import', kind: 'zetaris', content, added_at: NOW, row_count: 2, origin: { system: 'zetaris', mode: 'live', table: 'recall_distributor.dispatches', query_id: 'q0', fetched_at: NOW, latency_ms: 1, sql: '', row_keys: ['1', '2'] } });
  const out = await importFrom(c, new FakeSource(undefined, 2), LATER);
  assert.deepEqual([out.imported, out.updated, out.unchanged], [0, 0, 2]);
  assert.match(c.audit.at(-1)!.detail, /did not record a source instance and were assumed/);
});
