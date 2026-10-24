import type { RecallCase, AuditEntry } from './types.ts';
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function appendAudit(c: RecallCase, actor: string, action: string, detail: string) {
  const entry: Omit<AuditEntry, 'hash'> = { id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, previous_hash: c.audit.at(-1)?.hash ?? 'GENESIS' };
  c.audit.push({ ...entry, hash: await digest(JSON.stringify(entry)) });
}
export async function verifyAudit(entries: AuditEntry[]) {
  let previous = 'GENESIS';
  for (const { hash, ...entry } of entries) {
    if (entry.previous_hash !== previous || await digest(JSON.stringify(entry)) !== hash) return false;
    previous = hash;
  }
  return true;
}
