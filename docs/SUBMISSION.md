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

> RecallReach helps a medicine recall coordinator find affected stock that is still unresolved and explain why. A deterministic engine reconciles distributor dispatches, pharmacy stock events and returns into mutually exclusive states. It refuses to count duplicates, conflicting versions, wrong units, ambiguous timestamps or near-miss batch numbers, and says why. A bounded, tool-using agent then investigates questions such as "Why are 40 bottles still unresolved?". It chooses among read-only tools, retrieves the actual records, and submits findings whose citations and quantities RecallReach checks; unsupported claims are labelled unverified. The agent proposes follow-ups that a person approves; approval never changes stock. When new evidence arrives, conclusions stored in Meterless H-MEM memory are superseded, not reused. Zetaris provides read-only access to separately owned source systems. All demo data is fictional; RecallReach sends no messages and never declares a recall complete.

## How Zetaris and Meterless are integrated (for 6.4)

- **Zetaris:** RecallReach treats the distributor ERP, pharmacy stock systems and returns desk as separate datasources federated by Zetaris. It queries them through the Zetaris REST SQL endpoint with code-owned, read-only, bounded SELECTs that map each system's native columns. Every row keeps its table, row key and query ID, and every check records latency and outcome. **State honestly in the submission whether a real Zetaris query succeeded** (Integrations screen). As of 24 Oct, it had not: the adapter is contract-tested against the documented API and a labelled mock serves the same fixtures. Setup: `docs/INTEGRATIONS.md`.
- **Meterless:** the H-MEM reference engine (unmodified, Apache-2.0, conformance 13/13) is RecallReach's investigation memory. Verified findings, open questions and operator decisions are stored with provenance and evidence fingerprints. Retrieval uses H-MEM ranking. When evidence changes, H-MEM supersession lineage marks old conclusions for recheck. Conflict detection surfaces contradictions without auto-resolving them. Operator "mark as wrong" feedback uses H-MEM's feedback deltas and trust ledger.
- **What is unique:** memory and federation are subordinate to evidence. Neither can change a stock number; both are cited, checked and labelled, and a stale memory is shown as stale.
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
| Technical (20) | Deterministic engine plus a bounded agent; tests | ARCHITECTURE.md; 65 automated tests (`npm test`); EVALUATION.md; live run records in `eval/` |
| Innovation (15) | Citation and quantity verification against what the agent actually retrieved; evidence-fingerprinted memory that supersedes itself | `agent/validate.ts`, `memory/hmem.ts`, tests in `agent.test.ts` and `memory.test.ts` |
| Demo (15) | The 10-step drill story in under 4 minutes | DEMO_SCRIPT.md |
| Product & UX (10) | Evidence library, tool activity, verified/unverified labels, approvals, corrections; phone layout | `components/recall/*`; browser checks in EVALUATION.md |
| Sponsor tech (10) | Zetaris federation of separate systems; Meterless memory with invalidation | INTEGRATIONS.md; Integrations screen; `vendor/meterless-hmem/VENDORED.md` |

## Slide deck outline (required by 6.2; not produced yet)

1. Problem and users: recall coordinator, pharmacy staff, supervising pharmacist; why fragmented records delay containment.
2. Solution in one picture: sources → Zetaris → engine → agent → human decision → memory.
3. Agent workflow: question, tools, verified citations, proposal, approval, new evidence, reassessment.
4. Stock model and principles: "unknown is not safe", "approval is not completion".
5. Zetaris use: three source systems, read-only mapped queries, latency and failures shown. Use the status you actually achieved.
6. Meterless use: H-MEM memory, supersession on evidence change, contradiction detection, operator feedback.
7. What was unique: verifier against retrieved evidence; memory that cannot override records.
8. Evaluation: fixture comparison with the batch-lookup baseline, live-run records, limits (fixtures written by the builder; n=1 live runs).
9. Product visuals: overview, agent run, follow-up queue, memory panel, phone view.
10. Tech stack: Vinext/React, Cloudflare Worker + D1, Groq (OpenAI-compatible), H-MEM, Zetaris REST.
11. Future work: real-format mapping, team roles, pilot with one distributor.

## Before you submit

- [ ] Connect Zetaris and record a passing check, or describe the integration as "built, not yet connected".
- [ ] Decide repository visibility so judges can open it.
- [ ] Record the video (1–4 minutes) and make the deck.
- [ ] Declare pre-existing components as listed above.
- [ ] Recheck the event page and Discord for any rule change.
