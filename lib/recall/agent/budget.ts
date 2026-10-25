import type { ChatMessage } from './provider.ts';

// Keeps each model request under a provider's per-request token ceiling. On Groq's free tier a
// request may not ask for more than 8,000 tokens per minute, and the request counts the prompt plus
// max_tokens; a larger one is refused outright (HTTP 413), however long the run waits.
//
// There is no tokenizer here, so tokens are estimated from characters and calibrated against the
// prompt tokens the provider reports. After each call, what the provider counted for the messages
// sent becomes the baseline. Text added since is counted at 3.6 characters per token, slightly
// pessimistic (this project's JSON tool results measure about 3.7–3.9 with gpt-oss's tokenizer), plus
// 8 tokens of framing per new message; text removed is credited at an optimistic 4.5, so the
// estimate errs high. A refusal that states what the provider counted recalibrates it. Before the first call (no baseline) everything,
// tool definitions included, is counted at 3.5 characters per token. Message text is measured as
// sent (content plus tool-call names and arguments), not as escaped JSON.
const ADD_CHARS_PER_TOKEN = 3.6, REMOVE_CHARS_PER_TOKEN = 4.5, FIRST_CHARS_PER_TOKEN = 3.5, MESSAGE_OVERHEAD = 8;
/** Share of the ceiling a request may use, leaving room for estimation error. */
export const SAFETY = 0.92;

/** The provider's prompt-token count for one sent request, with the size of each message in it. */
export type Calibration = { promptTokens: number; lengths: number[] } | null;
export const messageLengths = (view: ChatMessage[]) => view.map(m =>
  (m.content ?? '').length + ('tool_calls' in m && m.tool_calls ? m.tool_calls.reduce((n, c) => n + c.name.length + c.arguments.length + 8, 0) : 0));

export function estimatePromptTokens(view: ChatMessage[], toolsChars: number, cal: Calibration): number {
  const lens = messageLengths(view);
  if (!cal) return Math.ceil((lens.reduce((a, b) => a + b, 0) + toolsChars) / FIRST_CHARS_PER_TOKEN) + MESSAGE_OVERHEAD * lens.length;
  // Views are built message by message from the same conversation, so index i is the same message.
  let added = 0, removed = 0;
  lens.forEach((n, i) => { const prev = cal.lengths[i]; if (prev === undefined) added += n; else if (n > prev) added += n - prev; else removed += prev - n; });
  for (let i = lens.length; i < cal.lengths.length; i++) removed += cal.lengths[i];
  const newMessages = Math.max(0, lens.length - cal.lengths.length);
  return Math.ceil(cal.promptTokens + added / ADD_CHARS_PER_TOKEN + MESSAGE_OVERHEAD * newMessages - removed / REMOVE_CHARS_PER_TOKEN);
}

/** How many tool results go out in full: the newest `delivered` ones the model has already received, the newest `undelivered` ones it has not; `trim` drops older assistant text. */
export type ViewSpec = { delivered: number; undelivered: number; trim: boolean };
/** estimate: the estimated prompt plus max_tokens (computed with or without a ceiling). */
export type Fit = { view: ChatMessage[]; maxTokens: number; spec: ViewSpec; shortened: boolean; estimate: number };
export type FitOptions = {
  build: (spec: ViewSpec) => ChatMessage[];
  /** Results already received in full that may stay verbatim (the newest first), and results not yet received. */
  deliveredMax: number; undeliveredCount: number;
  maxOutput: number; minOutput: number;
  /** The ceiling for prompt + max_tokens; null means no ceiling. */
  limit: number | null;
  toolsChars: number; cal: Calibration;
  /** Raised after a refused request: start from fewer verbatim results the model has already received. */
  tightness: number;
  /** Share of the ceiling to use; lowered for the rest of a run after the provider refuses a request. */
  safety?: number;
};

/**
 * The fullest request that fits, giving things up in this order: results the model has already
 * received (oldest first, they can be fetched again), then output allowance (not below minOutput),
 * then older assistant text, and only then results it has not yet seen in full (oldest first).
 * A result summarised before the model ever saw it can never support a fact, so that is the last
 * resort. Null if even the smallest request would not fit.
 */
export function fitRequest(o: FitOptions): Fit | null {
  const full: ViewSpec = { delivered: o.deliveredMax, undelivered: o.undeliveredCount, trim: false };
  if (!o.limit) { const view = o.build(full); return { view, maxTokens: o.maxOutput, spec: full, shortened: false, estimate: estimatePromptTokens(view, o.toolsChars, o.cal) + o.maxOutput }; }
  const budget = Math.floor(o.limit * (o.safety ?? SAFETY)), U = o.undeliveredCount;
  const steps: [ViewSpec, number][] = [];
  for (let d = Math.max(0, o.deliveredMax - o.tightness); d >= 0; d--) steps.push([{ delivered: d, undelivered: U, trim: false }, o.maxOutput]);
  steps.push([{ delivered: 0, undelivered: U, trim: false }, o.minOutput], [{ delivered: 0, undelivered: U, trim: true }, o.minOutput]);
  for (let u = U - 1; u >= 0; u--) steps.push([{ delivered: 0, undelivered: u, trim: true }, o.minOutput]);
  for (const [spec, minOut] of steps) {
    const view = o.build(spec), estimate = estimatePromptTokens(view, o.toolsChars, o.cal), maxTokens = Math.min(o.maxOutput, budget - estimate);
    if (maxTokens >= minOut) {
      const same = spec.delivered === full.delivered && spec.undelivered === U && !spec.trim && maxTokens === o.maxOutput;
      return { view, maxTokens, spec, shortened: !same, estimate: estimate + maxTokens };
    }
  }
  return null;
}
