// Deploys the public demo (rules mode only, fictional data, anonymous per-browser sandboxes) to the
// Cloudflare account Wrangler is signed in to, on the free Workers plan. Run `npm run build` first.
// It creates (or reuses) a D1 database named recallreach-demo, applies drizzle/*.sql to it, and
// deploys the built Worker as "recallreach-demo" with RECALLREACH_PUBLIC_DEMO=1. No secrets are set:
// the demo never has a model key or a Zetaris connection.
// Usage: node scripts/deploy-demo.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const NAME = 'recallreach-demo';
const wrangler = (...args) => execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const list = JSON.parse(wrangler('d1', 'list', '--json'));
let db = list.find(d => d.name === NAME);
if (!db) { wrangler('d1', 'create', NAME); db = JSON.parse(wrangler('d1', 'list', '--json')).find(d => d.name === NAME); }
if (!db?.uuid) throw new Error(`Could not find or create the D1 database ${NAME}.`);
console.log(`D1 database ${NAME}: ${db.uuid}`);

const built = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'));
const config = { ...built, name: NAME, topLevelName: NAME, vars: { ...built.vars, RECALLREACH_PUBLIC_DEMO: '1' },
  d1_databases: [{ binding: 'DB', database_name: NAME, database_id: db.uuid, migrations_dir: '../../drizzle' }] };
writeFileSync('dist/server/wrangler.demo.json', JSON.stringify(config, null, 2));

console.log(wrangler('d1', 'migrations', 'apply', NAME, '--remote', '--config', 'dist/server/wrangler.demo.json'));
console.log(wrangler('deploy', '--config', 'dist/server/wrangler.demo.json'));
