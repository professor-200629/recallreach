import type { LedgerRecord, RecallAlert, Reconciliation, ShipmentBalance, StockState } from './types.ts';

const states: StockState[] = ['available', 'quarantined', 'returned', 'dispensed'];
const norm = (s: string) => String(s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
const identity = (r: Pick<LedgerRecord, 'product' | 'manufacturer' | 'batch'>) => [norm(r.manufacturer), norm(r.product), norm(r.batch)].join('|');
const fingerprint = (r: LedgerRecord) => JSON.stringify([r.event_id,r.shipment_id,r.type,r.from_state,r.to_state,identity(r),r.quantity,norm(r.unit),norm(r.location),r.reference,r.occurred_at]);

export function reconcile(alert: RecallAlert, records: LedgerRecord[]): Reconciliation {
  const out: Reconciliation = { shipped:0, available:0, quarantined:0, returned:0, dispensed:0, contained:0, coverage:0, shipments:[], issues:[], applied_ids:[], excluded_ids:[], duplicate_ids:[], review_ids:[], record_status:{} };
  const mark = (r: LedgerRecord, status: 'applied'|'excluded'|'duplicate'|'review', reason: string) => {
    out.record_status[r.id]={status,reason};
    out[status==='applied'?'applied_ids':status==='excluded'?'excluded_ids':status==='duplicate'?'duplicate_ids':'review_ids'].push(r.id);
  };
  const review = (r: LedgerRecord, reason: string) => {
    mark(r,'review',reason);
    out.issues.push({id:`review:${r.id}`,severity:'high',kind:'Record review',title:`Review ${r.reference||r.event_id||'unidentified record'}`,explanation:reason,next_step:'Check the original with its record owner. Keep the uncertainty visible; do not assume a match or stock movement.',evidence_ids:[r.id]});
  };
  const groups=new Map<string,LedgerRecord[]>(), valid: LedgerRecord[]=[];
  for(const r of records) {
    if(!r.event_id||!r.shipment_id) {review(r,'Event ID or shipment ID is missing. This record cannot be linked safely.');continue;}
    if(!r.product||!r.manufacturer||!r.batch) {review(r,'Product, manufacturer or batch is missing. An affected-batch match cannot be established.');continue;}
    if(identity(r)!==identity(alert)) {mark(r,'excluded','Does not exactly match this alert’s manufacturer, product and batch. This is not a safety assessment.');continue;}
    if(!Number.isSafeInteger(r.quantity)||r.quantity<=0) {review(r,'Quantity must be a positive whole number in the case unit.');continue;}
    if(norm(r.unit)!==norm(alert.unit)) {review(r,`Unit “${r.unit}” differs from case unit “${alert.unit}”. No conversion has been assumed.`);continue;}
    if(!r.reference||!r.location||!Number.isFinite(Date.parse(r.occurred_at))) {review(r,'Source reference, location and a valid event timestamp are required.');continue;}
    if(Date.parse(r.occurred_at)>Date.now()+300000) {review(r,'This record is dated in the future. Its stock effect has not been applied.');continue;}
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
    if(b.dispensed>0)out.issues.push({id:`dispensed:${b.shipment_id}`,severity:'high',kind:'Pharmacist follow-up',title:`${b.dispensed} ${alert.unit} recorded as dispensed`,explanation:`${b.location} reported dispensing this quantity. Records do not establish who consumed it or whether anyone was harmed.`,next_step:'Assign an authorized pharmacist to review dispensing records and applicable recall instructions. Keep patient information outside this workspace.',evidence_ids:b.evidence_ids,quantity:b.dispensed,shipment_id:b.shipment_id});
  }
  if(out.duplicate_ids.length)out.issues.push({id:'duplicates',severity:'info',kind:'Duplicate evidence',title:`${out.duplicate_ids.length} duplicate record${out.duplicate_ids.length===1?'':'s'} counted once`,explanation:'Identical event IDs and contents were detected. Duplicate copies do not increase stock quantities.',next_step:'Retain the copies in the evidence history. No additional stock movement is needed.',evidence_ids:out.duplicate_ids});
  out.contained=out.quarantined+out.returned;out.coverage=out.shipped?Math.round(out.contained/out.shipped*100):0;
  return out;
}
