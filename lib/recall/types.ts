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
  /** Original quantity text when it could not be read as a whole number. */
  raw_quantity?: string;
};
export type RecallAlert = { product: string; manufacturer: string; batch: string; unit: string; source_url: string; description: string };
export type SourceKind = 'csv' | 'manual' | 'sample' | 'correction' | 'zetaris' | 'zetaris-mock';
/** Where an external source came from. Only set for records fetched through an integration. */
export type SourceOrigin = { system: 'zetaris'; mode: 'live' | 'mock'; table: string; query_id: string; fetched_at: string; latency_ms: number; sql: string;
  /** Which source instance the rows came from (e.g. a Zetaris host and organisation). Absent on sources imported before instances were recorded. */
  instance?: string;
  /** The source system's row key for each imported row, in row order. */
  row_keys?: string[];
  /** A hash of each imported row's content, in row order, so a changed row is recognised as a new version. */
  row_hashes?: string[];
  /** How the rows were read: pages, total reported by a count query, and any limitation. */
  coverage?: { pages: number; rows: number; source_count: number | null; note: string } };
export type Source = { id: string; name: string; kind: SourceKind; content: string; added_at: string; row_count: number; origin?: SourceOrigin };
export type AuditEntry = { id: string; at: string; actor: string; action: string; detail: string; previous_hash: string; hash: string };
export type Decision = { id: string; issue_id: string; at: string; actor: string; status: 'approved' | 'acknowledged' | 'rejected'; note: string; evidence_ids: string[]; proposal_id?: string };
/** An operator correction. The original record is never edited; it is marked superseded or withdrawn. */
export type Correction = { id: string; at: string; actor: string; kind: 'supersede' | 'withdraw'; original_id: string; replacement_id: string | null; reason: string; evidence_reference: string };
export type OwnerRole = 'recall_coordinator' | 'pharmacy_staff' | 'supervising_pharmacist' | 'distributor';
/** A follow-up suggested by an investigation run. It has no effect until an operator decides on it. */
export type Proposal = { id: string; run_id: string; issue_id: string; created_at: string; action: string; owner_role: OwnerRole; evidence_requested: string; citations: string[]; status: 'proposed' | 'approved' | 'rejected'; decided_by?: string; decided_at?: string };
export type ShipmentSnapshot = { available: number; quarantined: number; returned: number; dispensed: number; fingerprint: string };
/** Evidence state at the moment an investigation ran, used to detect stale conclusions. */
export type EvidenceSnapshot = {
  id: string; at: string; actor: string; trigger: 'rules' | 'agent-live' | 'agent-rules'; run_id: string | null;
  fingerprint: string; record_count: number; correction_count: number;
  totals: { shipped: number; available: number; quarantined: number; returned: number; dispensed: number };
  shipments: Record<string, ShipmentSnapshot>; issue_ids: string[];
};
export type ToolActivity = {
  seq: number; tool: string; purpose: string; args: unknown; ok: boolean; error?: string;
  summary: string; record_ids: string[]; duration_ms: number;
};
/** Legacy (before typed facts): free-text claims whose "verified" label only meant their citations resolved. Kept so old runs still render. */
export type CitedClaim = { claim: string; citations: string[]; basis: 'source_reported' | 'engine_calculated' | 'unverified'; verification: 'verified' | 'unverified'; problems: string[] };
export type MissingEvidence = { description: string; would_resolve: string; citations: string[]; verification: 'verified' | 'unverified'; problems: string[] };
export type ProposedFollowUp = { issue_id: string; action: string; owner_role: OwnerRole; evidence_requested: string; citations: string[]; accepted: boolean; problems: string[] };

/** What a validated statement depends on, so memory and explanations can tell when it no longer holds. */
export type FactDependency =
  | { kind: 'case' }
  | { kind: 'shipment'; shipment_id: string }
  | { kind: 'record'; record_id: string }
  | { kind: 'external'; instance: string; table: string; row_key: string; content_hash: string; captured_at: string; query_scope: string };
export type FactType = 'shipment_balance' | 'case_total' | 'record_report' | 'record_status' | 'open_issue' | 'change_since_previous' | 'source_row_report';
/** One typed statement the agent submitted, checked field by field against the engine or the evidence delivered in that run. */
export type ValidatedFact = {
  type: FactType; status: 'validated' | 'rejected';
  /** The fields the agent asserted, exactly as submitted. */
  claimed: Record<string, unknown>;
  /** Wording generated by RecallReach from the validated fields; null when rejected. */
  statement: string | null;
  basis: 'engine_calculated' | 'source_reported';
  entity: { kind: 'shipment' | 'case' | 'record' | 'issue' | 'comparison' | 'external_row'; id: string };
  predicate: string; quantity: number | null; unit: string | null;
  /** Evidence scope the check used, e.g. engine:shipment:RR-104 or zetaris:<instance>:<table>:<row key>. */
  scope: string;
  /** Evidence fingerprint of the case at validation time. */
  snapshot: string;
  /** Record IDs, issue IDs or external identities whose content was delivered to the agent and checked. */
  evidence: string[];
  dependencies: FactDependency[];
  problems: string[];
  /** Optional free-text note from the agent. Shown as interpretation; never validated. */
  note?: string;
};
/** Free text from the agent. Always shown as unverified interpretation, with the retrieved evidence it points to. */
export type Interpretation = { text: string; related: string[]; problems: string[] };
/** Evidence the agent says could change the conclusion, linked to an open issue it retrieved. Not a guarantee. */
export type EvidenceRequest = { issue_id: string; description: string; would_change: string; linked: boolean; problems: string[] };
export type VerifiedAnswer = {
  /** 2 = typed facts; absent = legacy free-text claims. */
  version?: 2;
  /** The model's own summary. Interpretation, not validated. */
  summary: string; summary_problems: string[];
  /** Statements generated from validated facts only. This is the checked summary. */
  validated_summary?: string[];
  facts?: ValidatedFact[]; interpretations?: Interpretation[]; evidence_requests?: EvidenceRequest[];
  findings: CitedClaim[]; missing_evidence: MissingEvidence[];
  follow_ups: ProposedFollowUp[]; rejected_citations: string[];
};
export type AgentRun = {
  id: string; mode: 'live' | 'rules'; provider: string; model: string; question: string; actor: string;
  started_at: string; finished_at: string; duration_ms: number;
  status: 'completed' | 'failed' | 'limit_reached' | 'provider_error';
  status_detail: string; steps: ToolActivity[]; answer: VerifiedAnswer | null;
  usage: { model_calls: number; input_tokens: number; output_tokens: number; estimated_cost_usd: number | null };
  evidence_fingerprint: string; memory: { recalled: number; stored: number; invalidated: number };
};
/** The last time a connected-source row was seen, with a hash of its content. Keyed by instance|table|row key. */
export type SourceObservation = { hash: string; seen_at: string };
export type RecallCase = {
  id: string; name: string; mode: 'drill' | 'workspace'; created_at: string;
  alert: RecallAlert; records: LedgerRecord[]; sources: Source[]; audit: AuditEntry[];
  decisions: Decision[]; investigated_at: string | null; version: number;
  corrections: Correction[]; proposals: Proposal[]; snapshots: EvidenceSnapshot[]; agent_runs: AgentRun[];
  /** Rows seen at connected sources (imports and agent queries), so memory can tell whether captured evidence is still what the source holds. */
  source_observations?: Record<string, SourceObservation>;
  /** Complete reads of a source scope (instance|table|batch[|shipment]), so a row that stopped appearing can be noticed. */
  scope_observations?: Record<string, { observed_at: string; rows: number }>;
  /** Unique per save; the storage layer uses it to commit the case and its memory together. */
  save_token?: string;
};
export type Issue = { id: string; severity: 'high' | 'medium' | 'info'; kind: string; title: string; explanation: string; next_step: string; evidence_ids: string[]; quantity?: number; shipment_id?: string };
export type ShipmentBalance = { shipment_id: string; location: string; quantity: number; available: number; quarantined: number; returned: number; dispensed: number; evidence_ids: string[] };
export type RecordStatus = 'applied' | 'excluded' | 'duplicate' | 'review' | 'superseded';
export type Reconciliation = {
  shipped: number; available: number; quarantined: number; returned: number; dispensed: number;
  contained: number; coverage: number; shipments: ShipmentBalance[]; issues: Issue[];
  applied_ids: string[]; excluded_ids: string[]; duplicate_ids: string[]; review_ids: string[]; superseded_ids: string[];
  record_status: Record<string, { status: RecordStatus; reason: string }>;
};
