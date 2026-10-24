// Registers RecallReach's fictional source databases in your local Zetaris (administrator API key
// required). Run: npm run zetaris:setup [-- --dry-run]
// Uses ZETARIS_* from .dev.vars, never prints the key, and runs only the statements in
// integrations/zetaris/setup-datasources.sql.
import { readFileSync } from 'node:fs';
import { zetarisConfigFromEnv } from '../lib/recall/sources/zetaris.ts';
import { parseSetupSql, runZetarisSetup } from '../lib/recall/sources/zetaris-setup.ts';
import { loadDevVars } from './dev-vars.ts';

const vars = loadDevVars();
const missing = ['ZETARIS_REST_URL', 'ZETARIS_ORG_ID', 'ZETARIS_API_KEY'].filter(k => !vars[k]);
if (missing.length) { console.error(`Not configured. Missing in .dev.vars: ${missing.join(', ')}`); process.exit(2); }
const config = zetarisConfigFromEnv(vars)!;
const dryRun = process.argv.includes('--dry-run');
console.log(`Zetaris REST ${new URL(config.restUrl).host}, organisation ${config.orgId}, API key set (not shown)${dryRun ? ' — DRY RUN' : ''}\n`);
const steps = parseSetupSql(readFileSync('integrations/zetaris/setup-datasources.sql', 'utf8'));
const result = await runZetarisSetup(config, steps, { dryRun, log: line => console.log(line) });
console.log(result.ok ? `\nDone: ${result.executed} statement(s) run, ${result.skipped} skipped.` : '\nSetup stopped at the first failure; nothing after it was run.');
process.exit(result.ok ? 0 : 1);
