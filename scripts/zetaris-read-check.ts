// Checks complete reads (COUNT + keyset pages) against a configured Zetaris instance, with a small
// page size so paging is exercised. Prints counts and timings only; never the API key.
// Run: node --env-file=.dev.vars --experimental-transform-types scripts/zetaris-read-check.ts [pageSize]
import { ZetarisSource, zetarisConfigFromEnv } from '../lib/recall/sources/zetaris.ts';
import { EXTERNAL_SOURCE_KEYS, readAll } from '../lib/recall/sources/external.ts';

const config = zetarisConfigFromEnv(process.env);
if (!config) { console.error('Zetaris is not configured (ZETARIS_REST_URL, ZETARIS_API_KEY, ZETARIS_ORG_ID).'); process.exit(1); }
const pageSize = Number(process.argv[2]) || 2, source = new ZetarisSource(config);
console.log(`Instance ${source.instance}; page size ${pageSize}; ${new Date().toISOString()}`);
let failed = false;
for (const batch of ['DEMO-042', 'VL-2207', 'NO-SUCH-BATCH']) for (const key of EXTERNAL_SOURCE_KEYS) {
  const read = await readAll(source, key, { batch }, { pageSize });
  if (read.ok) {
    const keys = read.rows.map(r => r.row_key);
    console.log(`OK   ${batch.padEnd(13)} ${key.padEnd(22)} ${String(read.count).padStart(3)} rows in ${read.pages} pages, ${read.latency_ms} ms; distinct keys ${new Set(keys).size}; keys ${keys.join(',') || '-'}`);
  } else { failed = true; console.log(`FAIL ${batch.padEnd(13)} ${key.padEnd(22)} ${read.failure}: ${read.message}`); }
}
process.exit(failed ? 1 : 0);
