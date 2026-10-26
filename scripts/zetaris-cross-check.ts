// One read-only query across the three fictional source systems through Zetaris: consignments of a batch
// that the distributor dispatched but that neither the pharmacy stock system nor the returns register
// mentions. It shows that Zetaris can join separately owned datasources; the app itself still reads each
// table on its own and leaves the arithmetic to the engine. Prints rows and timing only; never the API key.
// Run: node --env-file=.dev.vars --experimental-transform-types --no-warnings scripts/zetaris-cross-check.ts [batch]
import { ZetarisSource, zetarisConfigFromEnv } from '../lib/recall/sources/zetaris.ts';
import { isSafeTableName } from '../lib/recall/sources/external.ts';

const config = zetarisConfigFromEnv(process.env);
if (!config) { console.error('Zetaris is not configured (ZETARIS_REST_URL, ZETARIS_API_KEY, ZETARIS_ORG_ID).'); process.exit(1); }
const batch = process.argv[2] ?? 'DEMO-042';
if (!/^[A-Za-z0-9._-]{1,40}$/.test(batch)) { console.error('The batch must be letters, digits, dots, hyphens or underscores.'); process.exit(1); }
const { distributor_dispatches: d, pharmacy_stock_events: p, return_records: r } = config.tables;
if (![d, p, r].every(isSafeTableName)) { console.error('A configured table name is not a plain identifier.'); process.exit(1); }

const sql = `SELECT d.consignment_ref, d.qty, d.qty_unit, d.consignee, d.invoice_no FROM ${d} d `
  + `LEFT JOIN ${p} p ON p.consignment_ref = d.consignment_ref AND p.batch_no = d.batch_no `
  + `LEFT JOIN ${r} r ON r.consignment_ref = d.consignment_ref AND r.batch_no = d.batch_no `
  + `WHERE d.batch_no = '${batch}' AND p.consignment_ref IS NULL AND r.consignment_ref IS NULL ORDER BY d.consignment_ref`;
const z = new ZetarisSource({ ...config, timeoutMs: 120_000 });
console.log(`Instance ${z.instance}; ${new Date().toISOString()}`);
console.log(`Query (read-only, one statement across ${d}, ${p} and ${r}):\n  ${sql}\n`);
const res = await z.probe(sql, 100);
if (!res.ok) { console.log(`FAIL ${res.failure}: ${res.message} (${res.latency_ms} ms)`); process.exit(1); }
console.log(`OK   ${res.rows.length} row${res.rows.length === 1 ? '' : 's'} in ${res.latency_ms} ms`);
for (const row of res.rows) console.log(`     ${row.map(v => String(v)).join(' | ')}`);
console.log('\nThese are source reports on fictional data. A consignment missing downstream is a gap to follow up, not proof of where the stock is.');
