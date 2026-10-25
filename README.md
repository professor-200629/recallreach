# RecallReach

**RecallReach helps a medicine recall coordinator investigate fragmented distribution records, find affected stock that is still unresolved, explain every finding with its evidence, and coordinate accountable human follow-up.**

Built for the [Open Agent Hackathon 2026](https://hackathon.genai.works/event/open-agent-hackathon-2026) (GenAI.Works), track *The Agent That Can Explain Why*. All data in this repository is fictional.

> Status: hackathon prototype. Tested on fictional fixtures only. Not validated with real recall coordinators or pharmacists, and not ready for operational use. See [Known limitations](#known-limitations).

## The problem

When a batch of medicine is recalled, the distributor's dispatch log, each pharmacy's stock system and the returns desk all hold part of the picture. They disagree, duplicate each other, use different units, and sometimes omit the one record that matters. A coordinator must find out quickly which stock may still reach a patient, and must be able to show why they believe it.

## What it does

For one manufacturer + product + batch, counted in one unit:

1. **Reconciles** imported records into mutually exclusive states (available, quarantined, returned, dispensed) with a deterministic engine. It catches duplicates, conflicting versions, reused references, double openings, wrong units, ambiguous or future timestamps, movements before shipment, location mismatches and overspends. Uncertain records stay visible with the reason they were not counted. Near-miss batch numbers are flagged, never counted.
2. **Investigates** with a bounded, tool-using agent. Ask *"Why are 40 bottles still unresolved, and what evidence would resolve this?"* and the agent chooses among 10 read-only tools: reconciliation, shipment ledger, original source row, reference trace, review queue, memory, change comparison, and connected sources through Zetaris. It submits findings that cite the records it actually retrieved. RecallReach checks every citation, every quantity stated with a unit, and present-tense "still unresolved" claims against the engine; anything unsupported is labelled **unverified**.
3. **Proposes follow-up** (who should do what, and which evidence would resolve it) for a person to approve or reject. Approval never changes stock.
4. **Reassesses** when evidence changes. Evidence snapshots mark earlier conclusions stale, and investigation memory (Meterless H-MEM) supersedes them with recheck notes instead of reusing them.
5. **Keeps an accountable trail:** operator corrections that preserve the original record, a hash-chained activity log, and Markdown/CSV/JSON exports.

Without model credentials, **rules mode** runs a fixed procedure with the same tools and the same citation checks, clearly labelled as using no language model.

## Sponsor technology

| | How it is used | Status |
| --- | --- | --- |
| **Zetaris** | Read-only federated queries across three separately owned source systems (distributor ERP, pharmacy stock, returns desk), each with native columns mapped by code-owned SQL. Every query's latency and result is recorded. | **Connected** to a local Zetaris 2.4.3 instance (the hackathon's local download) and verified with real queries on 25 Oct 2026: imports, a live agent run and a follow-up update all went through Zetaris. The source systems hold fictional data. A labelled mock remains for machines without Zetaris. |
| **Meterless H-MEM** | Investigation memory across runs: verified findings, open questions and operator decisions, with provenance, trust ledger, supersession and contradiction detection. | **In use.** Unmodified reference engine (Apache-2.0); upstream conformance suite 13/13. |

Details and setup: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## Quick start

```bash
npm ci
cp .dev.vars.example .dev.vars   # add GROQ_API_KEY for live runs (optional)
npm run build && npm run db:migrate:local
npm run dev
```

Open `http://localhost:5173/signin-with-chatgpt?return_to=/` (local test sign-in), then **Explore a mock recall**. Full instructions: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

```bash
npm test          # 69 automated tests
npm run eval      # fixture comparison with a batch-lookup baseline
```

## Documentation

- [Architecture and data flow](docs/ARCHITECTURE.md): stock model, agent loop, trust boundaries
- [Integrations](docs/INTEGRATIONS.md): Zetaris, Meterless H-MEM, model provider; setup and verification
- [Evaluation](docs/EVALUATION.md): test inventory, fixture results, live runs
- [Demo script](docs/DEMO_SCRIPT.md)
- [Submission notes](docs/SUBMISSION.md): description, judging checklist, pre-existing work
- [Pilot plan](docs/PILOT_PLAN.md)
- [Deployment](docs/DEPLOYMENT.md)

## Principles

Unknown does not mean safe. A record outside the alert is not a safety clearance. Exact identity is manufacturer + product + batch. Units are never converted. Imported records report actions; they do not prove them. Approval is not completion. There is no "recall complete" conclusion. Every factual claim cites retrieved evidence or is labelled unverified.

## Known limitations

- **Fictional data only.** There has been no real-user pilot and no feedback from coordinators or pharmacists yet.
- **Zetaris was verified on one local instance only**, with fictional source databases. It has not been tested against a hosted Zetaris cluster or real source systems, and a hosted RecallReach cannot reach a Zetaris running on a laptop (see DEPLOYMENT.md).
- **Live model runs use Groq's free tier** (8,000 tokens per minute), so a live investigation can take up to about 4 minutes. Live quality varies from run to run (some runs use only 2–3 tools). The verifier's checks are deterministic but heuristic: in one recorded run a wrong, memory-based claim passed before a fix was added. Read the cited evidence, not just the summary.
- **Not deployed.** Hosting is planned through OpenAI Sites (the existing project identity). Header-based sign-in is only safe behind the Sites dispatcher.
- One batch and one unit per case; no transfers between locations; no team sharing; no automated alert ingestion.
- The audit hash chain checks internal consistency only; it is not tamper-proof storage.
- H-MEM is a reference implementation ("not a production library") with a deterministic hash embedder.
- No patient data is supported, and no messages are ever sent.

## Licence and credits

Application code © 2026 Balu. The vendored Meterless H-MEM reference engine (`vendor/meterless-hmem`) is Apache-2.0. The Vinext/Sites starter, the shadcn/ui components and the vendored Sites Vite plugin are pre-existing third-party components (see `scripts/vite/sites-vite-plugin.LICENSE` and `vendor/shadcn-tailwind-4.13.0.LICENSE.md`).
