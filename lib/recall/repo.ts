// SQL access for cases, case memory and integration checks. Every query that reads or
// writes case data filters by owner_id, so a guessed case ID never reaches another
// user's data. Works with Cloudflare D1 and with the SQLite shim used in tests.
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  /** Runs statements as one transaction (D1 batch): if any statement fails, none of them is applied. */
  batch(statements: SqlStatement[]): Promise<unknown[]>;
}

export type CaseRow = { id: string; owner_id: string; name: string; payload: string; version: number; created_at: string; updated_at: string };
export type MemoryRow = { case_id: string; owner_id: string; engine: string; state: string; version: number; updated_at: string };
export type SaveResult = 'saved' | 'case_conflict' | 'memory_conflict';
export type MemoryWrite = { engine: string; state: string; expectedVersion: number | null };
// The guard statement fails (json() of a non-JSON string raises an error) unless both rows now carry
// this save's token, which aborts and rolls back the whole batch.
const GUARD_FAILED = 'recallreach-save-guard';

export type IntegrationCheckRow = { id: string; owner_id: string; integration: string; mode: string; operation: string; ok: number; latency_ms: number; detail: string; at: string };

export class CaseRepository {
  constructor(private db: SqlDatabase) {}

  listCases(owner: string) {
    return this.db.prepare('SELECT id, name, created_at, updated_at FROM recall_cases WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 100').bind(owner).all<{ id: string; name: string; created_at: string; updated_at: string }>().then(r => r.results);
  }
  getCase(id: string, owner: string) {
    return this.db.prepare('SELECT * FROM recall_cases WHERE id = ? AND owner_id = ?').bind(id, owner).first<CaseRow>();
  }
  async insertCase(row: CaseRow) {
    await this.db.prepare('INSERT INTO recall_cases (id, owner_id, name, payload, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(row.id, row.owner_id, row.name, row.payload, row.version, row.created_at, row.updated_at).run();
  }
  /** Optimistic write: succeeds only if nobody saved a newer version in between. */
  async updateCase(id: string, owner: string, expectedVersion: number, payload: string, version: number, updatedAt: string): Promise<boolean> {
    const r = await this.db.prepare('UPDATE recall_cases SET payload = ?, version = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND version = ?').bind(payload, version, updatedAt, id, owner, expectedVersion).run();
    return r.meta.changes === 1;
  }

  /**
   * Saves a case and, optionally, its memory in one transaction. Both writes are guarded by the
   * versions read before the change, and each payload carries a unique save token; a final guard
   * statement checks both tokens and aborts the batch otherwise. Either both commit or neither does.
   */
  async saveCaseAndMemory(id: string, owner: string, expectedVersion: number, payload: string, version: number, updatedAt: string, token: string, memory: MemoryWrite | null): Promise<SaveResult> {
    const statements = [this.db.prepare('UPDATE recall_cases SET payload = ?, version = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND version = ?').bind(payload, version, updatedAt, id, owner, expectedVersion)];
    if (memory) statements.push(memory.expectedVersion === null
      ? this.db.prepare('INSERT INTO case_memory (case_id, owner_id, engine, state, version, updated_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(case_id) DO NOTHING').bind(id, owner, memory.engine, memory.state, updatedAt)
      : this.db.prepare('UPDATE case_memory SET engine = ?, state = ?, version = version + 1, updated_at = ? WHERE case_id = ? AND owner_id = ? AND version = ?').bind(memory.engine, memory.state, updatedAt, id, owner, memory.expectedVersion));
    const caseOk = "EXISTS (SELECT 1 FROM recall_cases WHERE id = ? AND owner_id = ? AND json_extract(payload, '$.save_token') = ?)";
    const memoryOk = "EXISTS (SELECT 1 FROM case_memory WHERE case_id = ? AND owner_id = ? AND json_extract(state, '$.save_token') = ?)";
    statements.push(this.db.prepare(`SELECT json(CASE WHEN ${caseOk}${memory ? ` AND ${memoryOk}` : ''} THEN '1' ELSE '${GUARD_FAILED}' END) AS ok`)
      .bind(id, owner, token, ...(memory ? [id, owner, token] : [])));
    try {
      await this.db.batch(statements);
      return 'saved';
    } catch (error) {
      if (!/malformed JSON/i.test((error as Error)?.message ?? '')) throw error;
      const current = await this.getCase(id, owner);
      return current?.version === expectedVersion ? 'memory_conflict' : 'case_conflict';
    }
  }

  getMemory(caseId: string, owner: string) {
    return this.db.prepare('SELECT * FROM case_memory WHERE case_id = ? AND owner_id = ?').bind(caseId, owner).first<MemoryRow>();
  }
  async putMemory(caseId: string, owner: string, engine: string, state: string, expectedVersion: number | null, updatedAt: string): Promise<boolean> {
    if (expectedVersion === null) {
      const r = await this.db.prepare('INSERT INTO case_memory (case_id, owner_id, engine, state, version, updated_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(case_id) DO NOTHING').bind(caseId, owner, engine, state, updatedAt).run();
      return r.meta.changes === 1;
    }
    const r = await this.db.prepare('UPDATE case_memory SET engine = ?, state = ?, version = version + 1, updated_at = ? WHERE case_id = ? AND owner_id = ? AND version = ?').bind(engine, state, updatedAt, caseId, owner, expectedVersion).run();
    return r.meta.changes === 1;
  }

  async recordCheck(row: IntegrationCheckRow) {
    await this.db.prepare('INSERT INTO integration_checks (id, owner_id, integration, mode, operation, ok, latency_ms, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(row.id, row.owner_id, row.integration, row.mode, row.operation, row.ok, row.latency_ms, row.detail.slice(0, 500), row.at).run();
  }
  listChecks(owner: string, limit = 20) {
    return this.db.prepare('SELECT * FROM integration_checks WHERE owner_id = ? ORDER BY at DESC LIMIT ?').bind(owner, limit).all<IntegrationCheckRow>().then(r => r.results);
  }
  /** The newest check of one kind, however many other checks came after it. */
  lastCheck(owner: string, integration: string, mode: string, operation: string) {
    return this.db.prepare('SELECT * FROM integration_checks WHERE owner_id = ? AND integration = ? AND mode = ? AND operation = ? ORDER BY at DESC LIMIT 1').bind(owner, integration, mode, operation).first<IntegrationCheckRow>();
  }
}
