import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SqlDatabase, SqlStatement } from '../../lib/recall/repo.ts';

// D1-shaped wrapper over Node's built-in SQLite, migrated with the same SQL files that
// production uses. Passing a file path lets a test reopen the database as a "fresh session".
const migrations = fileURLToPath(new URL('../../drizzle/', import.meta.url));

export function sqliteD1(path = ':memory:'): SqlDatabase & { close(): void; raw: DatabaseSync } {
  const db = new DatabaseSync(path);
  const applied = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recall_cases'").get();
  if (!applied) for (const file of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(migrations + file, 'utf8').split('--> statement-breakpoint')) if (statement.trim()) db.exec(statement);
  }
  return {
    raw: db,
    close: () => db.close(),
    prepare(sql: string): SqlStatement {
      let params: unknown[] = [];
      const stmt: SqlStatement = {
        bind(...values: unknown[]) { params = values; return stmt; },
        async first<T>() { return (db.prepare(sql).get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: db.prepare(sql).all(...(params as never[])) as T[] }; },
        async run() { const r = db.prepare(sql).run(...(params as never[])); return { meta: { changes: Number(r.changes) } }; },
      };
      return stmt;
    },
  };
}
