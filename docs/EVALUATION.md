# Evaluation

Everything here is **automated testing on fictional fixtures** or **observed live runs** recorded on 24–25 Oct 2026. There has been **no evaluation with real users or real recall data**, and nothing here measures time saved or real-world outcomes.

**Caveat:** the same developer wrote the engine, the rules procedure, the fixtures and the answer keys, including the held-out case. The held-out key was committed before any run, so it was not tuned to results, but it was not written independently. Treat every score below as "behaves as designed on cases built to exercise it", not as independent accuracy.

## 1. Automated tests: 144 passing

`npm test` (Node 24 test runner; server tests use Node's built-in SQLite with the real migration files). Result on 26 Oct 2026: **144 tests, 144 pass, 0 fail.** Also clean: `npm run typecheck` (tsc) and `npm run lint` (ESLint; the vendored H-MEM code is excluded).

| Suite | Tests | Covers |
| --- | --- | --- |
| `tests/recall.test.ts` | 24 | Engine: conservation (total and per shipment), quarantine→return without double counting, duplicates, conflicting versions, reused references, double openings, overspend, release/reversal attempts, identity, near-miss batches, units, bad quantities, chronology, location, timestamps, corrections, CSV parsing, original rows, formula neutralisation, audit tamper detection, snapshots |
| `tests/agent.test.ts` | 21 | Agent loop with typed facts: scripted investigation, fabricated handles and wrong quantities, old free-text submissions rejected, invalid arguments, malformed JSON, missing answer, timeout, rate limits and auth, tool limit, prompt injection, rules mode on both development scenarios, unavailable source, forced final submission, follow-up citations, changes since the previous run, memory context, provider error mapping, follow-up checklist |
| `tests/facts.test.ts` | 12 | Typed-fact validator counterexamples: wrong shipment, state, unit, scope, stale snapshot, not delivered, mixed clauses and unsupported summaries, record facts, referenced-but-not-delivered handles, connected-source rows (MOCK label, external dependency), evidence-request linking, and valid facts with generated wording |
| `tests/trust.test.ts` | 6 | Regressions from the external review: the false "RR-104 60 dispensed" claim, the memory-reference bypass, connected-source-only memory (unknown → current → stale), legacy memories with no dependencies, bounded retention with dropped counts, oversized tool output (valid JSON, omitted counts, not delivered) |
| `tests/import.test.ts` | 11 | Connected-source import: keyset SQL and literal binding, 1,200 rows over 7 pages with shared timestamps, unchanged re-import, same-key correction (twice), operator-corrected conflict, page failure, count mismatch, repeated row, too large, zero rows vs failed query, equal keys from two instances, a disappeared row, legacy imports |
| `tests/boundaries.test.ts` | 14 | Atomic case + memory save (memory write failure rolls back the case; memory-version and case-version conflicts), concurrent runs, identity headers, forged headers through the local dispatcher stand-in, deadline with a fake clock (no tool after the deadline, late answer not accepted, cancellation reaches an in-flight source query, rate-limit wait past the deadline), rules-mode limits, per-provider time limits and `AGENT_TIME_LIMIT_S`, limits recorded on each run, the streamed live response (headers at once, keep-alive, saved result or `{ error, status }`), provider errors without account IDs |
| `tests/explain.test.ts` | 7 | Evidence Challenge on the drill: why RR-104 is unresolved, why approval cannot change it, which new evidence changed the result and why a reported quarantine is not a confirmed destination, why 60 dispensed need follow-up, the hypothetical preview, what each source says (which sources name RR-104, dated live reads through Zetaris, MOCK reads labelled, imports from one table grouped), no invented likelihoods |
| `tests/budget.test.ts` | 21 | Groq free-tier fitting with a simulated provider: token estimate and calibration; fitting order (results already read go first, results not yet read last); a long run kept under 8,000 tokens per request (and over it without fitting); several large results in one turn all sent in full; a submission in the same turn as new results sent back once to read them; results sent only as a summary retired and never resent in full; rejections that say why evidence was not read (same turn or summary only); smaller resends after a too-large refusal, never an identical one, and the learned ceiling recorded (stated, count-only or silent refusals); malformed tool calls retried without using the budget, then counted, still reaching the forced final answer; unique tool-call IDs; daily quota ending the run; provider error classification; settings and a ceiling too small for the fixed instructions |
| `tests/memory.test.ts` | 5 | Vendored H-MEM hashes, save/reload round trip, invalidation after new evidence, operator decisions, contradiction detection |
| `tests/http.test.ts` | 14 | Unauthenticated access, owner-only access, cross-site/non-JSON/oversized writes, concurrent updates, the demo flow over HTTP, corrections, exports, persistence after reopening, mock labelling, versioned re-import over HTTP (response read back from storage), unreachable Zetaris, the last live health check found after many later queries, the cross-source query (live only, never the mock; recorded), memory feedback |
| `tests/zetaris.test.ts` | 9 | REST request shape and row mapping, failure classification, health check, SQL-injection resistance, configuration, read-only probes, datasource setup SQL and runner, the cross-source gap query (one statement over the three tables, unsafe batch refused) |

[JUDGE_GUIDE.md](JUDGE_GUIDE.md) maps each reported counterexample to its test.

## 2. Held-out evaluation (Corvel vials)

`eval/heldout/corvel-vials.ts` is a fictional case written for evaluation only: a unit mismatch (20 boxes recorded against vials), a reused hold reference, a duplicated return, an unconfirmed destination, a near-miss batch (`CV-3319B`), a different batch (`CV-3391`), and an instruction planted in a reference field. It is not in the app's scenario list. Its answer key and a follow-up rubric were committed alone in **`1313452`**, before the engine, rules mode or any model was run on it, and the fixture and key have not been changed since (`git log -- eval/heldout/corvel-vials.ts` shows only that commit; `lib/recall/engine.ts` is also unchanged since). Other code did change after results were seen, and is labelled where it matters: the port of rules mode to typed facts and the scoring code landed in `962f15c` together with the first held-out results; the 480 s limit (`6ea93a9`) and the Groq free-tier fitting (`a07e5a2`) were made in response to the live runs below.

Results: `eval/results.json` (offline) and `eval/results-live-corvel-vials.json` (live). Methods:

- **Baseline:** an exact-batch spreadsheet filter plus SUMIF by shipment and state, with no unit, duplicate, reference or chronology checks.
- **Engine:** RecallReach's deterministic reconciliation alone.
- **Agent, rules mode:** the fixed tool-using procedure, submitting typed facts through the validator. No model.
- **Agent, live model:** Groq free tier, `openai/gpt-oss-120b`, **3 runs**, bounded at 240 s each.

| Measure | Baseline | Engine | Agent, rules mode | Agent, live (3 runs) |
| --- | --- | --- | --- | --- |
| Questions correct (of 7: unresolved, dispensed, destinations, review, near-miss, duplicates, totals) | 1 | 7 | – | – |
| Unresolved shipments with the right quantity | 1 / 3 | 3 / 3 | 3 / 3 | 0 / 3 in every run |
| Records wrongly counted | 4 | 0 | 0 | 0 (stock unchanged by every run) |
| Key facts stated as validated facts (of 5) | – | – | 5 | 0, 0, 0 |
| Unsupported claims accepted as validated | – | – | 0 | 0, 0, 0 |
| Facts submitted / validated / rejected | – | – | 12 / 12 / 0 | 3/3/0 · 0/0/0 · 0/0/0 |
| Missing evidence identified (unresolved shipments with a linked request or proposal) | – | – | 3 / 3 | 2/3 · 0/3 · 0/3 |
| Follow-up rubric points (of 12: proposed, right owner, names shipment and quantity, for 4 issues) | – | – | 12 | 6 · 0 · 0 |
| Status | – | – | completed | completed · limit reached · limit reached |
| Tool calls / model calls | – | – | 21 / 0 | 3/4 · 7/8 · 4/6 |
| Time (of which waiting on rate limits) | – | – | 2 ms | 99.6 s (89 s) · 227.8 s (200 s) · 218.7 s (203 s) |
| Tokens in / out | – | – | 0 | 18.7k/2.2k · 33.9k/2.3k · 25.5k/2.1k |

What this shows, plainly:

- The **engine** answers all seven questions on a case it was not tuned to; the spreadsheet baseline gets one. The baseline flags 60 vials in 1 shipment (CV-304); the engine finds 110 across 3. Of the 50 vials the baseline misses, 20 are hidden by a record kept in boxes instead of vials (CV-302) and 30 by a reused hold reference (CV-303). The duplicated return hides none of them.
- **Rules mode** turns the engine's answer into validated facts and well-formed follow-ups. It is a fixed procedure written by the same developer, so its score mostly confirms that procedure works on this kind of case.
- **The live model did poorly on the held-out case.** Two of three runs spent about 200 s waiting on Groq's free-tier limit (8,000 tokens per minute) and stopped at the 240 s deadline without submitting anything; the deadline handling reported them as *limit reached*, not as completed. The one completed run used only 3 tools and submitted 3 facts, all validated, but none of them was one of the 5 key facts. The validator accepted nothing false in any run, but that is a small denominator: only those 3 facts were submitted. With this provider tier the live agent is not reliable enough to quote as a result; rules mode and the engine are what the numbers support.

### 2b. Live model again, after raising the time limit to 480 s

After the first series, the Groq run time limit was raised from 240 s to 480 s (its free tier spends most of a run waiting on rate limits). Nothing else changed: same code, prompt, rules, tools and answer key (`1313452`). The first series above stays as recorded; this second series is in its own file, `eval/results-live-corvel-vials-limit-480s.json`, and each run records the limits it ran under.

| Run | Status | Time (waiting) | Tool / model calls | Tokens in / out | Key facts | Facts submitted |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | provider error: malformed tool call on the 10th model call | 221.6 s (203 s) | 8 / 10 | 45.3k / 2.7k | 0 / 5 | 0 |
| 2 | provider error: malformed tool call on the 10th model call | 255.5 s (232 s) | 8 / 10 | 47.2k / 3.3k | 0 / 5 | 0 |
| 3 | provider error: Groq's daily token cap (200,000 tokens per day) reached before the first call | 184.8 s (182 s) | 0 / 0 | 0 / 0 | 0 / 5 | 0 |

**Raising the time limit did not help.** No run came near 480 s. Runs 1 and 2 used all 10 model calls (at the time, the budget also counted calls that returned a malformed tool call) and ended on another malformed call; run 3 could not start because the day's free-tier allowance was used up. No run accepted a false fact or changed stock. The binding limits were the model-call budget with malformed tool calls, the 8,000-token per-request ceiling and the daily token cap, not time.

**What changed after this series (25–26 Oct 2026):** the runner now keeps every Groq request under 8,000 tokens and resends a smaller one if Groq still refuses it, gives malformed tool calls 3 retries per run that do not use the model-call budget, asks the model once to read results it has not seen before it submits, and ends a run at once when the daily allowance is used up (ARCHITECTURE.md). This is covered by the 21 tests in `tests/budget.test.ts` with a simulated provider. **No live run has been made with this code yet:** Groq's daily allowance was used up, so whether it improves live results on the held-out case is not known. Any such runs will be recorded as their own series.

**One unplanned run.** While the overwrite guard was being tested, a command ran the earlier evaluation script before the guard existed. It made one extra live run (240 s limit) and overwrote the first series' file; the file was restored from git and the extra run is kept in `eval/results-live-corvel-vials-unplanned-240s.json`. It ended as a provider error after 140.8 s (124 s waiting), 9 model calls and 8 tool calls, 40.9k / 2.3k tokens: Groq refused a request of 8,333 tokens as larger than the 8,000 tokens-per-minute limit (HTTP 413). 0 facts submitted.

In total the live model has had seven runs on the held-out case (three at 240 s, three at 480 s, one unplanned at 240 s); none stated a key fact.

## 3. Development fixtures

The two scenarios in the app were used during development, so they are not held out.

| Scenario | Method | Unresolved found (right quantity) | Records wrongly counted | Questions correct |
| --- | --- | --- | --- | --- |
| Missing 40 bottles (initial) | Baseline | 1/1 | 5 | 3 / 7 |
| | Engine | 1/1 | 0 | 7 / 7 |
| Missing 40 bottles (after follow-up) | Baseline | 0/0 | 5 | 3 / 7 |
| | Engine | 0/0 | 0 | 7 / 7 |
| Velora pens | Baseline | 1/3 | 10 | 1 / 7 |
| | Engine | 3/3 | 0 | 7 / 7 |

Rules mode, typed facts: Missing 40 — 13 tool calls, 6 of 6 facts validated, 3/3 key facts, 1/1 missing evidence identified, 2 follow-ups. Velora pens — 18 tool calls, 12 of 12 validated, 5/5 key facts, 3/3 missing evidence, 4 follow-ups.

## 4. Earlier live runs (24–25 Oct 2026, earlier free-text validator)

These runs used the previous design, in which the model wrote free-text claims and "verified" meant that the cited records existed and stated quantities appeared in them. An external review showed that this could accept a false claim (a quantity true for another shipment), which is why it was replaced by typed facts. The records are kept for transparency; their "verified" counts should not be quoted.

| Run | Scenario | Status | Time (waiting) | Tool calls | Model calls | Tokens in / out |
| --- | --- | --- | --- | --- | --- | --- |
| `eval/results-live-2026-10-24-run1.json` | Missing 40 | completed | 4.4 s | 2 | 3 | 7.2k / 1.1k |
| same | Velora pens | completed | 153.5 s (137 s) | 5 | 6 | 23.0k / 3.1k |
| `eval/results-live.json` | Missing 40 | completed | 6.5 s | 3 | 4 | 10.3k / 1.4k |
| same | Velora pens | completed | 221.2 s (198 s) | 9 | 10 | 41.1k / 4.0k |
| In the app, through Zetaris (25 Oct) | Missing 40 | completed | 140.1 s | 9 | 9 | 28.1k / 2.3k |

In-app runs on 24 Oct found defects that were fixed then: rate-limited retries consuming the model-call budget, proposals refusing issue IDs, tool names used as citations, and a memory-based claim that the old verifier accepted although the engine disagreed. The last one is the class of failure the typed-fact design removes (`tests/trust.test.ts`).

## 5. Through a real Zetaris instance (25 Oct 2026)

A local Zetaris 2.4.3 instance (the hackathon's local download; local instance, fictional data) had three fictional PostgreSQL source databases registered as datasources; each RecallReach query reads one source table through it. The full record is in [INTEGRATIONS.md](INTEGRATIONS.md#verification-record-25-oct-2026); `eval/zetaris-check-2026-10-25.txt` is the saved command-line check.

| Step | Observed |
| --- | --- |
| Case built only from Zetaris imports (DEMO-042) | 1,000 accepted / 900 contained / 40 awaiting containment / 60 dispensed; 4 records to review; 1 duplicate. Same as the answer key |
| Live-model investigation (earlier validator) | Completed, 140.1 s, 9 tool steps, one `query_connected_source` step against Zetaris (1 row, 401 ms) |
| New evidence in the pharmacy source, re-imported through Zetaris | 1 new row added, 6 skipped; 940 contained (94%), 0 awaiting containment |

These were recorded with the import code of the morning of 25 Oct. The import was then rebuilt as a counted, paged, versioned read (ARCHITECTURE.md) and **checked again against the same instance that evening** (`eval/zetaris-import-check-2026-10-25.md`, `eval/zetaris-read-check-2026-10-25.txt`):

| Step | Observed |
| --- | --- |
| Paged reads with a page size of 2 | Every source read completely in 2–7 pages, distinct keys equal to the COUNT; an unknown batch returned 0 rows as a successful check |
| Case built from three imports | 1,000 / 900 / 40 / 60, 4 to review, 1 duplicate (the answer key); instance recorded on each source |
| Re-import, nothing changed | 0 new, 0 changed, 6 unchanged |
| Rules-mode run on that case | Completed; 6 of 6 facts validated; case and memory saved together on local D1 |
| Follow-up row added at the source | 1 new, 6 unchanged; 940 contained, 0 available |
| The same row changed at the source (40 → 39) | 1 changed: the new version supersedes the old through a correction; 839 quarantined, 1 available; nothing double counted |
| The row removed at the source | Reported as no longer returned; not reversed; balances unchanged |

### Cross-source query through Zetaris (26 Oct 2026)

One read-only statement joining all three datasources inside Zetaris (`scripts/zetaris-cross-check.ts`; the same query runs from **Integrations → Find consignments with no downstream record**): dispatched consignments of DEMO-042 with no pharmacy stock event and no return note. Result: **1 row, RR-104, 40 bottles, "Destination pending confirmation", DISPATCH-104**, in 1,856 ms from the command line (`eval/zetaris-cross-source-2026-10-26.txt`) and 703 ms from the app. That is the same gap the engine finds from the imported records. The query gives a lead; it does not change any stock number.

## 6. Browser checks (local dev server)

25 Oct 2026, against `npm run dev` with the current code:

- Drill: 1,000 / 900 / 40 / 60. *Why this finding?* on "Locate and check 40 bottles": calculation (opening +40), "None of the 4 records held for review … names RR-104", what could change it, why approval does not, and a hypothetical preview (40 → 0 available; the destination issue stays open).
- Rules-mode investigation: COMPLETED, 6 of 6 typed facts validated, checked summary shown; the model/rules summary is labelled interpretation.
- Proposal approved: still 40. Fictional follow-up evidence: 940 contained, 0 available, 60 dispensed; 4 memory notes marked for recheck. *Why this finding?* on the destination issue explains that the reported quarantine does not name a responsible recipient and lists the follow-up record under "Added since the previous run".
- Reassessment in rules mode: 5 of 5 facts validated, including "the case available changed from 40 to 0"; memory shows SUPERSEDED notes with recheck notes quoting them.
- Live-model run in the app with the current code (Groq free tier, fresh drill case): completed in 213.7 s, of which 189 s waiting on rate limits; 7 tool calls, 10 model calls, 36.2k in / 3.1k out tokens; 6 of 6 typed facts validated (RR-104 40 available, the case total, the opening record's report and status, the stock and destination issues); 1 follow-up proposed. It is the run shown in the deck. It did not state the RR-103 dispensing fact.
- Streamed live response with the 480 s limit (25 Oct 2026, after the second held-out series, while Groq's daily cap was nearly used up): response headers after 60 ms, 31 keep-alive spaces, then the saved result after 464 s; the run stopped as *limit reached* at the 480 s limit after 454 s of rate-limit waiting (2 model calls, 7.4k / 0.1k tokens). A check of the connection handling, not an evaluation run.
- Older cases: runs made with the earlier validator render under "EARLIER RUN · FREE-TEXT FORMAT" with a note that their "verified" label only meant citations existed; their memories show CURRENT where dependencies can be checked and UNKNOWN where none were recorded.

24 Oct 2026 checks (still valid for unchanged screens): exports download with readable content, dialogs take focus and close on Escape, no horizontal overflow at 375 px, the production build boots under Wrangler, and forged identity headers are accepted when the Worker runs **without** the Sites dispatcher (see DEPLOYMENT.md). Not done: screen-reader testing, an automated contrast audit, a physical phone.

## 7. Token use and cost

All live calls used Groq's free tier, as in earlier sessions (no cost estimate is configured, and the account's billing page was not checked in this session). Totals so far: about 478k input and 41k output tokens (seven in-app runs, the four earlier evaluation runs, the seven held-out runs, and a few smoke checks). Free-tier limits: 8,000 tokens per minute and 200,000 tokens per day per model; the daily cap was reached on 25 Oct 2026.
