import type { RecallCase } from './types.ts';
import { parseLedgerCsv,CSV_COLUMNS } from './csv.ts';
const product='Nivara oral solution',manufacturer='Example Pharma (fictional)',batch='DEMO-042';
const rows=[
 ['S-A','RR-101','shipment','','available',product,manufacturer,batch,500,'bottles','Harbor Pharmacy','INV-101','2026-10-01T09:00:00Z'],
 ['S-B','RR-102','shipment','','available',product,manufacturer,batch,300,'bottles','Cedar Pharmacy','INV-102','2026-10-01T09:10:00Z'],
 ['S-C','RR-103','shipment','','available',product,manufacturer,batch,160,'bottles','Meadow Pharmacy','INV-103','2026-10-01T09:20:00Z'],
 ['S-D','RR-104','shipment','','available',product,manufacturer,batch,40,'bottles','Destination pending confirmation','DISPATCH-104','2026-10-01T09:30:00Z'],
 ['Q-A','RR-101','movement','available','quarantined',product,manufacturer,batch,500,'bottles','Harbor Pharmacy','HOLD-101','2026-10-02T10:00:00Z'],
 ['R-A','RR-101','movement','quarantined','returned',product,manufacturer,batch,100,'bottles','Harbor Pharmacy','RETURN-101','2026-10-03T10:00:00Z'],
 ['Q-B','RR-102','movement','available','quarantined',product,manufacturer,batch,300,'bottles','Cedar Pharmacy','HOLD-102','2026-10-02T10:10:00Z'],
 ['Q-C','RR-103','movement','available','quarantined',product,manufacturer,batch,100,'bottles','Meadow Pharmacy','HOLD-103','2026-10-02T10:20:00Z'],
 ['D-C','RR-103','movement','available','dispensed',product,manufacturer,batch,60,'bottles','Meadow Pharmacy','SALE-103','2026-10-02T10:25:00Z'],
 ['R-A','RR-101','movement','quarantined','returned',product,manufacturer,batch,100,'bottles','Harbor Pharmacy','RETURN-101','2026-10-03T10:00:00Z'],
 ['S-X','RR-105','shipment','','available',product,manufacturer,'DEMO-043',50,'bottles','Harbor Pharmacy','INV-105','2026-10-01T09:40:00Z'],
];
export const SAMPLE_CSV=[CSV_COLUMNS.join(','),...rows.map(r=>r.join(','))].join('\n');
export const FOLLOWUP_CSV=[CSV_COLUMNS.join(','),['Q-D','RR-104','movement','available','quarantined',product,manufacturer,batch,40,'bottles','Destination pending confirmation','DRILL-HOLD-104','2026-10-04T12:00:00Z'].join(',')].join('\n');
export function createSample(id:string,now:string):RecallCase{
  const sourceId='sample-ledger';
  return{id,name:'The missing 40 bottles',mode:'drill',created_at:now,version:1,
    alert:{product,manufacturer,batch,unit:'bottles',source_url:'',description:'Fictional training incident. Trace 1,000 bottles through distributor and pharmacy records. Identify missing stock, duplicate evidence and dispensing follow-up. No actual product, manufacturer or pharmacy is implicated.'},
    sources:[{id:sourceId,name:'Training distribution ledger.csv',kind:'sample',content:SAMPLE_CSV,added_at:now,row_count:rows.length}],
    records:parseLedgerCsv(SAMPLE_CSV,sourceId),audit:[],decisions:[],investigated_at:null};
}
