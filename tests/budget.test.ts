import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioCase } from '../lib/recall/sample.ts';
import { reconcileCase } from '../lib/recall/engine.ts';
import { takeSnapshot } from '../lib/recall/snapshot.ts';
import { createContext } from '../lib/recall/agent/tools.ts';
import { investigate } from '../lib/recall/agent/runner.ts';
import { ProviderError, providerFromEnv, OpenAICompatibleProvider, turn, type ChatMessage, type ChatProvider, type ChatResult, type ToolSpec } from '../lib/recall/agent/provider.ts';
import { estimatePromptTokens, fitRequest, messageLengths, SAFETY, type ViewSpec } from '../lib/recall/agent/budget.ts';

// Fitting the live agent to Groq's free tier: every request (prompt plus max_tokens) under the
// per-request ceiling, and malformed tool calls not using up the model-call budget.
const NOW = '2026-10-24T00:00:00Z';
const ctxFor = () => {
  const c = createScenarioCase('velora-pens', 'budget', NOW), r = reconcileCase(c);
  return createContext({ c, r, memory: null, external: null, previous: undefined, current: takeSnapshot(c, r, 'agent-live', 'T', null, NOW) });
};
const submit = () => turn([['submit_findings', { summary: 'Scripted summary text.', facts: [], interpretations: [], evidence_requests: [] }]]);
let callSeq = 0;
/** turn() with call IDs unique across the run, as a real provider gives them. */
const uturn = (calls: [string, unknown][]) => { const t = turn(calls); return { ...t, tool_calls: t.tool_calls.map(c => ({ ...c, id: `c${++callSeq}` })) }; };
const msg = (role: 'user' | 'system', n: number): ChatMessage => ({ role, content: 'x'.repeat(n) });

/**
 * A stand-in for Groq's free tier: it counts a request as ceil(characters / 4) prompt tokens plus
 * max_tokens, refuses anything over the ceiling with HTTP 413 semantics, and reports the prompt tokens.
 */
class TieredProvider implements ChatProvider {
  readonly name = 'groq-like'; readonly model = 'm'; readonly pricing = null;
  requests: { requested: number; maxTokens: number; temperature?: number; messages: ChatMessage[] }[] = []; refused = 0;
  constructor(private steps: ((m: ChatMessage[]) => ChatResult | Promise<ChatResult>)[], private ceiling = 8000, private refuseFirst = 0) {}
  async complete(req: { messages: ChatMessage[]; tools: ToolSpec[]; maxTokens: number; temperature?: number }): Promise<ChatResult> {
    const prompt = Math.ceil((JSON.stringify(req.messages).length + JSON.stringify(req.tools).length) / 4), requested = prompt + req.maxTokens;
    this.requests.push({ requested, maxTokens: req.maxTokens, temperature: req.temperature, messages: req.messages });
    if (requested > this.ceiling || this.refused < this.refuseFirst) {
      // A forced refusal stands for a provider that counts more than our estimate: it reports more than the ceiling.
      const counted = Math.max(requested, this.ceiling + 1); this.refused++;
      throw new ProviderError('too_large', `Request too large: Limit ${this.ceiling}, Requested ${counted}`, true, undefined, counted, Number.isFinite(this.ceiling) ? this.ceiling : undefined);
    }
    const step = this.steps[Math.min(this.requests.length - this.refused - 1, this.steps.length - 1)];
    const out = await step(req.messages);
    return { ...out, usage: { input_tokens: prompt, output_tokens: 50 } };
  }
}
// A long investigation whose tool results are large enough to push an unshortened context past 8,000 tokens.
const heavy = () => [
  () => uturn([['run_reconciliation', { purpose: 'balances' }]]),
  () => uturn([['search_records', { purpose: 'review queue', status: 'review', limit: 20 }]]),
  () => uturn([['get_shipment_ledger', { purpose: 'VS-202', shipment_id: 'VS-202' }]]),
  () => uturn([['get_shipment_ledger', { purpose: 'VS-203', shipment_id: 'VS-203' }]]),
  () => uturn([['search_records', { purpose: 'all records', limit: 20 }]]),
  () => uturn([['get_shipment_ledger', { purpose: 'VS-204', shipment_id: 'VS-204' }]]),
  () => uturn([['propose_follow_up', { issue_id: 'stock:VS-204', action: 'Ask the distributor for proof of delivery.', owner_role: 'distributor', evidence_requested: 'Proof of delivery', citations: ['stock:VS-204'] }]]),
  () => uturn([['submit_findings', { summary: 'Scripted summary text.', facts: [{ type: 'shipment_balance', shipment_id: 'VS-204', state: 'available', quantity: 25, unit: 'pens' }], interpretations: [], evidence_requests: [] }]]),
];

test('token estimate: pessimistic before calibration, then the provider count plus added text at 3.6 characters per token and removed text at 4.5', () => {
  const view = [msg('system', 3500), msg('user', 350)];
  assert.deepEqual(messageLengths([{ role: 'tool', tool_call_id: 'a', content: '{"a":"b"}' }, { role: 'assistant', content: null, tool_calls: [{ id: 'x', name: 'abc', arguments: '{}' }] }]), [9, 13], 'text is measured as sent, not as escaped JSON');
  assert.equal(estimatePromptTokens(view, 7000, null), Math.ceil((3850 + 7000) / 3.5) + 16);
  const cal = { promptTokens: 1000, lengths: messageLengths(view) };
  assert.equal(estimatePromptTokens(view, 7000, cal), 1000, 'the same messages cost what the provider counted');
  assert.equal(estimatePromptTokens([...view, msg('user', 3600)], 7000, cal), 1000 + 1000 + 8);
  assert.equal(estimatePromptTokens([view[0], msg('user', 350 - 90)], 7000, cal), 1000 - 20, 'removed text is credited at 4.5 characters per token');
});

test('request fitting gives up, in order: results already seen, output allowance, older assistant text, and only then results not yet seen', () => {
  // Prompt tokens: 400 base, +1,000 per delivered result kept verbatim, +1,500 per undelivered one, -200 when trimmed.
  const build = (v: ViewSpec): ChatMessage[] => [msg('user', (400 + v.delivered * 1000 + v.undelivered * 1500 - (v.trim ? 200 : 0)) * 4)];
  const base = { build, deliveredMax: 3, undeliveredCount: 2, maxOutput: 1600, minOutput: 900, toolsChars: 0, cal: null, tightness: 0 };
  const est = (v: ViewSpec) => estimatePromptTokens(build(v), 0, null);
  const fits = (prompt: number, out: number) => Math.ceil((prompt + out) / SAFETY);
  const full = { delivered: 3, undelivered: 2, trim: false };
  assert.deepEqual(fitRequest({ ...base, limit: null }), { view: build(full), maxTokens: 1600, spec: full, shortened: false, estimate: est(full) + 1600 }, 'no ceiling: everything, with an estimate');
  const a = fitRequest({ ...base, limit: fits(est({ delivered: 1, undelivered: 2, trim: false }), 1600) })!;
  assert.deepEqual(a.spec, { delivered: 1, undelivered: 2, trim: false }, 'seen results go first, output stays full'); assert.equal(a.maxTokens, 1600);
  const b = fitRequest({ ...base, limit: fits(est({ delivered: 0, undelivered: 2, trim: false }), 1000) })!;
  assert.deepEqual(b.spec, { delivered: 0, undelivered: 2, trim: false }, 'then the output allowance shrinks; unseen results stay'); assert.ok(b.maxTokens >= 900 && b.maxTokens < 1600);
  const c = fitRequest({ ...base, limit: fits(est({ delivered: 0, undelivered: 1, trim: true }), 950) })!;
  assert.deepEqual(c.spec, { delivered: 0, undelivered: 1, trim: true }, 'an unseen result is summarised only when nothing else fits');
  assert.equal(fitRequest({ ...base, limit: fits(est({ delivered: 0, undelivered: 0, trim: true }), 500) }), null, 'nothing fits: the caller ends the run');
  assert.equal(fitRequest({ ...base, limit: 20000, tightness: 2 })!.spec.delivered, 1, 'after a refusal it starts from fewer seen results');
});

test('a long run stays under an 8,000-token ceiling on every request, and would not without fitting', async () => {
  const unfitted = new TieredProvider(heavy(), Number.POSITIVE_INFINITY);
  await investigate({ question: 'Which shipments still have pens without a record?', ctx: ctxFor(), provider: unfitted, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: null } });
  assert.ok(Math.max(...unfitted.requests.map(r => r.requested)) > 8000, 'the scenario is heavy enough to matter');

  const groq = new TieredProvider(heavy(), 8000);
  const run = await investigate({ question: 'Which shipments still have pens without a record?', ctx: ctxFor(), provider: groq, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: 8000 } });
  assert.equal(run.status, 'completed', run.status_detail);
  assert.equal(groq.refused, 0, `no request was refused: ${groq.requests.map(r => r.requested).join(', ')}`);
  assert.ok(groq.requests.every(r => r.requested <= 8000));
  assert.ok((run.usage.shortened_requests ?? 0) > 0, 'some requests were shortened');
  assert.ok(groq.requests.every(r => r.maxTokens >= 900));
  assert.equal(run.limits?.max_request_tokens, 8000);
  // The result the model just asked for always goes out in full.
  for (const r of groq.requests.slice(1)) { const last = [...r.messages].reverse().find(m => m.role === 'tool'); assert.ok(last && !String(last.content).includes('"shortened":true'), 'newest tool result verbatim'); }
  assert.equal(run.answer!.facts![0].status, 'validated', 'a fact backed by a result the model received verbatim is accepted');
});

test('results the model has not yet seen are not delivered evidence: a submission in the same turn is sent back once to read them', async () => {
  const p = new TieredProvider([() => uturn([['run_reconciliation', {}], ['submit_findings', { summary: 'Scripted summary text.', facts: [{ type: 'shipment_balance', shipment_id: 'VS-204', state: 'available', quantity: 25, unit: 'pens' }], interpretations: [], evidence_requests: [] }]])], 8000);
  const run = await investigate({ question: 'q', ctx: ctxFor(), provider: p, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: 8000 } });
  assert.equal(run.status, 'completed', run.status_detail);
  assert.match(run.steps.find(st => st.tool === 'submit_findings' && !st.ok)!.error!, /model had not read yet/);
  assert.equal(run.answer!.facts![0].status, 'validated', 'accepted once the model had read the reconciliation');
});

test('a refused oversized request is resent smaller without using the model-call budget; repeated refusals stop the run', async () => {
  // The configured ceiling (8,000) is above what this provider really accepts (6,500): requests are refused until the stated limit is learned.
  const p = new TieredProvider(heavy(), 6500);
  const run = await investigate({ question: 'q', ctx: ctxFor(), provider: p, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: 8000 } });
  assert.equal(run.status, 'completed', run.status_detail);
  assert.ok(p.refused >= 1); assert.equal(run.usage.oversize_retries, p.refused, 'every refusal was followed by a smaller resend');
  const i = p.requests.findIndex(r => r.requested > 6500);
  assert.ok(p.requests[i + 1].requested < p.requests[i].requested, 'the resent request really is smaller');
  assert.ok(p.requests.slice(i + 1).every(r => r.requested <= 6500), 'the stated limit holds for the rest of the run');
  assert.equal(run.usage.model_calls, p.requests.length - p.refused, 'refusals do not use the model-call budget');
  assert.match(run.status_detail, /oversized requests? resent smaller/);
  const stubborn = new TieredProvider([submit], 8000, 99);
  const stopped = await investigate({ question: 'q', ctx: ctxFor(), provider: stubborn, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: 8000 } });
  assert.equal(stopped.status, 'provider_error'); assert.match(stopped.status_detail, /too_large|could not be made smaller|no longer fits|too small for/); assert.equal(stopped.usage.model_calls, 0);
  const shapes = new Set(stubborn.requests.map(r => `${r.maxTokens}|${JSON.stringify(r.messages).length}`));
  assert.equal(shapes.size, stubborn.requests.length, 'no identical request is ever resent');
});

test('with no ceiling configured, a refusal that states the limit sets it; one that does not ends the run without resending', async () => {
  const p = new TieredProvider(heavy(), 8000);
  const run = await investigate({ question: 'q', ctx: ctxFor(), provider: p, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: null } });
  assert.equal(run.status, 'completed', run.status_detail);
  assert.ok(p.refused >= 1 && (run.usage.oversize_retries ?? 0) >= 1, 'the stated limit was learned after a refusal');
  assert.ok(p.requests.filter((_, i) => i > 0).slice(-3).every(r => r.requested <= 8000));
  // A refusal with no count or limit: the refused size becomes an inferred ceiling and every resend is smaller.
  const sizes: number[] = [];
  const silent: ChatProvider = { name: 'other', model: 'm', pricing: null, complete: async req => { sizes.push(JSON.stringify(req.messages).length + req.maxTokens * 4); throw new ProviderError('too_large', 'Request too large.', true); } };
  const stopped = await investigate({ question: 'q', ctx: ctxFor(), provider: silent, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: null } });
  assert.equal(stopped.status, 'provider_error');
  assert.ok(sizes.every((n, i) => i === 0 || n < sizes[i - 1]), 'never an identical or larger resend');
  assert.ok(stopped.limits!.max_request_tokens! > 0, 'the inferred ceiling is recorded');
});

test('malformed tool calls are retried at a higher temperature and do not use the model-call budget', async () => {
  let n = 0;
  const temps: (number | undefined)[] = [];
  const flaky: ChatProvider = { name: 'groq', model: 'm', pricing: null, complete: async req => {
    temps.push(req.temperature);
    n++;
    if (n === 1) return turn([['run_reconciliation', {}]]);
    if (n <= 4) throw new ProviderError('malformed', 'groq model produced a malformed tool call.', true);
    return turn([['propose_follow_up', { issue_id: 'stock:VS-204', action: 'Ask the distributor for proof of delivery.', owner_role: 'distributor', evidence_requested: 'Proof of delivery', citations: ['stock:VS-204'] }], ['submit_findings', { summary: 'Scripted summary text.', facts: [], interpretations: [], evidence_requests: [] }]]);
  } };
  const run = await investigate({ question: 'q', ctx: ctxFor(), provider: flaky, actor: 'T', sleep: async () => {}, limits: { maxModelCalls: 2 } });
  assert.equal(run.status, 'completed', run.status_detail);
  assert.deepEqual([run.usage.model_calls, run.usage.malformed_calls], [2, 3], 'three malformed calls, and the two real calls fit a budget of two');
  assert.deepEqual(temps, [undefined, undefined, 0.6, 0.6, 0.6]);
  assert.match(run.status_detail, /3 malformed tool calls \(3 retried without using the model-call budget\)/);
  // Past the free retries a malformed call is an ordinary counted retry; the model-call budget decides the end.
  const broken: ChatProvider = { name: 'groq', model: 'm', pricing: null, complete: async () => { throw new ProviderError('malformed', 'groq model produced a malformed tool call.', true); } };
  const stopped = await investigate({ question: 'q', ctx: ctxFor(), provider: broken, actor: 'T', sleep: async () => {} });
  assert.equal(stopped.status, 'limit_reached', 'every call malformed: the run ends at its model-call budget, never above it');
  assert.match(stopped.status_detail, /Stopped after 10 model calls without submitted findings\. 13 malformed tool calls \(3 retried without/);
  assert.deepEqual([stopped.usage.model_calls, stopped.usage.malformed_calls], [10, 13]);
});

test('a run with repeated malformed calls still reaches its forced final answer instead of ending with nothing', async () => {
  let n = 0;
  const alternating: ChatProvider = { name: 'groq', model: 'm', pricing: null, complete: async req => {
    if (req.forceTool) return turn([['submit_findings', { summary: 'Final summary text.', facts: [], interpretations: [], evidence_requests: [] }]]);
    n++;
    if (n % 2 === 0) throw new ProviderError('malformed', 'groq model produced a malformed tool call.', true);
    return uturn([['get_recall_scope', {}]]);
  } };
  const run = await investigate({ question: 'q', ctx: ctxFor(), provider: alternating, actor: 'T', sleep: async () => {} });
  assert.equal(run.status, 'completed', run.status_detail); assert.ok(run.answer);
  assert.ok((run.usage.malformed_calls ?? 0) >= 4, 'more malformed calls than the free retries');
});

test('a used-up daily allowance ends the run at once instead of waiting', async () => {
  let slept = 0;
  const p: ChatProvider = { name: 'groq', model: 'm', pricing: null, complete: async () => { throw new ProviderError('quota', 'groq daily allowance used up: tokens per day (TPD): Limit 200000, Used 199000', false, 3_600_000); } };
  const run = await investigate({ question: 'q', ctx: ctxFor(), provider: p, actor: 'T', sleep: async () => { slept++; } });
  assert.equal(run.status, 'provider_error'); assert.match(run.status_detail, /^quota: .*daily allowance/); assert.equal(slept, 0);
});

test('the provider classifies Groq refusals: too large (with the count), daily quotas, and waits stated in hours', async () => {
  const call = (res: Response) => new OpenAICompatibleProvider({ name: 'groq', baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', fetcher: (async () => res) as unknown as typeof fetch })
    .complete({ messages: [], tools: [], maxTokens: 10, signal: AbortSignal.timeout(1000) });
  await assert.rejects(call(new Response('{"error":{"message":"Request too large for model `m` in organization `org_01abc` on tokens per minute (TPM): Limit 8000, Requested 8333, please reduce your message size"}}', { status: 413 })),
    (e: ProviderError) => e.kind === 'too_large' && e.retryable && e.requestedTokens === 8333 && !/org_01abc/.test(e.message));
  await assert.rejects(call(new Response('{"error":{"message":"Rate limit reached on tokens per day (TPD): Limit 200000, Used 196731, Requested 4313. Please try again in 1h2m3.5s."}}', { status: 429 })),
    (e: ProviderError) => e.kind === 'quota' && !e.retryable && e.retryAfterMs === 3_723_500);
  await assert.rejects(call(new Response('{"error":{"message":"Rate limit reached on requests per day (RPD): Limit 1000. Please try again in 5m0s."}}', { status: 429 })), (e: ProviderError) => e.kind === 'quota');
  await assert.rejects(call(new Response('{"error":{"message":"Rate limit reached on tokens per minute (TPM). Please try again in 2.5s."}}', { status: 429 })), (e: ProviderError) => e.kind === 'rate_limit' && e.retryAfterMs === 2500);
});

test('settings: Groq requests stay under 8,000 tokens by default; AGENT_MAX_REQUEST_TOKENS overrides or disables it', () => {
  const groq = (extra: Record<string, string> = {}) => providerFromEnv({ GROQ_API_KEY: 'test-key', ...extra }).settings;
  assert.equal(groq().request_token_limit, 8000);
  assert.equal(groq({ AGENT_MAX_REQUEST_TOKENS: '7500' }).request_token_limit, 7500);
  assert.equal(groq({ AGENT_MAX_REQUEST_TOKENS: 'none' }).request_token_limit, null);
  const bad = groq({ AGENT_MAX_REQUEST_TOKENS: '500' });
  assert.equal(bad.request_token_limit, 8000); assert.match(bad.reason, /AGENT_MAX_REQUEST_TOKENS must be a whole number/);
  assert.equal(providerFromEnv({ AGENT_PROVIDER: 'openai', OPENAI_API_KEY: 'k', AGENT_MODEL: 'm' }).settings.request_token_limit, null);
});

test('several tool calls in one turn: none of their results is summarised before the model has read it', async () => {
  const facts = [{ type: 'case_total', measure: 'accepted', quantity: 425, unit: 'pens' }, { type: 'shipment_balance', shipment_id: 'VS-204', state: 'available', quantity: 25, unit: 'pens' }, { type: 'shipment_balance', shipment_id: 'VS-202', state: 'dispensed', quantity: 38, unit: 'pens' }];
  // Four results with no ceiling; under Groq's 8,000 two large ones (four would not fit even with the smallest output allowance).
  const steps = (limit: number | null) => [
    () => uturn(limit ? [['run_reconciliation', {}], ['get_shipment_ledger', { shipment_id: 'VS-204' }]] : [['run_reconciliation', {}], ['get_shipment_ledger', { shipment_id: 'VS-202' }], ['get_shipment_ledger', { shipment_id: 'VS-203' }], ['get_shipment_ledger', { shipment_id: 'VS-204' }]]),
    () => uturn([['propose_follow_up', { issue_id: 'stock:VS-204', action: 'Ask the distributor for proof of delivery.', owner_role: 'distributor', evidence_requested: 'Proof of delivery', citations: ['stock:VS-204'] }]]),
    () => uturn([['submit_findings', { summary: 'Scripted summary text.', facts: limit ? facts.slice(0, 2) : facts, interpretations: [], evidence_requests: [] }]]),
  ];
  for (const limit of [null, 8000]) {
    const p = new TieredProvider(steps(limit), Number.POSITIVE_INFINITY);
    const run = await investigate({ question: 'q', ctx: ctxFor(), provider: p, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: limit } });
    assert.equal(run.status, 'completed', run.status_detail);
    const second = p.requests[1].messages.filter(m => m.role === 'tool');
    assert.equal(second.filter(m => String(m.content).includes('"shortened":true')).length, 0, `every result of the turn goes out in full (ceiling ${limit})`);
    assert.ok(run.answer!.facts!.every(f => f.status === 'validated'), JSON.stringify(run.answer!.facts!.map(f => f.problems)));
    if (limit) assert.ok(p.requests[1].requested <= 8000);
  }
});

test('after a refusal the request is smaller only until the next answer; a refusal without a count still gets a smaller resend; a learned ceiling is recorded', async () => {
  // Refused once at the start, then a long run: later requests keep the newest result in full.
  const p = new TieredProvider(heavy(), 8000, 1);
  const run = await investigate({ question: 'q', ctx: ctxFor(), provider: p, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: 8000 } });
  assert.equal(run.status, 'completed', run.status_detail);
  for (const r of p.requests.slice(2)) { const last = [...r.messages].reverse().find(m => m.role === 'tool'); assert.ok(!last || !String(last.content).includes('"shortened":true')); }
  // A refusal that states no count: the request is still resent smaller instead of the run ending.
  let n = 0;
  const vague: ChatProvider = { name: 'groq', model: 'm', pricing: null, complete: async req => { n++; if (n === 1) throw new ProviderError('too_large', 'Request too large.', true); assert.ok(req.maxTokens < 1600, 'smaller after the refusal'); return submit(); } };
  const resent = await investigate({ question: 'q', ctx: ctxFor(), provider: vague, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: 8000 } });
  assert.equal(resent.status, 'completed', resent.status_detail); assert.equal(resent.usage.oversize_retries, 1);
  // The limit stated by the provider is recorded as the limit the run ran under.
  const lower = new TieredProvider(heavy(), 6500);
  const learned = await investigate({ question: 'q', ctx: ctxFor(), provider: lower, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: 8000 } });
  assert.equal(learned.limits?.max_request_tokens, 6500);
});

test('after the free retries, malformed calls use model calls but never end the run early or exceed the budget', async () => {
  let n = 0;
  const p: ChatProvider = { name: 'groq', model: 'm', pricing: null, complete: async req => {
    n++;
    if (req.forceTool) return submit();
    if (n === 1) return uturn([['get_recall_scope', {}]]);
    throw new ProviderError('malformed', 'groq model produced a malformed tool call.', true);
  } };
  const run = await investigate({ question: 'q', ctx: ctxFor(), provider: p, actor: 'T', sleep: async () => {} });
  assert.equal(run.status, 'completed', run.status_detail); assert.ok(run.answer, 'the forced final answer is reached');
  assert.ok(run.usage.model_calls <= 10, `model calls ${run.usage.model_calls} within the budget`);
  assert.match(run.status_detail, /malformed tool calls \(3 retried without using the model-call budget\)/);
  assert.doesNotMatch(run.status_detail, /Waited/, 'retry pauses are not reported as rate-limit waits');
});

test('a follow-up proposed in the same turn as the retrieval it relies on gets a clear "read it first" answer', async () => {
  const p = new TieredProvider([
    () => uturn([['get_shipment_ledger', { shipment_id: 'VS-204' }], ['propose_follow_up', { issue_id: 'stock:VS-204', action: 'Ask the distributor for proof of delivery.', owner_role: 'distributor', evidence_requested: 'Proof of delivery', citations: ['stock:VS-204'] }]]),
    () => uturn([['propose_follow_up', { issue_id: 'stock:VS-204', action: 'Ask the distributor for proof of delivery.', owner_role: 'distributor', evidence_requested: 'Proof of delivery', citations: ['stock:VS-204'] }]]),
    submit,
  ], Number.POSITIVE_INFINITY);
  const run = await investigate({ question: 'q', ctx: ctxFor(), provider: p, actor: 'T', sleep: async () => {} });
  const proposals = run.steps.filter(s => s.tool === 'propose_follow_up');
  assert.match(proposals[0].error!, /returned in this same turn and you have not read it yet/);
  assert.equal(proposals[1].ok, true, 'accepted once the model has read the ledger');
});

test('a result the model received only as a summary is retired: never resent in full, and facts on it are explained as summary-only', async () => {
  // A provider that counts one search_records result far above the estimate: any request carrying it in full is refused.
  const fullSearch = (r: { messages: ChatMessage[] }) => r.messages.some(m => m.role === 'tool' && String(m.content).includes('total_matches') && !String(m.content).includes('"shortened":true'));
  class Dense extends TieredProvider {
    async complete(req: { messages: ChatMessage[]; tools: ToolSpec[]; maxTokens: number; temperature?: number }) {
      if (fullSearch(req)) { this.requests.push({ requested: 8001, maxTokens: req.maxTokens, messages: req.messages }); this.refused++; throw new ProviderError('too_large', 'Request too large: Limit 8000, Requested 8001', true, undefined, 8001, 8000); }
      return super.complete(req);
    }
  }
  const steps = [
    () => uturn([['run_reconciliation', {}]]),
    () => uturn([['search_records', { status: 'review', limit: 20 }]]),
    () => uturn([['get_shipment_ledger', { shipment_id: 'VS-204' }]]),
    () => uturn([['get_recall_scope', {}]]),
    (m: ChatMessage[]) => {
      // A record handle that appeared only in the search result, which the model received as a summary.
      const summary = m.find(x => x.role === 'tool' && String(x.content).includes('"shortened":true') && String(x.content).includes('matching records'));
      const cite = (JSON.parse(String(summary!.content)) as { cites: string[] }).cites[0];
      return uturn([['submit_findings', { summary: 'Scripted summary text.', facts: [{ type: 'record_status', record: cite, status: 'review' }], interpretations: [], evidence_requests: [] }]]);
    },
  ];
  const p = new Dense(steps, 8000);
  const run = await investigate({ question: 'q', ctx: ctxFor(), provider: p, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: 8000 } });
  assert.equal(run.status, 'completed', run.status_detail);
  const answered = p.requests;
  const firstSummary = answered.findIndex(r => r.messages.some(m => m.role === 'tool' && String(m.content).includes('"shortened":true') && String(m.content).includes('matching records')));
  assert.ok(firstSummary > 0, 'the search result was sent as a summary');
  assert.ok(answered.slice(firstSummary + 1).every(r => !fullSearch(r)), 'and never in full again');
  assert.ok(p.refused <= 2, `refused ${p.refused} times, not once per turn`);
  assert.match(run.answer!.facts![0].problems.join(' '), /reached the agent only as a shortened summary/);
});

test('large results in one turn are capped so that all of them reach the model in full under the ceiling', async () => {
  const p = new TieredProvider([
    () => uturn([['run_reconciliation', {}], ['get_shipment_ledger', { shipment_id: 'VS-202' }], ['get_shipment_ledger', { shipment_id: 'VS-203' }], ['get_shipment_ledger', { shipment_id: 'VS-204' }]]),
    () => uturn([['get_recall_scope', {}]]),
    () => uturn([['submit_findings', { summary: 'Scripted summary text.', facts: [{ type: 'case_total', measure: 'accepted', quantity: 425, unit: 'pens' }], interpretations: [], evidence_requests: [] }]]),
  ], Number.POSITIVE_INFINITY);
  const run = await investigate({ question: 'q', ctx: ctxFor(), provider: p, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: 8000 } });
  assert.equal(run.status, 'completed', run.status_detail);
  assert.equal(p.requests[1].messages.filter(m => m.role === 'tool' && String(m.content).includes('"shortened":true')).length, 0, 'none of the four is summarised');
  assert.ok(p.requests.every(r => r.requested <= 8000));
  assert.equal(run.answer!.facts![0].status, 'validated', run.answer!.facts![0].problems.join(' '));
});

test('rejections say why evidence was not read: same turn, or only a summary (facts, proposals, interpretations, evidence requests)', async () => {
  const { collectDelivered, executeTool, serializeForModel, FINAL_TOOL } = await import('../lib/recall/agent/tools.ts');
  const { verifyAnswer } = await import('../lib/recall/agent/validate.ts');
  const ctx = ctxFor();
  const compare = await executeTool('compare_with_previous_run', {}, ctx);
  collectDelivered('compare_with_previous_run', serializeForModel(compare.result), ctx, ctx.pending);
  const ledger = await executeTool('get_shipment_ledger', { shipment_id: 'VS-204' }, ctx);
  collectDelivered('get_shipment_ledger', serializeForModel(ledger.result), ctx, ctx.summarised);
  const cite = (ledger.result.data as { records: { cite: string }[] }).records[0].cite;
  const a = verifyAnswer(FINAL_TOOL.schema.parse({ summary: 'Scripted summary text.', facts: [{ type: 'change_since_previous', comparison: 'D1', field: 'available', before: 0, after: 47 }, { type: 'open_issue', issue_id: 'stock:VS-204' }],
    interpretations: [{ text: 'About the dispatch record.', related: [cite] }], evidence_requests: [{ issue_id: 'stock:VS-204', description: 'Proof of delivery.', would_change: 'Could close the gap.' }] }), ctx);
  assert.match(a.facts![0].problems[0], /D1 was not delivered to the agent in this run\. It was returned only in the same turn/);
  assert.match(a.facts![1].problems[0], /reached the agent only as a shortened summary/);
  assert.match(a.interpretations![0].problems[0], /reached you only as a shortened summary/);
  assert.match(a.evidence_requests![0].problems[0], /reached you only as a shortened summary/);
  const propose = await executeTool('propose_follow_up', { issue_id: 'stock:VS-204', action: 'Ask the distributor for proof of delivery.', owner_role: 'distributor', evidence_requested: 'Proof of delivery', citations: [] }, ctx);
  assert.match(propose.result.error!, /reached you only as a shortened summary/);
});

test('repeated tool-call IDs from a provider are made unique, so each result is tracked on its own', async () => {
  let n = 0;
  const same: ChatProvider = { name: 'groq', model: 'm', pricing: null, complete: async () => {
    n++;
    const t = n === 1 ? turn([['get_shipment_ledger', { shipment_id: 'VS-202' }]]) : n === 2 ? turn([['get_shipment_ledger', { shipment_id: 'VS-204' }]])
      : turn([['submit_findings', { summary: 'Scripted summary text.', facts: [{ type: 'shipment_balance', shipment_id: 'VS-204', state: 'available', quantity: 25, unit: 'pens' }], interpretations: [], evidence_requests: [] }]]);
    return { ...t, tool_calls: t.tool_calls.map(c => ({ ...c, id: 'call_0' })) };
  } };
  const run = await investigate({ question: 'q', ctx: ctxFor(), provider: same, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: 8000 } });
  assert.equal(run.answer!.facts![0].status, 'validated', run.answer!.facts![0].problems.join(' '));
});

test('a refusal with no count or limit lowers the ceiling for the rest of the run, so later turns are not refused again', async () => {
  // The provider's real limit (7,000) is below the configured 8,000 and it never says so.
  class Silent extends TieredProvider {
    async complete(req: { messages: ChatMessage[]; tools: ToolSpec[]; maxTokens: number; temperature?: number }) {
      try { return await super.complete(req); } catch { throw new ProviderError('too_large', 'Request too large.', true); }
    }
  }
  const p = new Silent(heavy(), 7000);
  const run = await investigate({ question: 'q', ctx: ctxFor(), provider: p, actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: 8000 } });
  assert.equal(run.status, 'completed', run.status_detail);
  assert.ok(p.refused <= 2, `refused ${p.refused} times`);
  assert.ok((run.limits?.max_request_tokens ?? 8000) < 8000, 'the learned ceiling is recorded');
});

test('a ceiling too small for the fixed instructions is refused in settings and explained if forced', async () => {
  const s = providerFromEnv({ GROQ_API_KEY: 'k', AGENT_MAX_REQUEST_TOKENS: '6000' }).settings;
  assert.equal(s.request_token_limit, 8000); assert.match(s.reason, /from 7000 to 2000000/);
  const run = await investigate({ question: 'q', ctx: ctxFor(), provider: new TieredProvider([submit], 3000), actor: 'T', sleep: async () => {}, limits: { maxRequestTokens: 3000 } });
  assert.equal(run.status, 'provider_error'); assert.match(run.status_detail, /too small for RecallReach's fixed instructions, tool definitions and question/);
});
