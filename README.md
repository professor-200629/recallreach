# RecallReach

**When a medicine batch is recalled, RecallReach finds the stock that may still reach a patient, shows exactly which records every number comes from, and hands the follow-up to the people who must act.**

> The engine owns every number. The agent explains it. People decide what happens next.

Built solo by Balu for the [Open Agent Hackathon 2026](https://hackathon.genai.works/event/open-agent-hackathon-2026) (GenAI.Works), track *The Agent That Can Explain Why*. All data in this repository is fictional.

> Status: hackathon prototype. Tested on fictional fixtures only. Not validated with real recall coordinators or pharmacists, and not ready for operational use. See [Known limitations](#known-limitations).

## Results at a glance (fictional fixtures)

On the **held-out case** (`eval/heldout/corvel-vials.ts`; its answer key was committed in `1313452` before anything was run on it), a spreadsheet-style filter flags **60 vials in 1 shipment**. The engine finds **110 vials across 3 shipments**. Of the 50 the filter misses, 20 are hidden by a record kept in boxes instead of vials and 30 by a reused hold reference.

| Method | Unresolved shipments found, with the right quantity (of 3) | Key facts stated as validated facts (of 5) |
| --- | --- | --- |
| Spreadsheet filter (exact batch + SUMIF; baseline) | 1 | – |
| Engine (deterministic reconciliation, no model) | 3 | – |
| Agent in **rules mode** (fixed procedure, **no language model**) | 3 | 5 |
| Agent with a **live model** (Groq free tier, `openai/gpt-oss-120b`), 7 runs | 0 in every run | 0 in every run |

The live model is the weak part. In 7 held-out runs it submitted 3 facts in total: all 3 were true, none was a key fact, and no false fact was accepted. Six of the seven runs ended before submitting anything: two at the time limit while waiting on Groq's free-tier rate limits, two on malformed tool calls, one on a request too large for the free tier and one on the daily token cap. On the drill used in the demo ("the missing 40 bottles"), the filter does find RR-104's 40 bottles but gets the totals wrong: -219 bottles available, 5 records miscounted, 3 of 7 questions right. The engine gets 7 of 7. The same developer wrote the engine, the fixtures and the answer keys, so these numbers show the system behaves as designed, not independent accuracy. Every run, including the failures, is in [docs/EVALUATION.md](docs/EVALUATION.md).

## The problem

When a batch of medicine is recalled, the distributor's dispatch log, each pharmacy's stock system and the returns desk all hold part of the picture. They disagree, duplicate each other, use different units, and sometimes omit the one record that matters. A coordinator must find out quickly which stock may still reach a patient, and must be able to show why they believe it.

It is a routine job, not a rare one. FDA's public openFDA data lists **765 drug recall enforcement report records dated 2025** (49 Class I, 655 Class II, 61 Class III; [query](https://api.fda.gov/drug/enforcement.json?search=report_date:[20250101+TO+20251231]&limit=1) run on 26 Oct 2026; one recall can produce several records). FDA's recall guidance, [21 CFR 7.42](https://www.ecfr.gov/current/title-21/part-7/section-7.42), describes effectiveness checks that confirm each consignee was notified and acted. The [EU Good Distribution Practice guidelines](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:52013XC1123(01)) (2013/C 343/01, §6.5) say distribution records should be readily accessible to whoever runs the recall. India's CDSCO publishes [monthly lists](https://cdsco.gov.in/opencms/opencms/en/Notifications/nsq-drugs/) of drug samples found Not of Standard Quality or spurious. RecallReach is a prototype for one step of that work, reconciling the records for one batch, and makes no regulatory or compliance claim.

**Who it is for (illustration, fictional).** Asha is a recall coordinator at a regional distributor. A batch of oral solution is recalled. Her dispatch log says 1,000 bottles went to four destinations; the pharmacies' stock systems and the returns desk account for 960 of them, with a duplicated return, a record in the wrong unit and a hold reference that names no shipment. She needs to know which 40 bottles are not accounted for, who to ask, and what evidence would close the gap, and she needs to be able to show her working. That is the drill in the demo.

**Next step beyond the hackathon:** a supervised mock recall with one distributor's recall coordinator or a supervising pharmacist, on a past closed recall or a synthetic exercise in their real record formats, compared against their current process ([docs/PILOT_PLAN.md](docs/PILOT_PLAN.md)). No pilot has taken place yet.

## What it does

For one manufacturer + product + batch, counted in one unit:

1. **Reconciles** imported records into mutually exclusive states (available, quarantined, returned, dispensed) with a deterministic engine. It catches duplicates, conflicting versions, reused references, double openings, wrong units, ambiguous or future timestamps, movements before shipment, location mismatches and overspends. Uncertain records stay visible with the reason they were not counted. Near-miss batch numbers are flagged, never counted.
2. **Investigates** with a bounded, tool-using agent. Ask *"Why are 40 bottles still unresolved, and what evidence would resolve this?"* and the agent chooses among 10 read-only tools: reconciliation, shipment ledger, original source row, reference trace, review queue, memory, change comparison, and connected sources through Zetaris. It can state a checkable fact only as a **typed fact** (this shipment, this stock state, this quantity, this unit, this evidence snapshot), and RecallReach checks every field against the engine and the records the agent actually received in that run, then writes the wording itself. A number that is true somewhere else in the case is not enough. The model's own prose is shown separately as unverified interpretation.
3. **Explains why.** *Why this finding?* opens an Evidence Challenge for any validated fact or open issue: the step-by-step calculation, records not counted and why, what the evidence does not show, what evidence could change the conclusion, why an approval does not, and a labelled hypothetical preview. All of it is derived from records and engine statuses; no likelihoods are invented.
4. **Proposes follow-up** (who should do what, and which evidence would resolve it) for a person to approve or reject. Approval never changes stock.
5. **Reassesses** when evidence changes. Evidence snapshots mark earlier conclusions stale. Investigation memory (Meterless H-MEM) stores validated facts with what they depend on, supersedes them with recheck notes when that changes, and shows anything it cannot recheck as *unknown*, never as current.
6. **Keeps an accountable trail:** operator corrections that preserve the original record, a hash-chained activity log, and Markdown/CSV/JSON exports.

Without model credentials, **rules mode** runs a fixed procedure with the same tools and the same typed-fact validator, clearly labelled as using no language model.

## Sponsor technology

| | How it is used | Status |
| --- | --- | --- |
| **Zetaris** | The three separately owned source systems (distributor ERP, pharmacy stock, returns desk) are registered as Zetaris datasources. RecallReach reads them through the Zetaris REST SQL endpoint with code-owned, read-only SELECTs that map each system's native columns, one source table per query. Imports are complete, counted, paged reads; a row changed at the source becomes a new version, never a double count. Every query's latency and result is recorded. | **Connected** to a local Zetaris 2.4.3 instance (the hackathon's local download; local instance, fictional data) and verified with real queries on 25 Oct 2026: the connection check, case imports, and a follow-up re-import (900 → 940 contained) all went through Zetaris. One live agent run (earlier answer format) queried Zetaris once; the row it read was already in the case. A labelled mock remains for machines without Zetaris. |
| **Meterless H-MEM** | Investigation memory across runs: validated facts and operator decisions with their evidence dependencies, provenance, trust ledger, supersession and contradiction detection. | **In use.** Unmodified reference engine (Apache-2.0); upstream conformance suite 13/13. Retention: newest 200 memories and 800 ledger entries per case, with the dropped counts shown. |

Details and setup: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## Requirements

- Node.js **22.13 or later** (developed on Node 24.14 on Windows 11) and npm.
- Nothing else for rules mode, the tests and the offline evaluation.
- Optional: a Groq API key for live model runs (free tier used; see [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)).
- Optional: Docker and the hackathon's local Zetaris 2.4.3 download, to read the fictional source systems through Zetaris.

## Quick start

```bash
npm ci
cp .dev.vars.example .dev.vars   # add GROQ_API_KEY for live runs (optional)
npm run build && npm run db:migrate:local
npm run dev
```

Open `http://127.0.0.1:5173/signin-with-chatgpt?return_to=/` (a local test sign-in that only works on your own machine; the dev server listens on 127.0.0.1, so `localhost` may not connect), then **Explore a mock recall**. Full instructions: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

```bash
npm test          # automated tests (count in docs/EVALUATION.md)
npm run eval      # baseline vs engine vs rules-mode agent, including the held-out case; rewrites eval/results.json
```

## Documentation

- [Architecture and data flow](docs/ARCHITECTURE.md): stock model, agent loop, trust boundaries
- [Integrations](docs/INTEGRATIONS.md): Zetaris, Meterless H-MEM, model provider; setup and verification
- [Evaluation](docs/EVALUATION.md): test inventory, held-out evaluation, live runs
- [Reproduction guide for judges](docs/JUDGE_GUIDE.md) and [operator test script](docs/OPERATOR_TEST.md)
- [Demo script](docs/DEMO_SCRIPT.md)
- [Submission notes](docs/SUBMISSION.md): description, judging checklist, pre-existing work
- [Pilot plan](docs/PILOT_PLAN.md)
- [Deployment](docs/DEPLOYMENT.md)

## Principles

Unknown does not mean safe. A record outside the alert is not a safety clearance. Exact identity is manufacturer + product + batch. Units are never converted. Imported records report actions; they do not prove them. Approval is not completion. There is no "recall complete" conclusion. A fact is shown as validated only if every typed field matches the engine and evidence the agent retrieved; everything else is interpretation.

## Known limitations

- **Fictional data only.** There has been no real-user pilot and no feedback from coordinators or pharmacists yet.
- **Zetaris was verified on one local instance only**, with fictional source databases. It has not been tested against a hosted Zetaris cluster or real source systems, and a hosted RecallReach cannot reach a Zetaris running on a laptop (see DEPLOYMENT.md).
- **Live model runs use Groq's free tier** (8,000 tokens per minute, 200,000 per day). A live run waits on those limits for most of its time and keeps every request under 8,000 tokens; it stops at 8 minutes (configurable), at 10 model calls, or as soon as the day's allowance is used up. On the held-out case the live model has not produced a useful answer in seven runs, at either time limit (EVALUATION.md records every run).
- **What "validated" means, and does not.** The validator checks the seven typed fact forms field by field; it cannot check free text, so the model's summary and interpretations are always shown as unverified. A validated fact is as good as the engine and the imported records: it says what the records report, not what physically happened.
- **The evaluation is not independent.** The same developer wrote the engine, the fixtures and the answer keys, including the held-out case (whose key was committed before any run). Results show behaviour on fictional cases, not real-world accuracy.
- **Memory retention is bounded:** the newest 200 memories and 800 ledger entries per case are kept; older ones are dropped and counted.
- **Not deployed.** Everything was run locally. Hosting is planned through OpenAI Sites (the existing project identity). Sign-in trusts identity headers set by the Sites dispatcher, so the Worker must not be exposed any other way (DEPLOYMENT.md, *Trust boundary*).
- One batch and one unit per case; no transfers between locations; no team sharing; no automated alert ingestion.
- The audit hash chain checks internal consistency only; it is not tamper-proof storage.
- H-MEM is a reference implementation ("not a production library") with a deterministic hash embedder.
- No patient data is supported, and no messages are ever sent.

## Licence and credits

Application code © 2026 Balu. The vendored Meterless H-MEM reference engine (`vendor/meterless-hmem`) is Apache-2.0. The Vinext/Sites starter, the shadcn/ui components and the vendored Sites Vite plugin are pre-existing third-party components (see `scripts/vite/sites-vite-plugin.LICENSE` and `vendor/shadcn-tailwind-4.13.0.LICENSE.md`).
