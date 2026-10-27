# Submission notes: Open Agent Hackathon 2026

RecallReach is my entry to the [Open Agent Hackathon 2026](https://hackathon.genai.works/event/open-agent-hackathon-2026) (GenAI.Works), primary track **Track 02: The Agent That Can Explain Why**. I built it alone, inside the build window. All data in it is fictional.

> The engine owns every number. The agent explains it. People decide what happens next.

## Links

- Repository: <https://github.com/professor-200629/recallreach>
- Slide deck: submitted as a PDF with the entry
- Demo video (3:35, unlisted on YouTube): <https://youtu.be/EU9kqHnXcvg>
- Online demo, no sign-in (rules mode only, fictional data, a sandbox per browser): <https://recallreach-demo.balu04t.workers.dev>
- How to reproduce the results: [JUDGE_GUIDE.md](JUDGE_GUIDE.md)

## Short description

> RecallReach helps a medicine recall coordinator find affected stock that is still unresolved and explain why. A deterministic engine reconciles distributor dispatches, pharmacy stock events and returns into mutually exclusive states, and refuses to count duplicates, conflicting versions, wrong units, ambiguous timestamps or near-miss batch numbers, saying why. A bounded, tool-using agent investigates questions such as "Why are 40 bottles still unresolved?". It retrieves the actual records through read-only tools and can state facts only in typed form (this shipment, this state, this quantity, this unit); RecallReach checks every field against the engine and the evidence the agent received, and writes the wording itself. "Why this finding?" shows the calculation, what was not counted, and what evidence could change the answer. Follow-ups need a person's approval, which never changes stock. Meterless H-MEM remembers validated facts with their dependencies; Zetaris gives read-only access to three fictional databases representing separately owned systems. All data is fictional.

## How Zetaris and Meterless are integrated (rule 6.4)

**Zetaris** (local instance, fictional data). The distributor ERP, the pharmacy stock system and the returns desk are three separate fictional PostgreSQL databases, each registered as a datasource in a local Zetaris 2.4.3 instance (the hackathon's local download). RecallReach reads them through the Zetaris REST SQL endpoint with code-owned, read-only, bounded SELECTs that map each system's native columns; each import reads one source table. On the Integrations screen, one further read-only query joins all three datasources inside Zetaris and lists consignments of the case's batch that the distributor dispatched but neither the pharmacy stock system nor the returns register mentions. It is a lead for follow-up, not a stock figure: the engine still reconciles each source's imported records on their own. An import is a complete read: a COUNT, then keyset pages, and if any page fails nothing is imported. Each row is identified by instance, table and row key and compared by content: unchanged rows are skipped, a row changed at the source becomes a new version that supersedes the old one, and a row the source no longer returns is reported, not reversed. Every query records its latency and outcome, and the agent can query a connected source as one of its tools.

Verified on 25 Oct 2026 against that local instance: `verify.sh` 9/9; the in-app connection check passed (198 ms); a case built entirely from Zetaris imports matched the answer key (1,000 accepted, 900 contained, 40 awaiting containment, 60 dispensed); a new quarantine record added to the pharmacy source and re-imported through Zetaris moved the case from 900 to 940 contained. The rebuilt import was checked against the same instance that evening (complete paged reads, a row changed in place imported as a new version, a removed row reported). One live agent run, in the earlier answer format, queried Zetaris once; the row it read was already in the case. On 26 Oct 2026 the cross-source query returned exactly one consignment through the same instance, RR-104 with 40 bottles at "Destination pending confirmation", which is the gap the engine finds (1,856 ms from the command line, `eval/zetaris-cross-source-2026-10-26.txt`; 703 ms from the app). It has not been tested against a hosted Zetaris cluster or real source systems. Full record: [INTEGRATIONS.md](INTEGRATIONS.md), `eval/zetaris-check-2026-10-25.txt`, `eval/zetaris-import-check-2026-10-25.md`.

**Meterless.** The H-MEM reference engine (upstream commit `1742dec`, 19 Oct 2026, Apache-2.0, upstream conformance 13/13) is vendored unmodified and is RecallReach's investigation memory. Validated facts, in RecallReach's own wording, and operator decisions are stored with provenance and their dependencies: a shipment, a record, the case, or a Zetaris row with its content hash and capture time. Retrieval uses H-MEM ranking. When a dependency changes, H-MEM supersession lineage replaces the memory with a recheck note; a memory whose dependencies cannot be rechecked is shown as *unknown*, never as current. Conflict detection surfaces contradictions without resolving them automatically. Operator "mark as wrong" feedback uses H-MEM's feedback deltas and trust ledger. Retention is bounded: the newest 200 memories and 800 ledger entries per case, with the dropped counts shown.

**What is different.** The agent cannot simply assert a fact. Facts are typed and checked field by field against the engine and the evidence the agent actually received, and RecallReach writes the wording; the model's own prose stays visibly separate as unverified interpretation. Memory and source queries are subordinate to evidence: neither can change a stock number, and memory that cannot be rechecked is labelled unknown.

**Cursor:** not used. **NVIDIA:** not used. (The code has an `nvidia` provider preset, but it has never been run.)

**Model and cost.** Live runs used Groq's free tier with `openai/gpt-oss-120b`, at no cost. Without a model key, rules mode runs a fixed procedure through the same tools and validator and is labelled as using no language model.

## Results, honestly

On the held-out case (answer key committed in `1313452` before any run), a spreadsheet-style filter finds 1 of 3 unresolved shipments (60 vials in 1 shipment); the engine and rules mode find all 3 (110 vials). The live model stated 0 of the 5 key facts in 10 runs, as scored. Across those runs it submitted 6 facts, all true and none of them key, and no false fact was accepted. In the latest series, run after changes made in response to the earlier runs, two of three runs ended on Groq's per-minute token limit; the one that completed named all three unresolved shipments with the right quantities, but as open-issue facts, which the scorer (fixed before the runs) does not count. On a second held-out case, written after those runs and committed in `9237cc1` before anything ran on it, the filter finds 0 of 3 unresolved shipments and the engine all 3 (260 packs, 7 of 7 questions); rules mode states 5 of 5 key facts. A live series on it is scheduled for 27 Oct 2026, 17:25 UTC. The same person wrote the engine, the fixtures and the answer keys, so these are not independent accuracy figures. Details, including every failed run: [EVALUATION.md](EVALUATION.md).

One medical shop owner tried the online demo informally on 27 Oct 2026. Their main point, that "available" could sound safe to sell, was fixed the same day: the app now says "awaiting containment" ([EVALUATION.md §8](EVALUATION.md)). This is one person, not a usability study.

## Pre-existing work (rules 4.2 and 5.4)

Created inside the build window:

- The RecallReach application code. The first prototype was written on 23 Oct 2026, about 20:30–20:52 UTC, in an earlier AI-assisted coding session built on the OpenAI Sites starter, and extended from 24 Oct 2026 (git history from commit `c88ec88`).

Pre-existing components:

- OpenAI Sites Vinext starter (project scaffold, `scripts/`, vendored Sites Vite plugin under its MIT licence).
- shadcn/ui components (`components/ui/*`) and the vendored shadcn Tailwind CSS.
- Meterless H-MEM reference engine (upstream commit `1742dec`, 19 Oct 2026, Apache-2.0), vendored unmodified.
- Open-source npm dependencies (`package.json`).

AI assistance: the code was written with AI coding assistants (the earlier session, then Claude Code from 24 Oct). Rule 5.5 allows generated code; I am responsible for it.

## Where to find the evidence for each judging criterion

| Criterion (points) | Evidence in the repository |
| --- | --- |
| Impact (30) | README "Results at a glance" and "The problem"; [PILOT_PLAN.md](PILOT_PLAN.md); principles enforced in `lib/recall/engine.ts` and `lib/recall/agent/validate.ts` |
| Technical (20) | [ARCHITECTURE.md](ARCHITECTURE.md); automated tests (`npm test`, counts in EVALUATION.md); [EVALUATION.md](EVALUATION.md); [JUDGE_GUIDE.md](JUDGE_GUIDE.md) |
| Innovation (15) | Typed facts (`lib/recall/agent/facts.ts`), the Evidence Challenge "Why this finding?" (`lib/recall/explain.ts`), dependency-tracked memory with an honest *unknown* (`lib/recall/memory/hmem.ts`); tests in `tests/facts.test.ts`, `tests/trust.test.ts`, `tests/explain.test.ts` |
| Demo (15) | The demo video; [DEMO_SCRIPT.md](DEMO_SCRIPT.md) |
| Product & UX (10) | `components/recall/*`; the online demo; browser checks and one informal outside try (EVALUATION.md §6, §8); [OPERATOR_TEST.md](OPERATOR_TEST.md) |
| Sponsor tech (10) | [INTEGRATIONS.md](INTEGRATIONS.md) (verification record); `eval/zetaris-check-2026-10-25.txt`; the Integrations screen; `vendor/meterless-hmem/VENDORED.md` |

## Rules this entry was checked against

Checked on the official event page on 24 Oct 2026. The organiser may change details (rule 10.1).

| Item | Official text (summarised) |
| --- | --- |
| Deadline | 27 Oct 2026, 23:45 UTC (28 Oct, 05:15 IST) |
| Build window | 22 Oct 00:00 UTC to 27 Oct 23:45 UTC; pre-existing components must be declared (4.2) |
| Sponsor technology | 5.1: "Every submission must integrate Zetaris and Meterless." |
| Required items (6.1–6.4) | 1–4 minute demo video; slide deck; GitHub repository with all code and a README (setup, usage, dependencies); explanation of the Zetaris and Meterless integration, Cursor use and NVIDIA use |
| Judging | Impact 30, Technical 20, Innovation 15, Demo 15, Product & UX 10, Sponsor tech 10 |
