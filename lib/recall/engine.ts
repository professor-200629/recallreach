import type { LedgerRecord, RecallAlert, RecallCase, Reconciliation, RecordStatus, ShipmentBalance, StockState } from './types.ts';

export const RULES_VERSION = '2';
const states: StockState[] = ['available', 'quarantined', 'returned', 'dispensed'];
// Whole-number quantities above this are treated as data-entry errors for this release.
export const MAX_QUANTITY = 1_000_000;
// ISO 8601 with an explicit timezone. Timestamps without one are ambiguous across sites.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const UNCONFIRMED_LOCATION = /\b(pending|unknown|unconfirmed|tbc|tbd|to be confirmed)\b/i;
const norm = (s: string) => String(s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
const identity = (r: Pick<LedgerRecord, 'product' | 'manufacturer' | 'batch'>) => [norm(r.manufacturer), norm(r.product), norm(r.batch)].join('|');
const fingerprint = (r: LedgerRecord) => JSON.stringify([r.event_id,r.shipment_id,r.type,r.from_state,r.to_state,identity(r),r.quantity,norm(r.unit),norm(r.location),r.reference,r.occurred_at]);
// Typical transcription slips: punctuation or spacing, O/0 and I/L/1 confusion, or one trailing suffix letter.
const batchKey = (s: string) => norm(s).replace(/[^a-z0-9]/g, '').replace(/o/g, '0').replace(/[il]/g, '1');
export function nearMissBatch(candidate: string, batch: string): boolean {
  const a = batchKey(candidate), b = batchKey(batch);
  if (!a || !b || norm(candidate) === norm(batch)) return false;
  return a === b || (a.length === b.length + 1 && a.startsWith(b) && /[a-z]$/.test(a)) || (b.length === a.length + 1 && b.startsWith(a) && /[a-z]$/.test(b));
}

export type ReconcileOptions = {
  /** Record IDs that an operator correction superseded or withdrew, with the reason. */
  superseded?: Record<string, string>;
  /** Clock used for the future-timestamp check. Defaults to Date.now(). */
  now?: number;
};

export function reconcile(alert: RecallAlert, records: LedgerRecord[], opts: ReconcileOptions = {}): Reconciliation {
  const now = opts.now ?? Date.now(), superseded = opts.superseded ?? {};
  const out: Reconciliation = { shipped:0, available:0, quarantined:0, returned:0, dispensed:0, contained:0, coverage:0, shipments:[], issues:[], applied_ids:[], excluded_ids:[], duplicate_ids:[], review_ids:[], superseded_ids:[], record_status:{} };
  const lists: Record<RecordStatus, string[]> = { applied: out.applied_ids, excluded: out.excluded_ids, duplicate: out.duplicate_ids, review: out.review_ids, superseded: out.superseded_ids };
  const mark = (r: LedgerRecord, status: RecordStatus, reason: string) => { out.record_status[r.id]={status,reason}; lists[status].push(r.id); };
  const review = (r: LedgerRecord, reason: string) => {
    mark(r,'review',reason);
    out.issues.push({id:`review:${r.id}`,severity:'high',kind:'Record review',title:`Review ${r.reference||r.event_id||'unidentified record'}`,explanation:reason,next_step:'Check the original with its record owner. Keep the uncertainty visible; do not assume a match or stock movement.',evidence_ids:[r.id],shipment_id:r.shipment_id||undefined});
  };
  const groups=new Map<string,LedgerRecord[]>(), valid: LedgerRecord[]=[];
  for(const r of records) {
    if(superseded[r.id]) {mark(r,'superseded',superseded[r.id]);continue;}
    if(!r.event_id||!r.shipment_id) {review(r,'Event ID or shipment ID is missing. This record cannot be linked safely.');continue;}
    if(!r.product||!r.manufacturer||!r.batch) {review(r,'Product, manufacturer or batch is missing. An affected-batch match cannot be established.');continue;}
    if(identity(r)!==identity(alert)) {
      const candidate=norm(r.manufacturer)===norm(alert.manufacturer)&&norm(r.product)===norm(alert.product)&&nearMissBatch(r.batch,alert.batch);
      mark(r,'excluded',candidate?`Batch “${r.batch}” is close to “${alert.batch}” but not identical. It is not counted; a person must confirm whether it is the recalled batch.`:'Does not exactly match this alert’s manufacturer, product and batch. This is not a safety assessment.');
      if(candidate)out.issues.push({id:`candidate:${r.id}`,severity:'medium',kind:'Possible batch match',title:`Verify batch “${r.batch}” on ${r.reference||r.event_id}`,explanation:`This record names batch “${r.batch}”, which differs from the recalled batch “${alert.batch}” only by punctuation, a look-alike character or a suffix letter. RecallReach does not treat similar batch numbers as the same batch.`,next_step:'Ask the record owner to read the batch number from the physical pack. Import a corrected record if it is the recalled batch.',evidence_ids:[r.id],shipment_id:r.shipment_id||undefined});
      continue;
    }
    if(!Number.isSafeInteger(r.quantity)||r.quantity<=0) {review(r,`Quantity${r.raw_quantity!==undefined?` “${r.raw_quantity}”`:''} must be a positive whole number in the case unit.`);continue;}
    if(r.quantity>MAX_QUANTITY) {review(r,`Quantity ${r.quantity} exceeds the ${MAX_QUANTITY.toLocaleString('en-US')} plausibility limit. Confirm it with the record owner.`);continue;}
    if(norm(r.unit)!==norm(alert.unit)) {review(r,`Unit “${r.unit}” differs from case unit “${alert.unit}”. No conversion has been assumed.`);continue;}
    if(!r.reference||!r.location) {review(r,'Source reference and location are required.');continue;}
    if(!ISO_WITH_ZONE.test(r.occurred_at)||!Number.isFinite(Date.parse(r.occurred_at))) {review(r,`Timestamp “${r.occurred_at||'missing'}” is not a valid ISO 8601 time with a timezone.`);continue;}
    if(Date.parse(r.occurred_at)>now+300000) {review(r,'This record is dated in the future. Its stock effect has not been applied.');continue;}
    const group=groups.get(r.event_id)??[];group.push(r);groups.set(r.event_id,group);
  }
  for(const group of groups.values()) {
    if(new Set(group.map(fingerprint)).size>1) {for(const r of group)review(r,`Event ${r.event_id} has conflicting versions. None of those versions has been applied.`);continue;}
    valid.push(group[0]);
    for(const r of group.slice(1))mark(r,'duplicate',`Identical event ${r.event_id} already appears in the evidence. Counted once.`);
  }
  const balances=new Map<string,ShipmentBalance>(), seenReferences=new Set<string>();
  valid.sort((a,b)=>Date.parse(a.occurred_at)-Date.parse(b.occurred_at)||(a.type===b.type?a.event_id.localeCompare(b.event_id):a.type==='shipment'?-1:1));
  for(const r of valid) {
    const key=[r.shipment_id,r.type,norm(r.reference),r.from_state,r.to_state].join('|');
    if(seenReferences.has(key)){review(r,`Reference ${r.reference} was already used for this shipment and movement. A second event ID is not evidence of a second stock movement.`);continue;}
    if(r.type==='shipment') {
      if(balances.has(r.shipment_id)){review(r,`Shipment ${r.shipment_id} already has an opening record. Its quantity has not been added twice.`);continue;}
      if(r.from_state||r.to_state!=='available'){review(r,'An opening shipment must enter available with no previous state.');continue;}
      balances.set(r.shipment_id,{shipment_id:r.shipment_id,location:r.location,quantity:r.quantity,available:r.quantity,quarantined:0,returned:0,dispensed:0,evidence_ids:[r.id]});
    } else if(r.type==='movement') {
      const b=balances.get(r.shipment_id);
      if(!b){review(r,`No earlier accepted opening record exists for shipment ${r.shipment_id}.`);continue;}
      if(!states.includes(r.from_state as StockState)||!states.includes(r.to_state as StockState)||r.from_state===r.to_state){review(r,'Movement must name two different supported stock states.');continue;}
      if(r.from_state==='returned'||r.from_state==='dispensed'||r.to_state==='available'){review(r,'Releasing held stock or reversing a return/dispensing record requires a separately reviewed correction. It is not an ordinary movement.');continue;}
      if(norm(r.location)!==norm(b.location)){review(r,'Movement location differs from its shipment location. No location mapping has been assumed.');continue;}
      if(b[r.from_state as StockState]<r.quantity){review(r,`Movement requests ${r.quantity} ${alert.unit}, but only ${b[r.from_state as StockState]} are recorded in ${r.from_state}.`);continue;}
      b[r.from_state as StockState]-=r.quantity;b[r.to_state as StockState]+=r.quantity;b.evidence_ids.push(r.id);
    } else {review(r,'Unsupported event type. Use shipment or movement.');continue;}
    seenReferences.add(key);mark(r,'applied','Accepted by identity, unit, chronology and quantity checks. Physical handling is reported by the source.');
  }
  out.shipments=[...balances.values()];
  for(const b of out.shipments){
    out.shipped+=b.quantity;for(const s of states)out[s]+=b[s];
    if(b.available>0)out.issues.push({id:`stock:${b.shipment_id}`,severity:'high',kind:'Stock follow-up',title:`Locate and check ${b.available} ${alert.unit}`,explanation:`${b.location}: shipment ${b.shipment_id} has ${b.available} ${alert.unit} without an accepted quarantine, return or dispensing record.`,next_step:'Ask the responsible pharmacy or distributor to check this shipment. Add their evidence before changing its stock status.',evidence_ids:b.evidence_ids,quantity:b.available,shipment_id:b.shipment_id});
    if(UNCONFIRMED_LOCATION.test(b.location))out.issues.push({id:`destination:${b.shipment_id}`,severity:'medium',kind:'Destination unconfirmed',title:`Confirm where shipment ${b.shipment_id} went`,explanation:`The opening record names “${b.location}” as the destination. Movements reported for this shipment do not establish who holds the stock.`,next_step:'Ask the distributor for the delivery record or proof of receipt. Keep this open until a named, responsible recipient is evidenced.',evidence_ids:b.evidence_ids,quantity:b.quantity,shipment_id:b.shipment_id});
    if(b.dispensed>0)out.issues.push({id:`dispensed:${b.shipment_id}`,severity:'high',kind:'Pharmacist follow-up',title:`${b.dispensed} ${alert.unit} recorded as dispensed`,explanation:`${b.location} reported dispensing this quantity. Records do not establish who consumed it or whether anyone was harmed.`,next_step:'Assign an authorized pharmacist to review dispensing records and applicable recall instructions. Keep patient information outside this workspace.',evidence_ids:b.evidence_ids,quantity:b.dispensed,shipment_id:b.shipment_id});
  }
  if(out.duplicate_ids.length)out.issues.push({id:'duplicates',severity:'info',kind:'Duplicate evidence',title:`${out.duplicate_ids.length} duplicate record${out.duplicate_ids.length===1?'':'s'} counted once`,explanation:'Identical event IDs and contents were detected. Duplicate copies do not increase stock quantities.',next_step:'Retain the copies in the evidence history. No additional stock movement is needed.',evidence_ids:out.duplicate_ids});
  if(out.excluded_ids.length)out.issues.push({id:'excluded',severity:'info',kind:'Outside this alert',title:`${out.excluded_ids.length} record${out.excluded_ids.length===1?'':'s'} outside this recall scope`,explanation:'These records name a different manufacturer, product or batch. They are excluded from totals; that is not a safety clearance for that stock.',next_step:'No action for this case. Check them against any separate alert that covers their batch.',evidence_ids:out.excluded_ids});
  out.contained=out.quarantined+out.returned;out.coverage=out.shipped?Math.round(out.contained/out.shipped*100):0;
  return out;
}

/** Maps operator corrections to the original records they replace or withdraw. */
export function supersededMap(c: Pick<RecallCase, 'corrections'>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const k of c.corrections ?? []) map[k.original_id] = k.kind === 'withdraw'
    ? `Withdrawn by ${k.actor} on ${k.at.slice(0, 10)}: ${k.reason}`
    : `Superseded by correction ${k.replacement_id} (${k.actor}, ${k.at.slice(0, 10)}): ${k.reason}`;
  return map;
}

export function reconcileCase(c: Pick<RecallCase, 'alert' | 'records' | 'corrections'>, now?: number): Reconciliation {
  return reconcile(c.alert, c.records, { superseded: supersededMap(c), now });
}
