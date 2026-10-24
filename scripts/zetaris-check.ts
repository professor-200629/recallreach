// Read-only verification of a real Zetaris connection, using the same settings and adapter
// as the app (.dev.vars, or ZETARIS_* environment variables). Run: npm run zetaris:check
// It sends only SELECT and SHOW statements and never prints the API key.
import { existsSync, readFileSync } from 'node:fs';
import { zetarisConfigFromEnv, ZetarisSource } from '../lib/recall/sources/zetaris.ts';
import { EXTERNAL_SOURCE_KEYS, EXTERNAL_SOURCES, isSafeTableName } from '../lib/recall/sources/external.ts';

function devVars(): Record<string, string> {
  if (!existsSync('.dev.vars')) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const vars: Record<string, string> = { ...devVars(), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ZETARIS_')) as [string, string][]) };
const missing = ['ZETARIS_REST_URL', 'ZETARIS_ORG_ID', 'ZETARIS_API_KEY'].filter(k => !vars[k]);
if (missing.length) { console.error(`Not configured. Missing in .dev.vars: ${missing.join(', ')}`); process.exit(2); }
const config = zetarisConfigFromEnv(vars)!;
const z = new ZetarisSource({ ...config, timeoutMs: 60_000 });
let failures = 0;
const fail = (label: string, detail: string) => { failures++; console.log(`FAIL ${label}: ${detail}`); };
const pass = (label: string, detail: string) => console.log(`ok   ${label}: ${detail}`);

console.log(`Zetaris REST ${new URL(config.restUrl).host}, organisation ${config.orgId}, API key set (not shown)\n`);

const health = await z.health();
if (health.ok) pass('SELECT 1', `${health.latency_ms} ms`); else { fail('SELECT 1', `${health.failure}: ${health.detail}`); process.exit(1); }

const ds = await z.probe('SHOW DATASOURCES');
if (ds.ok) pass('SHOW DATASOURCES', `${ds.rows.length} rows in ${ds.latency_ms} ms: ${ds.rows.map(r => r[0]).join(', ').slice(0, 300)}`);
else fail('SHOW DATASOURCES', `${ds.failure}: ${ds.message}`);

for (const key of EXTERNAL_SOURCE_KEYS) {
  const table = config.tables[key];
  if (!isSafeTableName(table)) { fail(key, `configured table "${table}" is not a plain identifier`); continue; }
  const count = await z.probe(`SELECT COUNT(*) FROM ${table}`);
  if (count.ok) pass(`${EXTERNAL_SOURCES[key].label} (${table})`, `${count.rows[0]?.[0]} rows in ${count.latency_ms} ms`);
  else { fail(`${EXTERNAL_SOURCES[key].label} (${table})`, `${count.failure}: ${count.message}`); continue; }
  const mapped = await z.query(key, { batch: 'DEMO-042' }, 50);
  if (mapped.ok) pass(`  mapped query, batch DEMO-042`, `${mapped.rows.length} rows in ${mapped.latency_ms} ms; events ${mapped.rows.map(r => r.values.event_id || '(none)').join(', ')}`);
  else fail('  mapped query, batch DEMO-042', `${mapped.failure}: ${mapped.message}`);
}

console.log(failures ? `\n${failures} check(s) failed. Zetaris is NOT verified.` : '\nAll checks passed against the live Zetaris instance.');
process.exit(failures ? 1 : 0);
