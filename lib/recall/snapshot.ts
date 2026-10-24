import type { EvidenceSnapshot, RecallCase, Reconciliation, ShipmentSnapshot } from './types.ts';

// Change-detection fingerprints (two FNV-1a passes, 64 bits). They detect that
// evidence changed; they are not a security hash and prove nothing about authenticity.
function fnv(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
export const hash64 = (text: string) => fnv(text, 0x811c9dc5) + fnv(text, 0x050c5d1f);

type CaseEvidence = Pick<RecallCase, 'records' | 'corrections'>;
const SNAPSHOT_LIMIT = 20;

export function evidenceFingerprint(c: CaseEvidence, r: Reconciliation): string {
  const parts = c.records.map(row => `${row.id}=${r.record_status[row.id]?.status ?? '?'}`).sort();
  return hash64([...parts, ...(c.corrections ?? []).map(k => `correction:${k.id}`)].join('\n'));
}

/** Fingerprint of everything that bears on one shipment, so a conclusion about it can be rechecked. */
export function shipmentFingerprint(c: CaseEvidence, r: Reconciliation, shipmentId: string): string {
  const rows = c.records.filter(row => row.shipment_id === shipmentId)
    .map(row => [row.id, r.record_status[row.id]?.status, row.type, row.from_state, row.to_state, row.quantity, row.location].join('|')).sort();
  const b = r.shipments.find(s => s.shipment_id === shipmentId);
  return hash64([...rows, b ? [b.available, b.quarantined, b.returned, b.dispensed].join('/') : 'no-accepted-opening'].join('\n'));
}

/** Fingerprint of a specific set of cited records (their current status and content). */
export function recordsFingerprint(c: CaseEvidence, r: Reconciliation, ids: string[]): string {
  const byId = new Map(c.records.map(row => [row.id, row]));
  return hash64([...new Set(ids)].sort().map(id => {
    const row = byId.get(id);
    return row ? [id, r.record_status[id]?.status, row.quantity, row.from_state, row.to_state, row.location].join('|') : `${id}|missing`;
  }).join('\n'));
}

export function takeSnapshot(c: RecallCase, r: Reconciliation, trigger: EvidenceSnapshot['trigger'], actor: string, runId: string | null, at: string): EvidenceSnapshot {
  const shipments: Record<string, ShipmentSnapshot> = {};
  for (const s of r.shipments) shipments[s.shipment_id] = { available: s.available, quarantined: s.quarantined, returned: s.returned, dispensed: s.dispensed, fingerprint: shipmentFingerprint(c, r, s.shipment_id) };
  return {
    id: crypto.randomUUID(), at, actor, trigger, run_id: runId, fingerprint: evidenceFingerprint(c, r),
    record_count: c.records.length, correction_count: (c.corrections ?? []).length,
    totals: { shipped: r.shipped, available: r.available, quarantined: r.quarantined, returned: r.returned, dispensed: r.dispensed },
    shipments, issue_ids: r.issues.map(i => i.id),
  };
}

export function recordSnapshot(c: RecallCase, snapshot: EvidenceSnapshot) {
  c.snapshots = [...(c.snapshots ?? []), snapshot].slice(-SNAPSHOT_LIMIT);
}

export type SnapshotDiff = {
  previous: { id: string; at: string; trigger: EvidenceSnapshot['trigger'] } | null;
  changed: boolean;
  totals: { field: keyof EvidenceSnapshot['totals']; before: number; after: number }[];
  shipments: { shipment_id: string; before: ShipmentSnapshot | null; after: ShipmentSnapshot | null }[];
  issues_opened: string[]; issues_closed: string[];
  records_added: number; corrections_added: number;
};

export function compareSnapshots(previous: EvidenceSnapshot | undefined, current: EvidenceSnapshot): SnapshotDiff {
  if (!previous) return { previous: null, changed: true, totals: [], shipments: Object.entries(current.shipments).map(([shipment_id, after]) => ({ shipment_id, before: null, after })), issues_opened: current.issue_ids, issues_closed: [], records_added: current.record_count, corrections_added: current.correction_count };
  const totals = (Object.keys(current.totals) as (keyof EvidenceSnapshot['totals'])[])
    .filter(field => previous.totals[field] !== current.totals[field])
    .map(field => ({ field, before: previous.totals[field], after: current.totals[field] }));
  const ids = new Set([...Object.keys(previous.shipments), ...Object.keys(current.shipments)]);
  const shipments = [...ids].sort().filter(id => previous.shipments[id]?.fingerprint !== current.shipments[id]?.fingerprint)
    .map(shipment_id => ({ shipment_id, before: previous.shipments[shipment_id] ?? null, after: current.shipments[shipment_id] ?? null }));
  const before = new Set(previous.issue_ids), after = new Set(current.issue_ids);
  return {
    previous: { id: previous.id, at: previous.at, trigger: previous.trigger },
    changed: previous.fingerprint !== current.fingerprint,
    totals, shipments,
    issues_opened: current.issue_ids.filter(id => !before.has(id)),
    issues_closed: previous.issue_ids.filter(id => !after.has(id)),
    records_added: current.record_count - previous.record_count,
    corrections_added: current.correction_count - previous.correction_count,
  };
}

/** Whether evidence changed after the most recent investigation run. */
export function staleness(c: RecallCase, r: Reconciliation): { stale: boolean; last: EvidenceSnapshot | null } {
  const last = c.snapshots?.at(-1) ?? null;
  return { stale: !!last && last.fingerprint !== evidenceFingerprint(c, r), last };
}
