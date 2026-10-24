export type StockState = 'available' | 'quarantined' | 'returned' | 'dispensed';
export type LedgerRecord = {
  id: string;
  event_id: string;
  shipment_id: string;
  type: 'shipment' | 'movement';
  from_state: string;
  to_state: string;
  product: string;
  manufacturer: string;
  batch: string;
  quantity: number;
  unit: string;
  location: string;
  reference: string;
  occurred_at: string;
  source_id: string;
  source_row: number;
};
export type RecallAlert = { product: string; manufacturer: string; batch: string; unit: string; source_url: string; description: string };
export type Source = { id: string; name: string; kind: 'csv' | 'manual' | 'sample'; content: string; added_at: string; row_count: number };
export type AuditEntry = { id: string; at: string; actor: string; action: string; detail: string; previous_hash: string; hash: string };
export type Decision = { id: string; issue_id: string; at: string; actor: string; status: 'approved' | 'acknowledged'; note: string; evidence_ids: string[] };
export type RecallCase = {
  id: string; name: string; mode: 'drill' | 'workspace'; created_at: string;
  alert: RecallAlert; records: LedgerRecord[]; sources: Source[]; audit: AuditEntry[];
  decisions: Decision[]; investigated_at: string | null; version: number;
};
export type Issue = { id: string; severity: 'high' | 'medium' | 'info'; kind: string; title: string; explanation: string; next_step: string; evidence_ids: string[]; quantity?: number; shipment_id?: string };
export type ShipmentBalance = { shipment_id: string; location: string; quantity: number; available: number; quarantined: number; returned: number; dispensed: number; evidence_ids: string[] };
export type Reconciliation = {
  shipped: number; available: number; quarantined: number; returned: number; dispensed: number;
  contained: number; coverage: number; shipments: ShipmentBalance[]; issues: Issue[];
  applied_ids: string[]; excluded_ids: string[]; duplicate_ids: string[]; review_ids: string[];
  record_status: Record<string, {status: 'applied' | 'excluded' | 'duplicate' | 'review'; reason: string}>;
};
