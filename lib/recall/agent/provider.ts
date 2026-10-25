// Chat-completions client for OpenAI-compatible endpoints (Groq, OpenAI, OpenRouter,
// NVIDIA NIM). Keys stay on the server; nothing here is imported by client components.
export type ToolCall = { id: string; name: string; arguments: string };
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export type ToolSpec = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ChatResult = { content: string | null; tool_calls: ToolCall[]; usage: { input_tokens: number; output_tokens: number }; finish_reason: string };
export type ProviderErrorKind = 'timeout' | 'rate_limit' | 'auth' | 'http' | 'network' | 'malformed';

export class ProviderError extends Error {
  constructor(readonly kind: ProviderErrorKind, message: string, readonly retryable: boolean, readonly retryAfterMs?: number) { super(message); }
}

export interface ChatProvider {
  readonly name: string;
  readonly model: string;
  /** USD per million tokens, only when the operator configured it. Null means no cost estimate is made. */
  readonly pricing: { input_per_mtok: number; output_per_mtok: number } | null;
  complete(req: { messages: ChatMessage[]; tools: ToolSpec[]; maxTokens: number; signal: AbortSignal; forceTool?: string }): Promise<ChatResult>;
}

type WireToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: unknown } };

export class OpenAICompatibleProvider implements ChatProvider {
  readonly name: string; readonly model: string; readonly pricing: ChatProvider['pricing'];
  private baseUrl: string; private apiKey: string; private fetcher: typeof fetch;

  constructor(opts: { name: string; baseUrl: string; apiKey: string; model: string; pricing?: ChatProvider['pricing']; fetcher?: typeof fetch }) {
    this.name = opts.name; this.model = opts.model; this.pricing = opts.pricing ?? null;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, ''); this.apiKey = opts.apiKey; this.fetcher = opts.fetcher ?? fetch;
  }

  async complete({ messages, tools, maxTokens, signal, forceTool }: { messages: ChatMessage[]; tools: ToolSpec[]; maxTokens: number; signal: AbortSignal; forceTool?: string }): Promise<ChatResult> {
    const wire = messages.map(m => m.role === 'assistant'
      ? { role: 'assistant', content: m.content ?? '', ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}) }
      : m);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
        method: 'POST', signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages: wire, tools, tool_choice: forceTool ? { type: 'function', function: { name: forceTool } } : 'auto', max_tokens: maxTokens, temperature: 0.1 }),
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
      if (response.status === 429) {
        // Prefer the header; Groq also states the wait in the message ("try again in 7.5s" or "1m2.5s").
        const header = Number(response.headers.get('retry-after')), m = /try again in (?:(\d+)m)?(\d+(?:\.\d+)?)s/i.exec(message);
        const after = Number.isFinite(header) && header > 0 ? header * 1000 : m ? (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000 : undefined;
        throw new ProviderError('rate_limit', `${this.name} rate limit reached: ${message}`, true, after);
      }
      // Groq reports a tool call the model formatted badly as HTTP 400 "tool_use_failed".
      if (code === 'tool_use_failed') throw new ProviderError('malformed', `${this.name} model produced a malformed tool call.`, true);
      throw new ProviderError('http', `${this.name} returned HTTP ${response.status}: ${message}`, response.status >= 500);
    }
    let body: { choices?: { message?: { content?: unknown; tool_calls?: WireToolCall[] }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try { body = await response.json(); } catch { throw new ProviderError('malformed', `${this.name} returned a response that is not JSON.`, true); }
    const choice = body.choices?.[0];
    if (!choice?.message) throw new ProviderError('malformed', `${this.name} response had no message.`, true);
    const calls = (choice.message.tool_calls ?? []).map((c, i) => ({ id: String(c.id || `call_${i}`), name: String(c.function?.name ?? ''), arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}) }));
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
const PRESETS: Record<string, { baseUrl: string; keyVar: string; model: string; timeLimitS: number }> = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', keyVar: 'GROQ_API_KEY', model: 'openai/gpt-oss-120b', timeLimitS: 480 },
  openai: { baseUrl: 'https://api.openai.com/v1', keyVar: 'OPENAI_API_KEY', model: '', timeLimitS: 240 },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyVar: 'OPENROUTER_API_KEY', model: '', timeLimitS: 240 },
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', keyVar: 'NVIDIA_API_KEY', model: '', timeLimitS: 240 },
};
export const DEFAULT_TIME_LIMIT_S = 240, MIN_TIME_LIMIT_S = 60, MAX_TIME_LIMIT_S = 900;

/** time_limit_s: the deadline for one live run (model calls, retries, rate-limit waits and tools together). */
export type ProviderSettings = { provider: string; model: string; configured: boolean; reason: string; time_limit_s: number };

/** The run time limit: AGENT_TIME_LIMIT_S if it is a whole number of seconds in range, else the provider's default. */
function timeLimit(env: Record<string, unknown>, fallback: number): { seconds: number; note: string } {
  const raw = env.AGENT_TIME_LIMIT_S;
  if (raw === undefined || String(raw).trim() === '') return { seconds: fallback, note: '' };
  const n = Number(String(raw).trim());
  if (Number.isInteger(n) && n >= MIN_TIME_LIMIT_S && n <= MAX_TIME_LIMIT_S) return { seconds: n, note: '' };
  return { seconds: fallback, note: ` AGENT_TIME_LIMIT_S must be a whole number of seconds from ${MIN_TIME_LIMIT_S} to ${MAX_TIME_LIMIT_S}; using ${fallback} s.` };
}

/** Builds the live provider from server-side environment values, or explains why there is none. */
export function providerFromEnv(env: Record<string, unknown>): { provider: ChatProvider | null; settings: ProviderSettings } {
  const name = String(env.AGENT_PROVIDER ?? '').trim().toLowerCase() || (env.GROQ_API_KEY ? 'groq' : 'none');
  if (name === 'none') return { provider: null, settings: { provider: 'none', model: '', configured: false, reason: 'No model provider is configured. Investigations run in rules mode.', time_limit_s: DEFAULT_TIME_LIMIT_S } };
  const preset = PRESETS[name], limit = timeLimit(env, preset?.timeLimitS ?? DEFAULT_TIME_LIMIT_S), time_limit_s = limit.seconds;
  const baseUrl = String(env.AGENT_BASE_URL ?? preset?.baseUrl ?? '');
  const apiKey = String(env.AGENT_API_KEY ?? (preset ? env[preset.keyVar] : '') ?? '').trim();
  const model = String(env.AGENT_MODEL ?? preset?.model ?? '').trim();
  if (!baseUrl || !/^https:\/\//.test(baseUrl)) return { provider: null, settings: { provider: name, model, configured: false, reason: `AGENT_BASE_URL must be an https URL for provider "${name}".`, time_limit_s } };
  if (!apiKey || !model) return { provider: null, settings: { provider: name, model, configured: false, reason: `Set ${preset?.keyVar ?? 'AGENT_API_KEY'} and AGENT_MODEL to enable live runs.`, time_limit_s } };
  const pin = Number(env.AGENT_PRICE_INPUT_PER_MTOK), pout = Number(env.AGENT_PRICE_OUTPUT_PER_MTOK);
  const pricing = Number.isFinite(pin) && Number.isFinite(pout) && env.AGENT_PRICE_INPUT_PER_MTOK !== undefined ? { input_per_mtok: pin, output_per_mtok: pout } : null;
  return { provider: new OpenAICompatibleProvider({ name, baseUrl, apiKey, model, pricing }), settings: { provider: name, model, configured: true, reason: `Live model configured on the server.${limit.note}`, time_limit_s } };
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
