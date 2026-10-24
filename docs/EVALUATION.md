# Evaluation

Everything here is **automated testing on fictional fixtures** or **observed live runs** recorded on 24 Oct 2026. There has been **no evaluation with real users or real recall data**, and nothing here measures time saved or real-world outcomes.

Important caveat: the same developer wrote the engine, the fixtures and the answer keys. Fixture scores show that RecallReach behaves as designed on cases built to exercise those rules; they are not independent accuracy measurements.

## 1. Automated tests: 65 passing

`npm test` (Node 24 test runner; server tests use Node's built-in SQLite with the real migration files). Result on 24 Oct 2026: **65 tests, 65 pass, 0 fail.** Also clean: `npm run typecheck` (tsc) and `npm run lint` (ESLint; the vendored H-MEM code is excluded).

| Suite | Tests | Covers |
| --- | --- | --- |
| `tests/recall.test.ts` | 24 | Stock conservation (total and per shipment), quarantine→return without double counting, duplicates, conflicting versions, reused references, double openings, overspend, release/reversal attempts, identity matching, near-miss batches, units, fractional/negative/zero/implausible quantities, chronology, location, future and timezone-less timestamps, the correction workflow, CSV parsing, original-row retrieval, formula neutralisation, audit tamper detection, evidence snapshots and staleness |
| `tests/agent.test.ts` | 20 | Tool schemas; a scripted investigation; fabricated citations and unsupported quantities; invalid arguments; malformed JSON; missing structured answer; timeout; rate-limit and auth handling; tool-call limit; prompt injection in source text; rules mode on both scenarios; unavailable connected source; budget handling and forced final submission; citable comparisons and memories; memory-only and contradicting claims; provider error mapping; follow-up checklist |
| `tests/memory.test.ts` | 5 | Vendored H-MEM files match upstream hashes; save/reload round trip including the trust ledger; invalidation after new evidence (superseded, not deleted); operator decisions as long-term memory; contradictions kept and reported |
| `tests/http.test.ts` | 11 | Unauthenticated access; owner-only reads and writes (SQL-level too); cross-site/non-JSON/oversized writes; concurrent updates (409, nothing lost); the full demo flow over HTTP; corrections; export downloads and content; persistence after reopening the database; mock source labelling; unreachable Zetaris; memory feedback |
| `tests/zetaris.test.ts` | 5 | The documented REST request shape, row mapping and exponent numbers; failure classification; health check; SQL-injection resistance; configuration validation |

The required verification list maps to these as follows:

| Requirement | Test(s) |
| --- | --- |
| Conservation of stock quantities | recall: sample reconciles…, conservation holds per shipment… |
| Duplicate and conflict handling | recall: conflicting event versions…, different IDs cannot count…, a second opening record… |
| Identity and unit checks | recall: wrong batch…, case and outer whitespace…, near-miss…, unit mismatch… |
| Chronology and invalid movements | recall: movement before shipment…, future events…, timestamps without a timezone…, overspending…, releasing held stock… |
| CSV parsing and formula protection | recall: CSV supports…, CSV export neutralizes…; http: exports download… |
| Audit tamper detection | recall: audit verifies… |
| Case ownership and unauthorised access | http: unauthenticated…, cases are private… |
| Concurrent updates | http: concurrent updates… |
| Persistence after a fresh reload | http: data persists after the database is reopened…; memory: memory state survives… |
| Invalid agent tool arguments | agent: invalid tool arguments…, repeated malformed JSON… |
| Prompt injection inside source text | agent: instructions hidden in source text… |
| Unavailable sponsor sources | agent: an unavailable connected source…; http: an unreachable Zetaris instance… |
| LLM timeout or malformed output | agent: a model that never responds…, an answer without submit_findings…, the provider maps HTTP errors… |
| Citation correctness | agent: fabricated citations…, comparisons and memories are citable…, memory alone cannot verify… |
| Memory invalidation after corrected evidence | memory: new evidence invalidates…; http: the demo flow… |
| Real export downloads and readable content | http: exports download…; browser check below |

## 2. Fixture comparison with a batch-lookup baseline

`npm run eval` → `eval/results.json`. Both methods see the same imported records.

- **Baseline:** what an exact-batch spreadsheet filter plus SUMIF does. It keeps rows whose batch text equals the alert batch, sums openings per shipment, and subtracts every movement into quarantined, returned or dispensed. It has no unit, duplicate, chronology, reference or identity checks.
- **RecallReach:** the deterministic engine (rules v2). The questions are scored against hand-written answer keys in `lib/recall/sample.ts`.

| Scenario | Method | Unresolved shipments found (recall / precision) | Records wrongly counted | Questions correct |
| --- | --- | --- | --- | --- |
| Missing 40 bottles (initial) | Baseline | 1/1 (1.00 / 1.00) | 5 | 3 / 7 |
| | RecallReach | 1/1 (1.00 / 1.00) | 0 | 7 / 7 |
| Missing 40 bottles (after follow-up) | Baseline | 0/0 | 5 | 3 / 7 |
| | RecallReach | 0/0 | 0 | 7 / 7 |
| Velora pens (second scenario) | Baseline | **1/3** (recall 0.33) | 10 | 1 / 7 |
| | RecallReach | 3/3 (1.00 / 1.00) | 0 | 7 / 7 |

The seven questions are: unresolved shipments and quantities, dispensed by shipment, unconfirmed destinations, records needing review, near-miss batch records, duplicates, and source-reported totals. On the second scenario the baseline misses VS-202 and VS-203, because double-counted openings and over-counted movements hide their gaps.

## 3. Investigation runs on the fixtures

Rules mode (no model), from `eval/results.json`:

| Scenario | Tool calls | Time | Findings verified | Unresolved shipments stated correctly | Follow-ups proposed |
| --- | --- | --- | --- | --- | --- |
| Missing 40 | 13 | 16 ms | 4 / 4 | 1 / 1 | 2 |
| Velora pens | 18 | 2 ms | 12 / 12 | 3 / 3 | 4 |

Live model: Groq free tier, `openai/gpt-oss-120b`, one run per scenario, so treat these as anecdotes rather than statistics. Cost charged: **$0** (free tier).

| Run | Scenario | Status | Time (waiting on rate limits) | Tool calls | Model calls | Tokens in / out | Findings verified | Unresolved shipments stated correctly | Follow-ups proposed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (`eval/results-live-2026-10-24-run1.json`) | Missing 40 | completed | 4.4 s | 2 | 3 | 7.2k / 1.1k | 1 / 1 | 1 / 1 | 0 |
| 1 | Velora pens | completed | 153.5 s (137 s) | 5 | 6 | 23.0k / 3.1k | 3 / 3 | 3 / 3 | 0 |
| 2, final code (`eval/results-live.json`) | Missing 40 | completed | 6.5 s | 3 | 4 | 10.3k / 1.4k | 1 / 2 | 1 / 1 | 1 |
| 2 | Velora pens | completed | 221.2 s (198 s) | 9 | 10 | 41.1k / 4.0k | 3 / 3 | 3 / 3 | 1 |

"Stated correctly" means a verified finding names the shipment and its exact unresolved quantity. Run 2 includes the follow-up checklist added after run 1, which is why it proposes follow-ups. The live model is noticeably less thorough than rules mode on the first scenario (2–3 tools against 13).

## 4. Live runs in the app (observed, 24 Oct 2026, all on the fictional drill)

These runs found real defects, which were fixed and covered by tests:

| # | Question | Outcome | What it showed |
| --- | --- | --- | --- |
| 1 | Why are 40 bottles still unresolved…? | **Limit reached** after 85 s, 7 tool calls, 12 model calls (20.4k in / 1.6k out tokens), 74 s waiting on rate limits, no findings | Rate-limited retries were consuming the model-call budget. Fixed: 429s no longer count, and the final call is forced to `submit_findings` when the budget runs low. |
| 2 | Same | Completed, 130 s, 10 tool steps, 10 model calls (27.8k / 2.7k), 1/1 finding verified, 1 evidence gap, 1 proposal | One proposal was rejected because it cited an issue ID (`stock:RR-104`), which findings allowed but proposals did not. Fixed. |
| 3 | What changed since the previous run…? (after follow-up evidence) | Completed, 141 s, 0/4 findings verified | The reasoning was correct, but the model cited tool names instead of identifiers. The verifier correctly refused them. Fixed: comparisons (`D1`) and memories became citable, and tool-name citations get a specific explanation. |
| 4 | Same | Completed, 147 s, 2/2 "verified", but one claim was **wrong**: it said the 40 bottles were still unresolved, based on a recheck memory, while the engine showed 0 | A verifier gap. Fixed: memory-only claims stay unverified, and present-tense "N unresolved" claims are checked against current balances (test added). The bad memory was marked wrong in the UI with H-MEM feedback. |

Live run quality varies from run to run: some runs are thorough, others stop after 2–3 tools, and before the checklist was added none proposed follow-ups. The verifier labels what is supported; it does not make a weak run thorough.

## 5. Browser checks (local dev server, Chrome-based pane)

Done by hand on 24 Oct 2026 against `npm run dev`:

- Drill end to end: 1,000 accepted / 900 contained (90%) / 40 / 60 → live agent investigation → proposal approved, **still 40** → fictional follow-up evidence → **940 contained (94%), 0 available, 60 dispensed**. Dispensed and unconfirmed-destination follow-ups stayed open. The staleness banner appeared, and 3 memory notes were marked for recheck.
- Second scenario: an instruction hidden in E-14's reference is found by the *Instruction-like text* filter. Correcting E-10's timezone-less timestamp via **Correct this record** superseded the original and recalculated: available 47 → 35, quarantined 280 → 292.
- Exports fetched from the browser: Markdown, CSV and JSON returned HTTP 200 with `attachment` filenames and readable content (the files were not saved to disk).
- Integrations screen: Zetaris showed `MOCK · NOT ZETARIS`, every check was labelled mock, and **Run connection check** recorded a mock health entry.
- Dialogs: focus moves into the dialog on open; Escape closes it.
- Phone width: at 375 px no element was wider than the viewport, and navigation shows 5 short labels. The pane's device emulation kept reverting to 590 px, so dialog layout was checked at 590 px (17 px gutters). **Not tested on a physical phone.**
- Production build: `npm run build` succeeds, and the built Worker boots under Wrangler/workerd (`/api/integrations` returns 401 without sign-in). The same check confirmed that **forged identity headers are accepted when the Worker runs without the Sites dispatcher**; see DEPLOYMENT.md.

Not done: screen-reader testing, automated contrast audit, and testing on a real phone or tablet.

## 6. Token use and cost

All live calls used Groq's free tier: about 195k input and 21k output tokens in total across the four in-app runs, the two evaluation runs, two terminal smoke runs and three tiny header checks. **$0 charged.** Free-tier limit: 8,000 tokens per minute per model, so live runs take 1–3 minutes.
