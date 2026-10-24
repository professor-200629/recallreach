import type { LedgerRecord } from './types.ts';
export const CSV_COLUMNS=['event_id','shipment_id','type','from_state','to_state','product','manufacturer','batch','quantity','unit','location','reference','occurred_at'];
export function parseCsvRows(input:string):string[][] {
  const text=input.replace(/^\uFEFF/,'');const rows:string[][]=[];let row:string[]=[],value='',quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"') {if(quoted&&text[i+1]==='"'){value+='"';i++;}else if(!quoted&&value!=='')throw new Error('Unexpected quote in CSV field.');else quoted=!quoted;}
    else if(c===','&&!quoted){row.push(value);value='';}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(s=>s.trim()))rows.push(row);row=[];value='';}
    else value+=c;
  }
  if(quoted)throw new Error('CSV has an unclosed quoted field.');row.push(value);if(row.some(s=>s.trim()))rows.push(row);return rows;
}
export function parseLedgerCsv(content:string,sourceId:string):LedgerRecord[]{
  if(content.length>800000)throw new Error('Use a CSV smaller than 800 KB.');
  const rows=parseCsvRows(content);if(rows.length<2)throw new Error('CSV needs a header and at least one record.');
  const header=rows[0].map(s=>s.trim().toLowerCase());const missing=CSV_COLUMNS.filter(c=>!header.includes(c));
  if(missing.length)throw new Error(`Missing columns: ${missing.join(', ')}.`);
  if(new Set(header).size!==header.length)throw new Error('CSV has duplicate column names.');
  if(rows.length>2001)throw new Error('Import no more than 2,000 records at once.');
  return rows.slice(1).map((row,index)=>{
    if(row.length!==header.length)throw new Error(`Row ${index+2} has ${row.length} fields; expected ${header.length}.`);
    const d=Object.fromEntries(header.map((key,i)=>[key,row[i].trim()]));
    for(const [key,value]of Object.entries(d))if(value.length>500)throw new Error(`Row ${index+2}: ${key} is too long.`);
    return {id:`${sourceId}:${index+2}`,event_id:d.event_id,shipment_id:d.shipment_id,type:d.type as LedgerRecord['type'],from_state:d.from_state,to_state:d.to_state,product:d.product,manufacturer:d.manufacturer,batch:d.batch,quantity:d.quantity&&/^\d+$/.test(d.quantity)?Number(d.quantity):0,unit:d.unit,location:d.location,reference:d.reference,occurred_at:d.occurred_at,source_id:sourceId,source_row:index+2};
  });
}
export function toCsv(rows:Record<string,unknown>[],columns:string[]):string{
  const field=(v:unknown)=>{let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return /[",\n\r]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};
  return [columns.join(','),...rows.map(r=>columns.map(c=>field(r[c])).join(','))].join('\r\n');
}
