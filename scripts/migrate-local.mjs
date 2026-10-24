// Applies drizzle/*.sql migrations to the local D1 database used by `npm run dev` and
// `npm start`. Each file is applied only if none of the tables it creates exist yet,
// so the script is safe to run repeatedly. Production migrations are applied by the host.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const config = 'dist/server/wrangler.json';
if (!existsSync(config)) {
  console.error('dist/server/wrangler.json is missing. Run `npm run build` once, then rerun this script.');
  process.exit(1);
}
function wrangler(args) {
  const res = spawnSync(process.execPath, ['--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', config, '--persist-to', '.wrangler/state', ...args], { encoding: 'utf8' });
  if (res.status !== 0) { console.error(res.stderr || res.stdout); process.exit(res.status ?? 1); }
  return res.stdout;
}
const listing = JSON.parse(wrangler(['--json', '--command', "SELECT name FROM sqlite_master WHERE type = 'table'"]));
const existing = new Set(listing.flatMap(r => r.results ?? []).map(r => r.name));
for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) {
  const tables = [...readFileSync(`drizzle/${file}`, 'utf8').matchAll(/CREATE TABLE `([^`]+)`/g)].map(m => m[1]);
  const present = tables.filter(t => existing.has(t));
  if (present.length === tables.length) { console.log(`skip   ${file} (tables already exist)`); continue; }
  if (present.length) { console.error(`${file}: only some tables exist (${present.join(', ')}). Inspect the local database before continuing.`); process.exit(1); }
  wrangler(['--file', `drizzle/${file}`]);
  console.log(`applied ${file} (${tables.join(', ')})`);
}
