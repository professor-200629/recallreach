import type { LedgerRecord } from '../types.ts';

// Imported source fields are untrusted data. These patterns flag text that reads like
// an instruction to an AI system so the operator can see it; flagging does not make the
// text safe, and the agent has no tool that could act on it anyway.
const INSTRUCTION_PATTERNS: [RegExp, string][] = [
  [/\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(instruction|instructions|previous|prior|above|rules|guidance)\b/i, 'asks to ignore instructions'],
  [/\b(system|developer)\s*(note|prompt|message|instruction)\b/i, 'claims system authority'],
  [/\byou are (now )?(an?|the)\b|\bact as\b|\bpretend to\b/i, 'tries to assign a role'],
  [/\brecall (is |has been )?(complete|completed|closed|finished|resolved)\b/i, 'asserts recall completion'],
  [/\b(mark|report|state|treat)\b[^.]{0,30}\b(all|every)\b[^.]{0,30}\b(quarantined|contained|returned|safe|resolved)\b/i, 'asks to declare stock contained'],
  [/<\/?(tool|system|assistant|function)[^>]*>|\{\s*"(tool|name|arguments)"\s*:/i, 'contains tool-call markup'],
];

export function instructionFlags(text: string): string[] {
  return INSTRUCTION_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

const TEXT_FIELDS = ['event_id', 'shipment_id', 'reference', 'location', 'product', 'manufacturer', 'batch', 'unit', 'occurred_at'] as const;

/** Flags per field for one record, e.g. { reference: ['asks to ignore instructions'] }. */
export function recordFlags(r: Pick<LedgerRecord, typeof TEXT_FIELDS[number]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of TEXT_FIELDS) { const flags = instructionFlags(String(r[f] ?? '')); if (flags.length) out[f] = flags; }
  return out;
}
