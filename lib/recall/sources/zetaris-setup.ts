import type { ZetarisConfig } from './zetaris.ts';

// One-time administrator setup for a local Zetaris: registers RecallReach's fictional source
// databases as datasources. Runs only the fixed statements in integrations/zetaris/
// setup-datasources.sql, skips anything already registered, and stops at the first failure.
// The RecallReach app itself never runs these; its adapter sends read-only SELECTs only.
export type SetupStep = { kind: 'create' | 'register' | 'check'; datasource: string | null; sql: string };

export function parseSetupSql(text: string): SetupStep[] {
  return text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('--')).map(sql => {
    const create = /^CREATE DATASOURCE\s+([A-Za-z_][A-Za-z0-9_]*)\s/i.exec(sql), register = /^REGISTER DATASOURCE TABLES FROM\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(sql);
    if (create) return { kind: 'create' as const, datasource: create[1].toLowerCase(), sql };
    if (register) return { kind: 'register' as const, datasource: register[1].toLowerCase(), sql };
    if (/^SELECT\b/i.test(sql) && !sql.includes(';')) return { kind: 'check' as const, datasource: null, sql };
    throw new Error(`Unexpected statement in setup SQL: ${sql.slice(0, 60)}`);
  });
}

type Fetch = typeof fetch;
async function call(config: ZetarisConfig, sql: string, fetcher: Fetch): Promise<{ ok: true; rows: unknown[][] } | { ok: false; message: string }> {
  try {
    const res = await fetcher(`${config.restUrl}/sql-editor/sqls/run`, {
      method: 'POST', signal: AbortSignal.timeout(config.timeoutMs ?? 120_000),
      headers: { Authorization: `Bearer ${config.apiKey}`, 'X-Org-ID': config.orgId, 'X-Request-ID': crypto.randomUUID(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ queryId: crypto.randomUUID(), sql, source: 'SqlEditor', limit: 100 }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}` };
    let data: unknown = null;
    try { data = JSON.parse(text)?.data ?? null; } catch { /* DDL may return an empty body */ }
    return { ok: true, rows: Array.isArray(data) ? data.filter(Array.isArray) as unknown[][] : [] };
  } catch (error) {
    return { ok: false, message: (error as Error).name === 'TimeoutError' ? 'timed out' : `cannot reach Zetaris (${(error as Error).message})` };
  }
}

export async function runZetarisSetup(config: ZetarisConfig, steps: SetupStep[], opts: { dryRun?: boolean; fetcher?: Fetch; log: (line: string) => void }) {
  const fetcher = opts.fetcher ?? fetch, log = opts.log;
  const listed = await call(config, 'SHOW DATASOURCES', fetcher);
  if (!listed.ok) { log(`FAIL SHOW DATASOURCES: ${listed.message}`); return { ok: false, executed: 0, skipped: 0 }; }
  const existing = new Set(listed.rows.map(r => String(r[0] ?? '').toLowerCase()));
  log(`ok   SHOW DATASOURCES: ${existing.size ? [...existing].join(', ') : 'none registered yet'}`);
  const created = new Set<string>();
  let executed = 0, skipped = 0;
  for (const step of steps) {
    if (step.kind === 'create' && existing.has(step.datasource!)) { log(`skip ${step.datasource}: datasource already exists`); skipped++; continue; }
    // Tables are only checked for datasources that existed before this run; a new one is always registered.
    if (step.kind === 'register' && existing.has(step.datasource!) && !created.has(step.datasource!)) {
      const tables = await call(config, `SHOW DATASOURCE TABLES ${step.datasource}`, fetcher);
      if (tables.ok && tables.rows.length) { log(`skip ${step.datasource}: ${tables.rows.length} table(s) already registered`); skipped++; continue; }
    }
    if (opts.dryRun) { log(`would run: ${step.sql}`); continue; }
    const res = await call(config, step.sql, fetcher);
    if (!res.ok) { log(`FAIL ${step.sql.slice(0, 80)}…\n     ${res.message}`); return { ok: false, executed, skipped }; }
    executed++;
    if (step.kind === 'create') { existing.add(step.datasource!); created.add(step.datasource!); }
    log(step.kind === 'check' ? `ok   check: ${res.rows.map(r => r.join(' ')).join(' | ')}` : `ok   ${step.sql.split(' OPTIONS')[0]}`);
  }
  return { ok: true, executed, skipped };
}
