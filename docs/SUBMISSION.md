# Submission notes — Open Agent Hackathon 2026

Checked against the official event page on **24 Oct 2026** (https://hackathon.genai.works/event/open-agent-hackathon-2026, rules sections expanded). Recheck the page, the participant dashboard and Discord announcements before submitting. The organiser may change details (rule 10.1).

## Key facts from the official rules

| Item | Official text (summarised) |
| --- | --- |
| Deadline | Submissions close **27 Oct 2026, 23:45 UTC** (28 Oct, 05:15 IST). Hard deadline. |
| Build window | 22 Oct 00:00 UTC to 27 Oct 23:45 UTC. "Work committed before the window opens is not eligible, except for clearly declared pre-existing components" (4.2). |
| Tracks | Pick exactly one primary track (3.2); you can change it before the deadline (3.3). |
| Sponsor tech | **5.1: "Every submission must integrate Zetaris and Meterless."** The page's About text only says teams are "encouraged" to use sponsor technology; the rules section is stricter, so treat both as required for every track. |
| Required items (6.1–6.4) | 1–4 minute demo video (main workflow, how the agent solves the challenge, key features, how Zetaris and Meterless are integrated); slide deck (problem and users, solution, agent workflow/architecture, stack, Zetaris and Meterless use, what was unique, product visuals, future work); GitHub repository with all code and a README (setup, usage, dependencies); explanation of the Zetaris and Meterless integration, of Cursor use if any, and of where NVIDIA technology contributes. |
| Models | Any model, including closed-source and paid APIs (5.3, FAQ). Declare pre-existing work. |
| Judging | Impact 30, Technical 20, Innovation 15, Demo 15, Product & UX 10, Sponsor tech 10; at least three judges; ties broken on Impact, then submission time. |
| Results | 6 Nov 2026, 16:00 UTC (21:30 IST). |

**Unresolved or not stated:** repository visibility (the rules say "a GitHub repository" but not public or private; the repo is currently **private**, so judges cannot open it until you make it public or share it). The submission form's exact fields and the participant dashboard were not visible to me. Meterless's own site gives different hackathon dates (15–20 Oct); the organiser's page (22–27 Oct) takes precedence.

## Recommended track

**Track 02 — The Agent That Can Explain Why.** The brief, "investigate complex questions across multiple data sources, connect findings, and produce evidence-backed answers or recommendations", matches the product closely. Not Wildcard: RecallReach was built inside the window, and Wildcard is for extending an existing project.

## Short description (≈150 words)

> RecallReach helps a medicine recall coordinator find affected stock that is still unresolved and explain why. A deterministic engine reconciles distributor dispatches, pharmacy stock events and returns into mutually exclusive states, and refuses to count duplicates, conflicting versions, wrong units, ambiguous timestamps or near-miss batch numbers, saying why. A bounded, tool-using agent investigates questions such as "Why are 40 bottles still unresolved?". It retrieves the actual records through read-only tools and can state facts only in typed form (this shipment, this state, this quantity, this unit); RecallReach checks every field against the engine and the evidence the agent received, and writes the wording itself. "Why this finding?" shows the calculation, what was not counted, and what evidence could change the answer. Follow-ups need a person's approval, which never changes stock. Meterless H-MEM remembers validated facts with their dependencies; Zetaris gives read-only access to separately owned source systems. All data is fictional.

## How Zetaris and Meterless are integrated (for 6.4)

- **Zetaris:** RecallReach treats the distributor ERP, pharmacy stock systems and returns desk as separate datasources federated by Zetaris. It queries them through the Zetaris REST SQL endpoint with code-owned, read-only, bounded SELECTs that map each system's native columns. An import is a complete read (a COUNT, then keyset pages; any failed page imports nothing). Each row is identified by instance, table and row key and compared by content: unchanged rows are skipped, a row changed at the source becomes a new version that supersedes the old one, and a row the source no longer returns is reported, not reversed. Every check records latency and outcome. **Verified on 25 Oct 2026 against a local Zetaris 2.4.3 instance** (the hackathon's local download) with three fictional source databases registered as datasources. Verified: `verify.sh` 9/9; the in-app connection check passed (198 ms); a case was built entirely from Zetaris imports and matched the answer key; a live agent run queried Zetaris itself; a new quarantine record in the pharmacy source, re-imported through Zetaris, moved the case from 900 to 940 contained. The rebuilt import was checked against the same instance on the evening of 25 Oct (complete paged reads, a row changed in place imported as a new version, a removed row reported; `eval/zetaris-import-check-2026-10-25.md`). Say "local instance, fictional data" in the submission; it was not tested against a hosted Zetaris cluster. Setup and the full record: `docs/INTEGRATIONS.md`.
- **Meterless:** the H-MEM reference engine (unmodified, Apache-2.0, conformance 13/13) is RecallReach's investigation memory. Validated facts (in RecallReach's wording) and operator decisions are stored with provenance and their dependencies: a shipment, a record, the case, or a Zetaris row with its content hash and capture time. Retrieval uses H-MEM ranking. When a dependency changes, H-MEM supersession lineage replaces the memory with a recheck note; a memory whose dependencies cannot be rechecked is shown as unknown, never current. Conflict detection surfaces contradictions without auto-resolving them. Operator "mark as wrong" feedback uses H-MEM's feedback deltas and trust ledger. Retention is bounded (newest 200 memories and 800 ledger entries per case; dropped counts shown).
- **What is unique:** the agent cannot simply assert a fact. Facts are typed and checked field by field against the engine and the evidence the agent actually received, with RecallReach writing the wording; the model's prose stays visibly separate. Memory and federation are subordinate to evidence: neither can change a stock number, and memory that cannot be rechecked is labelled unknown.
- **Cursor:** not used. **NVIDIA:** not used. An `nvidia` provider preset exists but has never been run; don't claim NVIDIA use.

## Pre-existing work declaration (rules 4.2 and 5.4)

Created inside the build window:

- The RecallReach application code: the first prototype was written on **23 Oct 2026, about 20:30–20:52 UTC** (file timestamps 24 Oct 02:01–02:22 IST) in an earlier AI-assisted session. The folder and the removed `codex-preview` metadata indicate OpenAI Codex with its Sites plugin; confirm this yourself before declaring it. It was extended on **24 Oct 2026** (git history from commit `c88ec88`).

Pre-existing components to declare:

- OpenAI Sites Vinext starter (project scaffold, `scripts/`, vendored Sites Vite plugin under MIT licence).
- shadcn/ui components (`components/ui/*`) and the vendored shadcn Tailwind CSS.
- Meterless H-MEM reference engine (upstream commit `1742dec`, 19 Oct 2026, Apache-2.0), vendored unmodified.
- Open-source npm dependencies (`package.json`).

AI assistance: code was generated with AI coding assistants (the earlier session, then Claude Code on 24 Oct). Rule 5.5 allows generated code; you are accountable for it.

## Judging checklist with evidence

| Criterion (points) | What to show | Evidence in the repo |
| --- | --- | --- |
| Impact (30) | A real coordinator problem; who is helped; honest limits | README "The problem"; PILOT_PLAN.md; principles enforced in `engine.ts` and `validate.ts` |
| Technical (20) | Deterministic engine plus a bounded agent; atomic persistence; one deadline; complete, versioned imports; tests | ARCHITECTURE.md; 119 automated tests (`npm test`); EVALUATION.md; JUDGE_GUIDE.md |
| Innovation (15) | Typed facts validated against the engine and delivered evidence; Evidence Challenge ("Why this finding?"); dependency-tracked memory with an honest *unknown* | `agent/facts.ts`, `explain.ts`, `memory/hmem.ts`; tests in `facts.test.ts`, `trust.test.ts`, `explain.test.ts` |
| Demo (15) | Seven beats in about 3.5 minutes, speed-ups and rules mode labelled | DEMO_SCRIPT.md |
| Product & UX (10) | Evidence library, tool activity, checked summary, validated/rejected facts, *Why this finding?*, approvals, corrections; phone layout | `components/recall/*`; browser checks in EVALUATION.md; OPERATOR_TEST.md |
| Sponsor tech (10) | Zetaris federation of separate systems, connected and verified on a local instance; Meterless memory with invalidation | INTEGRATIONS.md (Verification record); `eval/zetaris-check-2026-10-25.txt`; Integrations screen; `vendor/meterless-hmem/VENDORED.md` |

## Slide deck (required by 6.2)

Drafted on 25 Oct 2026 as a 13-slide deck: <https://claude.ai/artifact/VdBTDtBgDbuTBWydusFJvf> (private until you share it; download it as PowerPoint or PDF from the deck's Share › Export for the submission). Updated the same evening for typed facts, the Evidence Challenge, retention limits and the held-out evaluation, including the weak live-model result. It follows the outline below, adds a cover and splits product visuals over two slides of real screenshots from the running app. Every slide has speaker notes you can read from for the video. Phone views are not included because they were not checked on a phone.

1. Problem and users: recall coordinator, pharmacy staff, supervising pharmacist; why fragmented records delay containment.
2. Solution in one picture: sources → Zetaris → engine → agent → human decision → memory.
3. Agent workflow: question, tools, verified citations, proposal, approval, new evidence, reassessment.
4. Stock model and principles: "unknown is not safe", "approval is not completion".
5. Zetaris use: three source systems, read-only mapped queries, latency and failures shown. Connected on a local instance: show the passing check and the 900 → 940 follow-up arriving through Zetaris.
6. Meterless use: H-MEM memory, supersession on evidence change, contradiction detection, operator feedback.
7. What was unique: verifier against retrieved evidence; memory that cannot override records.
8. Evaluation: held-out case (key committed first): baseline 1/7, engine 7/7, rules mode 5/5 key facts; live model 0/5 in every run (three at 240 s, two hit the time limit; three more after raising it to 480 s ended on malformed tool calls and Groq's daily token cap; one unplanned run hit a request-size limit); 0 unsupported claims accepted. Limits: fixtures written by the builder.
9. Product visuals: overview, agent run, follow-up queue, memory panel, phone view.
10. Tech stack: Vinext/React, Cloudflare Worker + D1, Groq (OpenAI-compatible), H-MEM, Zetaris REST.
11. Future work: real-format mapping, team roles, pilot with one distributor.

## Before you submit

- [x] Connect Zetaris and record a passing check (25 Oct 2026, local instance; INTEGRATIONS.md, Verification record).
- [ ] Decide repository visibility so judges can open it.
- [x] Draft the slide deck (25 Oct 2026; link above). Review it, then export it as PowerPoint or PDF.
- [ ] Record the video (1–4 minutes) following DEMO_SCRIPT.md: no splicing, label speed-ups and rules mode.
- [ ] Share the repository with judges (or make it public) only when you decide to; JUDGE_GUIDE.md explains how to reproduce the results.
- [ ] Declare pre-existing components as listed above.
- [ ] Recheck the event page and Discord for any rule change.
