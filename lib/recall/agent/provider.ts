// Chat-completions client for OpenAI-compatible endpoints (Groq, OpenAI, OpenRouter,
// NVIDIA NIM). Keys stay on the server; nothing here is imported by client components.
export type ToolCall = { id: string; name: string; arguments: string };
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export type ToolSpec = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ChatResult = { content: string | null; tool_calls: ToolCall[]; usage: { input_tokens: number; output_tokens: number }; finish_reason: string };
/**
 * malformed: the model formatted a tool call badly (Groq tool_use_failed). invalid_response: the
 * provider's own reply was unusable. too_large: one request exceeds the per-request token ceiling.
 * quota: a daily allowance is used up (not worth waiting for within a run).
 */
export type ProviderErrorKind = 'timeout' | 'rate_limit' | 'auth' | 'http' | 'network' | 'malformed' | 'invalid_response' | 'too_large' | 'quota';

export class ProviderError extends Error {
  /** For too_large: what the provider counted for the refused request (prompt plus max_tokens), and the limit it stated. */
  constructor(readonly kind: ProviderErrorKind, message: string, readonly retryable: boolean, readonly retryAfterMs?: number, readonly requestedTokens?: number, readonly limitTokens?: number) { super(message); }
}

export interface ChatProvider {
  readonly name: string;
  readonly model: string;
  /** USD per million tokens, only when the operator configured it. Null means no cost estimate is made. */
  readonly pricing: { input_per_mtok: number; output_per_mtok: number } | null;
  complete(req: { messages: ChatMessage[]; tools: ToolSpec[]; maxTokens: number; signal: AbortSignal; forceTool?: string; temperature?: number }): Promise<ChatResult>;
}

type WireToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: unknown } };

export class OpenAICompatibleProvider implements ChatProvider {
  readonly name: string; readonly model: string; readonly pricing: ChatProvider['pricing'];
  private baseUrl: string; private apiKey: string; private fetcher: typeof fetch;

  constructor(opts: { name: string; baseUrl: string; apiKey: string; model: string; pricing?: ChatProvider['pricing']; fetcher?: typeof fetch }) {
    this.name = opts.name; this.model = opts.model; this.pricing = opts.pricing ?? null;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, ''); this.apiKey = opts.apiKey; this.fetcher = opts.fetcher ?? fetch;
  }

  async complete({ messages, tools, maxTokens, signal, forceTool, temperature = 0.1 }: { messages: ChatMessage[]; tools: ToolSpec[]; maxTokens: number; signal: AbortSignal; forceTool?: string; temperature?: number }): Promise<ChatResult> {
    const wire = messages.map(m => m.role === 'assistant'
      ? { role: 'assistant', content: m.content ?? '', ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}) }
      : m);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
        method: 'POST', signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages: wire, tools, tool_choice: forceTool ? { type: 'function', function: { name: forceTool } } : 'auto', max_tokens: maxTokens, temperature }),
      });
    } catch (error) {
      const name = (error as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new ProviderError('timeout', `${this.name} did not respond in time.`, true);
      throw new ProviderError('network', `Cannot reach ${this.name}.`, true);
    }
    if (!response.ok) {
      // Provider error text can name the account (Groq: "organization `org_…`"); that is not kept.
      const text = (await response.text().catch(() => '')).replace(/\s+/g, ' ').replace(/\borg_[A-Za-z0-9]+/g, 'org_[redacted]');
      let code = '', message = text.slice(0, 200);
      try { const e = JSON.parse(text).error; code = String(e?.code ?? e?.type ?? ''); message = String(e?.message ?? message).slice(0, 200); } catch { /* not JSON */ }
      if (response.status === 401 || response.status === 403) throw new ProviderError('auth', `${this.name} rejected the API key (HTTP ${response.status}).`, false);
      // Groq: a single request larger than the per-minute token limit is refused with 413 and states
      // what it counted ("Limit 8000, Requested 8333"). Retrying the same request cannot succeed.
      if (response.status === 413 || /request too large/i.test(message)) {
        const requested = Number(/requested (\d+)/i.exec(message)?.[1]), limit = Number(/limit (\d+)/i.exec(message)?.[1]);
        throw new ProviderError('too_large', `${this.name} refused a request as too large: ${message}`, true, undefined, Number.isFinite(requested) ? requested : undefined, Number.isFinite(limit) ? limit : undefined);
      }
      if (response.status === 429) {
        // Prefer the header; Groq also states the wait in the message ("try again in 7.5s", "1m2.5s", "1h2m3s").
        const header = Number(response.headers.get('retry-after')), m = /try again in (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i.exec(message);
        const after = Number.isFinite(header) && header > 0 ? header * 1000 : m ? (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3])) * 1000 : undefined;
        // A daily allowance (tokens or requests per day) will not come back within one run.
        if (/per day|\(TPD\)|\(RPD\)/i.test(message)) throw new ProviderError('quota', `${this.name} daily allowance used up: ${message}`, false, after);
        throw new ProviderError('rate_limit', `${this.name} rate limit reached: ${message}`, true, after);
      }
      // Groq reports a tool call the model formatted badly as HTTP 400 "tool_use_failed".
      if (code === 'tool_use_failed') throw new ProviderError('malformed', `${this.name} model produced a malformed tool call.`, true);
      throw new ProviderError('http', `${this.name} returned HTTP ${response.status}: ${message}`, response.status >= 500);
    }
    let body: { choices?: { message?: { content?: unknown; tool_calls?: WireToolCall[] }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try { body = await response.json(); } catch { throw new ProviderError('invalid_response', `${this.name} returned a response that is not JSON.`, true); }
    const choice = body.choices?.[0];
    if (!choice?.message) throw new ProviderError('invalid_response', `${this.name} response had no message.`, true);
    const calls = (choice.message.tool_calls ?? []).map((c, i) => ({ id: String(c.id || `call_${crypto.randomUUID().slice(0, 8)}_${i}`), name: String(c.function?.name ?? ''), arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}) }));
    return {
      content: typeof choice.message.content === 'string' ? choice.message.content : null, tool_calls: calls,
      usage: { input_tokens: body.usage?.prompt_tokens ?? 0, output_tokens: body.usage?.completion_tokens ?? 0 }, finish_reason: choice.finish_reason ?? '',
    };
  }
}

// Only the Groq default model was checked against a live model list (2026-10-24). Other
// presets need AGENT_MODEL set explicitly, so no model ID is assumed.
// timeLimitS is the default time limit for one live run. Groq's free tier allows 8,000 tokens per
// minute and a thorough run sends 30–45k input tokens, so most of a run is spent waiting; at 240 s,
// two of three held-out runs stopped before answering (docs/EVALUATION.md), hence 480 s for Groq.
// requestTokens is the per-request token ceiling (prompt plus max_tokens): 8,000 on Groq's free tier
// for this model (its tokens-per-minute limit, which one request may not exceed); null means none known.
const PRESETS: Record<string, { baseUrl: string; keyVar: string; model: string; timeLimitS: number; requestTokens: number | null }> = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', keyVar: 'GROQ_API_KEY', model: 'openai/gpt-oss-120b', timeLimitS: 480, requestTokens: 8000 },
  openai: { baseUrl: 'https://api.openai.com/v1', keyVar: 'OPENAI_API_KEY', model: '', timeLimitS: 240, requestTokens: null },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyVar: 'OPENROUTER_API_KEY', model: '', timeLimitS: 240, requestTokens: null },
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', keyVar: 'NVIDIA_API_KEY', model: '', timeLimitS: 240, requestTokens: null },
};
export const DEFAULT_TIME_LIMIT_S = 240, MIN_TIME_LIMIT_S = 60, MAX_TIME_LIMIT_S = 900;

/**
 * time_limit_s: the deadline for one live run (model calls, retries, rate-limit waits and tools together).
 * request_token_limit: each request (prompt plus max_tokens) is kept under this many tokens; null means no ceiling.
 */
export type ProviderSettings = { provider: string; model: string; configured: boolean; reason: string; time_limit_s: number; request_token_limit: number | null };

/** The run time limit: AGENT_TIME_LIMIT_S if it is a whole number of seconds in range, else the provider's default. */
function timeLimit(env: Record<string, unknown>, fallback: number): { seconds: number; note: string } {
  const raw = env.AGENT_TIME_LIMIT_S;
  if (raw === undefined || String(raw).trim() === '') return { seconds: fallback, note: '' };
  const n = Number(String(raw).trim());
  if (Number.isInteger(n) && n >= MIN_TIME_LIMIT_S && n <= MAX_TIME_LIMIT_S) return { seconds: n, note: '' };
  return { seconds: fallback, note: ` AGENT_TIME_LIMIT_S must be a whole number of seconds from ${MIN_TIME_LIMIT_S} to ${MAX_TIME_LIMIT_S}; using ${fallback} s.` };
}

/** The per-request token ceiling: AGENT_MAX_REQUEST_TOKENS (a whole number from 7,000 to 2,000,000, or "none"), else the provider's. The fixed instructions, tool definitions and a question are estimated at up to about 4,800 tokens before calibration, and an answer needs at least 900 more. */
function requestLimit(env: Record<string, unknown>, fallback: number | null): { tokens: number | null; note: string } {
  const raw = String(env.AGENT_MAX_REQUEST_TOKENS ?? '').trim();
  if (!raw) return { tokens: fallback, note: '' };
  if (raw.toLowerCase() === 'none') return { tokens: null, note: '' };
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 7000 && n <= 2_000_000) return { tokens: n, note: '' };
  return { tokens: fallback, note: ` AGENT_MAX_REQUEST_TOKENS must be a whole number from 7000 to 2000000, or "none"; using ${fallback ?? 'no limit'}.` };
}

/** Builds the live provider from server-side environment values, or explains why there is none. */
export function providerFromEnv(env: Record<string, unknown>): { provider: ChatProvider | null; settings: ProviderSettings } {
  const name = String(env.AGENT_PROVIDER ?? '').trim().toLowerCase() || (env.GROQ_API_KEY ? 'groq' : 'none');
  if (name === 'none') return { provider: null, settings: { provider: 'none', model: '', configured: false, reason: 'No model provider is configured. Investigations run in rules mode.', time_limit_s: DEFAULT_TIME_LIMIT_S, request_token_limit: null } };
  const preset = PRESETS[name], limit = timeLimit(env, preset?.timeLimitS ?? DEFAULT_TIME_LIMIT_S), time_limit_s = limit.seconds;
  const ceiling = requestLimit(env, preset?.requestTokens ?? null), request_token_limit = ceiling.tokens;
  const baseUrl = String(env.AGENT_BASE_URL ?? preset?.baseUrl ?? '');
  const apiKey = String(env.AGENT_API_KEY ?? (preset ? env[preset.keyVar] : '') ?? '').trim();
  const model = String(env.AGENT_MODEL ?? preset?.model ?? '').trim();
  if (!baseUrl || !/^https:\/\//.test(baseUrl)) return { provider: null, settings: { provider: name, model, configured: false, reason: `AGENT_BASE_URL must be an https URL for provider "${name}".`, time_limit_s, request_token_limit } };
  if (!apiKey || !model) return { provider: null, settings: { provider: name, model, configured: false, reason: `Set ${preset?.keyVar ?? 'AGENT_API_KEY'} and AGENT_MODEL to enable live runs.`, time_limit_s, request_token_limit } };
  const pin = Number(env.AGENT_PRICE_INPUT_PER_MTOK), pout = Number(env.AGENT_PRICE_OUTPUT_PER_MTOK);
  const pricing = Number.isFinite(pin) && Number.isFinite(pout) && env.AGENT_PRICE_INPUT_PER_MTOK !== undefined ? { input_per_mtok: pin, output_per_mtok: pout } : null;
  return { provider: new OpenAICompatibleProvider({ name, baseUrl, apiKey, model, pricing }), settings: { provider: name, model, configured: true, reason: `Live model configured on the server.${limit.note}${ceiling.note}`, time_limit_s, request_token_limit } };
}

/** Test double that replays scripted turns. Each step may return a result, throw, or wait for abort. */
export class ScriptedProvider implements ChatProvider {
  readonly name = 'scripted'; readonly pricing = null; calls = 0;
  constructor(private steps: ((messages: ChatMessage[]) => ChatResult | Promise<ChatResult>)[], readonly model = 'scripted-test') {}
  async complete({ messages, signal }: { messages: ChatMessage[]; signal: AbortSignal }): Promise<ChatResult> {
    const step = this.steps[Math.min(this.calls++, this.steps.length - 1)];
    if (signal.aborted) throw new ProviderError('timeout', 'scripted provider aborted', true);
    return await Promise.race([Promise.resolve().then(() => step(messages)), new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new ProviderError('timeout', 'scripted provider timed out', true)), { once: true }))]);
  }
}
export const turn = (tool_calls: [string, unknown][], content: string | null = null): ChatResult =>
  ({ content, tool_calls: tool_calls.map(([name, args], i) => ({ id: `t${i}_${name}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })), usage: { input_tokens: 100, output_tokens: 20 }, finish_reason: 'tool_calls' });
