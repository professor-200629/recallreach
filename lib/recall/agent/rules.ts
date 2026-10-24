import type { OwnerRole } from '../types.ts';
import type { FinalArgs, ToolContext } from './tools.ts';

// Rules mode: a fixed, deterministic procedure. It picks tools from the question and
// from earlier tool results, using the same executor and verifier as the live agent.
// It is not a language model and makes no claim to open-ended reasoning.
type Rec = { cite: string; event_id: string | null; shipment_id: string | null; movement: string; quantity: number | string; unit: string; location: string; reference: string; occurred_at: string; status: string; status_reason: string; source: string; untrusted_text_flags?: Record<string, string[]> };
type Shipment = { shipment_id: string; location: string; opening: number; available: number; quarantined: number; returned: number; dispensed: number };
type Issue = { issue_id: string; kind: string; shipment_id: string | null; quantity: number | null; evidence: string[] };
type Call = (name: string, args: Record<string, unknown>) => Promise<string>;

const data = <T>(text: string): T | null => { try { const v = JSON.parse(text); return v.ok ? v.data as T : null; } catch { return null; } };

export async function rulesInvestigation(question: string, ctx: ToolContext, call: Call): Promise<FinalArgs> {
  const unit = ctx.c.alert.unit, q = question.toLowerCase();
  await call('get_recall_scope', { purpose: 'Confirm the exact recall scope before reading evidence.' });
  const recon = data<{ shipments: Shipment[]; open_issues: Issue[]; totals: Record<string, number> }>(await call('run_reconciliation', { purpose: 'Get source-reported balances and open issues from the deterministic engine.' }));
  if (!recon) return { summary: 'The reconciliation could not be run, so no findings can be made.', findings: [], missing_evidence: [] };

  const mentioned = recon.shipments.filter(s => q.includes(s.shipment_id.toLowerCase()));
  const numbers = [...q.matchAll(/\b\d[\d,]*\b/g)].map(m => Number(m[0].replaceAll(',', '')));
  const byQuantity = recon.shipments.filter(s => s.available > 0 && numbers.includes(s.available));
  const wantsOpen = /dispens|open|outstanding|still|remain|follow|changed|else/.test(q);
  let targets = mentioned.length ? mentioned : byQuantity.length ? byQuantity : recon.shipments.filter(s => s.available > 0);
  // Shipments with other open issues (dispensing, unconfirmed destination) are added when asked about, or when no stock gap remains.
  const otherOpen = recon.shipments.filter(s => !targets.includes(s) && recon.open_issues.some(i => i.shipment_id === s.shipment_id && (i.kind === 'Pharmacist follow-up' || i.kind === 'Destination unconfirmed')));
  if (wantsOpen || !targets.length) targets = [...targets, ...otherOpen];
  targets = targets.sort((a, b) => b.available - a.available || b.dispensed - a.dispensed).slice(0, 4);

  const findings: FinalArgs['findings'] = [], missing: FinalArgs['missing_evidence'] = [], flagged = new Map<string, Rec>();
  const noteFlags = (rows: Rec[]) => { for (const r of rows) if (r.untrusted_text_flags && Object.keys(r.untrusted_text_flags).length) flagged.set(r.cite, r); };

  const reviews = data<{ records: Rec[] }>(await call('search_records', { purpose: 'List records the engine held for review; one may explain a gap.', status: 'review', limit: 20 }))?.records ?? [];
  noteFlags(reviews);

  for (const s of targets) {
    const ledger = data<{ records: Rec[]; open_issues: Issue[] }>(await call('get_shipment_ledger', { purpose: `Read every record for ${s.shipment_id} in time order.`, shipment_id: s.shipment_id }));
    if (!ledger) continue;
    noteFlags(ledger.records);
    const opening = ledger.records.find(r => r.movement.startsWith('opening') && r.status === 'applied');
    const issues = new Map(ledger.open_issues.map(i => [i.kind, i]));
    const stock = issues.get('Stock follow-up'), destination = issues.get('Destination unconfirmed'), dispensed = issues.get('Pharmacist follow-up');
    if (opening) await call('get_source_row', { purpose: `Check the original dispatch row behind ${s.shipment_id}.`, cite: opening.cite });
    if (opening) {
      const ref = data<{ records: Rec[]; distinct_event_ids: number }>(await call('find_reference', { purpose: `Check whether dispatch reference ${opening.reference} is reused elsewhere.`, reference: opening.reference }));
      if (ref && ref.distinct_event_ids > 1) findings.push({ claim: `Reference ${opening.reference} appears on ${ref.records.length} records with different event IDs; only one can describe the dispatch.`, citations: ref.records.map(r => r.cite).slice(0, 6), basis: 'source_reported' });
    }
    const external: Rec[] = [];
    if (ctx.external && stock) for (const source of ['pharmacy_stock_events', 'return_records']) {
      const res = data<{ rows: (Rec & { already_in_case: boolean })[]; mode: string }>(await call('query_connected_source', { purpose: `Look for ${source.replace(/_/g, ' ')} about ${s.shipment_id} that are not yet imported.`, source, shipment_id: s.shipment_id }));
      if (res) external.push(...res.rows.filter(r => !r.already_in_case));
    }
    const near = reviews.filter(r => r.shipment_id === s.shipment_id || (stock && Number(r.quantity) === s.available) || (r.location && r.location === s.location));

    if (stock) {
      findings.push({ claim: `Shipment ${s.shipment_id} (${s.location}) has ${s.available} ${unit} with no accepted quarantine, return or dispensing record, out of ${s.opening} ${unit} accepted for it.`, citations: [stock.issue_id, ...(opening ? [opening.cite] : [])], basis: 'engine_calculated' });
      for (const r of near.slice(0, 3)) findings.push({ claim: `${r.cite} (${r.event_id ?? 'no event ID'}, ${r.reference || 'no reference'}, ${r.quantity} ${r.unit}) was not applied to the balance: ${r.status_reason}`, citations: [r.cite], basis: 'source_reported' });
      if (!near.length) findings.push({ claim: `None of the ${reviews.length} records held for review names ${s.shipment_id}, its location or a matching quantity, so no rejected record explains this gap.`, citations: [stock.issue_id, ...reviews.slice(0, 3).map(r => r.cite)], basis: 'engine_calculated' });
      if (external.length) findings.push({ claim: `The connected source returned ${external.length} rows about ${s.shipment_id} that are not in the case evidence yet. They have no effect until an operator imports them.`, citations: external.slice(0, 5).map(r => r.cite), basis: 'source_reported' });
      missing.push({ description: `No dated containment, return or dispensing record covers ${s.available} ${unit} of ${s.shipment_id}.`, would_resolve: `A record from ${destination ? 'the distributor or the actual recipient' : s.location} for ${s.shipment_id}, same batch, in ${unit}, showing the current status of the ${s.available} ${unit}.`, citations: [stock.issue_id, ...(opening ? [opening.cite] : [])] });
      const timestampFix = near.find(r => /timestamp|timezone/i.test(r.status_reason));
      await propose(call, stock.issue_id, timestampFix
        ? { action: `Ask ${s.location} to reissue ${timestampFix.reference} with a full date, time and timezone; it was rejected for an ambiguous timestamp.`, owner_role: 'pharmacy_staff', evidence_requested: `Corrected record ${timestampFix.reference} for ${s.shipment_id} with an ISO timestamp including timezone.`, citations: [timestampFix.cite, ...(opening ? [opening.cite] : [])] }
        : destination
          ? { action: `Ask the distributor for proof of delivery for ${s.shipment_id} (${opening?.reference ?? 'dispatch record'}) and the name of the responsible recipient.`, owner_role: 'distributor', evidence_requested: `Proof of delivery and a status report for ${s.available} ${unit} from the named recipient.`, citations: opening ? [opening.cite] : [] }
          : { action: `Ask ${s.location} to locate shipment ${s.shipment_id} and report the status of ${s.available} ${unit}.`, owner_role: 'pharmacy_staff', evidence_requested: `A dated quarantine, return or dispensing record for ${s.available} ${unit} of ${s.shipment_id}.`, citations: opening ? [opening.cite] : [] });
    }
    if (destination) findings.push({ claim: `The opening record names "${s.location}" as the destination; no record identifies who holds shipment ${s.shipment_id}.`, citations: [destination.issue_id, ...(opening ? [opening.cite] : [])], basis: 'source_reported' });
    if (dispensed) {
      findings.push({ claim: `${s.location} reported ${s.dispensed} ${unit} of ${s.shipment_id} as dispensed. Records do not show who received them or any outcome.`, citations: [dispensed.issue_id], basis: 'source_reported' });
      await propose(call, dispensed.issue_id, { action: `Assign a supervising pharmacist to review dispensing records for ${s.shipment_id} against the recall instructions, outside this workspace.`, owner_role: 'supervising_pharmacist', evidence_requested: 'A note that the dispensing review was done and what instructions were followed, with no patient details.', citations: dispensed.evidence });
    }
  }

  for (const r of [...flagged.values()].slice(0, 2)) findings.push({ claim: `${r.cite} contains instruction-like text (${Object.entries(r.untrusted_text_flags!).map(([f, l]) => `${f}: ${l.join(', ')}`).join('; ')}). It was treated as data and did not change any result.`, citations: [r.cite], basis: 'source_reported' });
  for (const i of recon.open_issues.filter(i => i.kind === 'Possible batch match').slice(0, 2)) findings.push({ claim: `A record names a batch that is similar to, but not the same as, the recalled batch (${i.shipment_id ?? 'no shipment ID'}). It is not counted; a person must read the batch from the pack.`, citations: [i.issue_id, ...i.evidence.slice(0, 1)], basis: 'source_reported' });

  if (ctx.memory) {
    const mem = data<{ memories: { memory_id: string; content: string; kind: string; validity: string; cites: string[] }[] }>(await call('recall_memory', { purpose: 'Check earlier notes on this case and whether they still hold.', query: question }));
    for (const m of (mem?.memories ?? []).filter(m => m.validity !== 'current' || m.kind === 'recheck').slice(0, 2)) {
      const cites = m.cites.filter(c => /^E\d+$/.test(c));
      findings.push({ claim: m.kind === 'recheck' ? `Memory ${m.memory_id} records that an earlier conclusion needs rechecking because its evidence changed; it was not reused as a conclusion.` : `Earlier note ${m.memory_id} is ${m.validity}: the evidence it relied on has changed, so it was not reused as a conclusion.`, citations: cites.slice(0, 4), basis: cites.length ? 'source_reported' : 'unverified' });
    }
  }
  const diff = data<{ previous: { at: string } | null; changed: boolean; totals: { field: string; before: number; after: number }[]; issues_closed: string[]; issues_opened: string[] }>(await call('compare_with_previous_run', { purpose: 'Check what changed since the previous investigation run.' }));
  if (diff?.previous && diff.changed && diff.totals.length) {
    const cites = [...diff.issues_closed, ...diff.issues_opened].slice(0, 4);
    findings.push({ claim: `Since the run at ${diff.previous.at}: ${diff.totals.map(t => `${t.field.replace(/_/g, ' ')} ${t.before} → ${t.after} ${unit}`).join(', ')}.`, citations: cites.length ? cites : targets.map(s => `stock:${s.shipment_id}`), basis: 'engine_calculated' });
  }

  const gap = targets.filter(s => s.available > 0), kept = findings.slice(0, 12);
  const summary = gap.length
    ? `${gap.reduce((n, s) => n + s.available, 0)} ${unit} across ${gap.length} shipment${gap.length === 1 ? '' : 's'} (${gap.map(s => s.shipment_id).join(', ')}) lack an accepted containment or dispensing record. ${kept.length} cited findings and ${ctx.proposals.length} proposed follow-ups await human review.`
    : `No shipment in scope has ${unit} awaiting containment in the accepted records. Dispensed stock and unconfirmed destinations still need human follow-up; this does not establish that the recall is complete.`;
  return { summary, findings: kept, missing_evidence: missing.slice(0, 6) };
}

async function propose(call: Call, issue_id: string, p: { action: string; owner_role: OwnerRole; evidence_requested: string; citations: string[] }) {
  await call('propose_follow_up', { purpose: 'Propose a next step for human approval.', issue_id, ...p, citations: p.citations.slice(0, 10) });
}
