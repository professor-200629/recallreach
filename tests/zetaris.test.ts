import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSelect, mapRow } from '../lib/recall/sources/external.ts';
import { DEFAULT_ZETARIS_TABLES, ZetarisSource, zetarisConfigFromEnv } from '../lib/recall/sources/zetaris.ts';
import type { IntegrationEvent } from '../lib/recall/sources/external.ts';

// These tests check the adapter against the request/response contract documented in
// zetaris/getting-started. They do not contact a Zetaris instance.
const config = { restUrl: 'https://zetaris.test/api/v1.0', apiKey: 'secret-key', orgId: '7', tables: DEFAULT_ZETARIS_TABLES, timeoutMs: 500 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fake(respond: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); seen.push({ url, headers: new Headers(init.headers), body }); return respond(body); }) as unknown as typeof fetch;
  return { fetcher, seen };
}

test('queries use the documented endpoint, headers and body, and map positional rows', async () => {
  const events: IntegrationEvent[] = [];
  const row = ['Q-D', 'RR-104', 'movement', 'available', 'quarantined', 'Nivara oral solution', 'Example Pharma (fictional)', 'DEMO-042', '4.0E1', 'bottles', 'Destination pending confirmation', 'DRILL-HOLD-104', '2026-10-04T12:00:00Z', '17'];
  const { fetcher, seen } = fake(() => Response.json({ data: [row] }));
  const res = await new ZetarisSource(config, e => events.push(e), fetcher).query('pharmacy_stock_events', { batch: 'DEMO-042', shipment_id: 'RR-104' }, 50);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const [req] = seen;
  assert.equal(req.url, 'https://zetaris.test/api/v1.0/sql-editor/sqls/run');
  assert.equal(req.headers.get('authorization'), 'Bearer secret-key'); assert.equal(req.headers.get('x-org-id'), '7'); assert.match(req.headers.get('x-request-id')!, UUID);
  assert.match(String(req.body.queryId), UUID); assert.equal(req.body.source, 'SqlEditor'); assert.equal(req.body.limit, 50);
  assert.equal(req.body.sql, "SELECT txn_id, consignment_ref, 'movement', from_status, to_status, product_name, manufacturer_name, batch_no, qty, qty_unit, pharmacy_name, doc_ref, recorded_at, row_no FROM recall_pharmacy.stock_events WHERE batch_no = 'DEMO-042' AND consignment_ref = 'RR-104' ORDER BY recorded_at, row_no LIMIT 50");
  assert.equal(res.rows[0].values.quantity, '40', 'exponent notation from REST is normalised'); assert.equal(res.rows[0].row_key, '17');
  assert.equal(res.mode, 'live'); assert.equal(events[0].ok, true);
});

test('auth failures, bad responses, wrong shapes, network errors and timeouts are classified', async () => {
  const cases: [() => Response | Promise<Response>, string][] = [
    [() => new Response('nope', { status: 401 }), 'auth_failed'],
    [() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'invalid_response'],
    [() => Response.json({ data: [['too', 'short']] }), 'invalid_response'],
    [() => new Response('{"error":"Table not found"}', { status: 400 }), 'query_failed'],
    [() => { throw new TypeError('fetch failed'); }, 'unreachable'],
    [() => new Promise<Response>((_, reject) => setTimeout(() => reject(Object.assign(new Error('t'), { name: 'TimeoutError' })), 10)), 'timeout'],
  ];
  for (const [respond, failure] of cases) {
    const res = await new ZetarisSource(config, () => {}, fake(respond).fetcher).query('return_records', { batch: 'DEMO-042' }, 10);
    assert.equal(res.ok, false); if (!res.ok) assert.equal(res.failure, failure);
  }
});

test('health check runs SELECT 1 and requires "1" back', async () => {
  assert.equal((await new ZetarisSource(config, () => {}, fake(() => Response.json({ data: [['1']] })).fetcher).health()).ok, true);
  assert.equal((await new ZetarisSource(config, () => {}, fake(() => Response.json({ data: [['0']] })).fetcher).health()).ok, false);
});

test('filter values and table names cannot inject SQL', () => {
  assert.throws(() => buildSelect('return_records', 'a.b', { batch: "X' OR '1'='1" }, 10), /Filter values/);
  assert.throws(() => buildSelect('return_records', 'a.b', { batch: 'X; DROP TABLE t' }, 10), /Filter values/);
  assert.throws(() => buildSelect('return_records', 'a.b; DROP TABLE x', { batch: 'X' }, 10), /plain identifier/);
  assert.match(buildSelect('return_records', 'a.b', { batch: 'X' }, 99999), /LIMIT 500$/);
  assert.throws(() => mapRow(['a']), /Expected 14 columns/);
});

test('configuration requires all three settings and validates them', () => {
  assert.equal(zetarisConfigFromEnv({}), null);
  assert.equal(zetarisConfigFromEnv({ ZETARIS_REST_URL: 'http://localhost:8888/api/v1.0', ZETARIS_API_KEY: 'k' }), null);
  assert.throws(() => zetarisConfigFromEnv({ ZETARIS_REST_URL: 'localhost:8888', ZETARIS_API_KEY: 'k', ZETARIS_ORG_ID: '1' }), /http/);
  assert.equal(zetarisConfigFromEnv({ ZETARIS_REST_URL: 'http://localhost:8888/api/v1.0/', ZETARIS_API_KEY: 'k', ZETARIS_ORG_ID: '1', ZETARIS_TABLES: '{"return_records":"x.y"}' })!.tables.return_records, 'x.y');
});
