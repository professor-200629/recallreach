# Reproducing RecallReach's results (for judges and reviewers)

Everything below runs locally on fictional data. Steps 1–4 need only Node.js (≥ 22.13) and about 10 minutes; nothing is sent over the network. Steps 5–6 are optional and need a model key or a Zetaris instance.

## 1. Install and run the checks

```bash
git clone <repository> && cd recallreach
npm ci
npm test            # node:test suites; Node's built-in SQLite with the real migrations
npm run typecheck
npm run lint
```

Expected: all tests pass, and typecheck and lint are clean (counts in [EVALUATION.md](EVALUATION.md)).

## 2. Reproduce the reviewer's counterexamples

Each of these was reported against an earlier version and is now a test that must fail safely:

| Counterexample | Test |
| --- | --- |
| "RR-104 has 60 bottles dispensed" accepted because 60 dispensed appears elsewhere | `tests/trust.test.ts` (first test); `tests/facts.test.ts` "wrong shipment" |
| Wrong state, wrong unit, wrong scope (shipment vs case), stale snapshot, evidence never retrieved | `tests/facts.test.ts` |
| Mixed clauses or an unsupported summary reaching the checked summary | `tests/facts.test.ts` "mixed clauses…" |
| A record named by a memory or an issue list used as evidence without retrieving it | `tests/trust.test.ts`, `tests/facts.test.ts` "referenced is not delivered" |
| A memory with no trackable dependency shown as current; connected-source evidence never rechecked | `tests/trust.test.ts` |
| Tool output cut into invalid JSON | `tests/trust.test.ts` (last test) |
| Re-import double counting, same-key corrections, more than 500 rows, a failed page, equal keys from two instances, a disappeared row | `tests/import.test.ts` |
| Case saved without its memory (or the reverse); concurrent runs | `tests/boundaries.test.ts` |
| Forged identity headers; work continuing after the deadline | `tests/boundaries.test.ts` |

Run one file: `node --experimental-transform-types --no-warnings --test tests/facts.test.ts`.

## 3. Reproduce the evaluation

```bash
npm run eval        # writes eval/results.json; no model, no network
```

It compares the spreadsheet-style baseline, the deterministic engine and the agent in rules mode on three fictional cases. The third, `eval/heldout/corvel-vials.ts`, is the held-out case. Check that its answer key was committed before any results:

```bash
git log --format="%h %ad %s" --date=iso -- eval/heldout/corvel-vials.ts eval/results.json eval/results-live-corvel-vials.json
```

The fixture commit (`1313452`) comes first. The same developer wrote the engine, the fixtures and the keys, so these are not independent accuracy measurements (see EVALUATION.md).

## 4. Use the app

```bash
cp .dev.vars.example .dev.vars
npm run build && npm run db:migrate:local
npm run dev
```

Open `http://localhost:5173/signin-with-chatgpt?return_to=/` (a local test sign-in that only works on your machine), then **New case → The missing 40 bottles**. [OPERATOR_TEST.md](OPERATOR_TEST.md) is a 16-step script with expected results; steps 1–5 and 7–16 need no model or Zetaris.

## 5. Optional: a live model

Put your own `GROQ_API_KEY` in `.dev.vars`. Groq's free tier was used: it allows 8,000 tokens per minute and 200,000 per day, so a run spends most of its time waiting and can use up to its 8-minute limit (`AGENT_TIME_LIMIT_S` changes it), and a few runs use up a day's allowance. Then choose **Live model** in the app, or:

```bash
node --env-file=.dev.vars --experimental-transform-types --no-warnings scripts/evaluate.ts --live --runs 1 --only corvel-vials --tag my-run
```

Each live series is written to its own file (`eval/results-live-corvel-vials-my-run.json`); the script refuses to overwrite an existing live results file. Live results vary between runs; EVALUATION.md records every run made for the submission, including failures.

## 6. Optional: Zetaris

The Zetaris integration was verified on a local Zetaris 2.4.3 instance with three fictional PostgreSQL source databases. Reproducing it needs Docker, the hackathon's Zetaris download and about an hour; follow [INTEGRATIONS.md](INTEGRATIONS.md). Without it, the app runs on CSV imports, and a clearly labelled mock (`RECALLREACH_MOCK_SOURCES=1`) exercises the same code path; it is never presented as Zetaris.

## What cannot be reproduced here

- A hosted deployment: the app is not deployed (see DEPLOYMENT.md).
- Real recall data or real users: none were used.
