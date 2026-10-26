# Demo video script

The demo video (<https://youtu.be/EU9kqHnXcvg>, 3:35; rule 6.1 allows 1–4 minutes) shows the main workflow, how the agent works, the key features, and how Zetaris and Meterless are used. Everything in it is fictional data on a local machine.

## How it was recorded

- **Real screens only.** Every screen is the app running locally (`npm run dev`) against a local Zetaris 2.4.3 instance with fictional source databases, plus one test file and its passing run.
- **No splicing of runs.** Each run shown is one saved run in one case. Where a beat shows an earlier saved run, a caption says which run, when, and how long it took.
- **Labels on screen.** Rules-mode results are captioned "RULES MODE · no language model". Any sped-up waiting is captioned with the speed-up. The live model is not run for the video, because the day's free-tier allowance goes to the recorded evaluation series.
- **Narration** is a synthetic voice reading the script below, with captions.
- **Words not used:** production-ready, complete, verified (except for a validated fact), real-time, independently evaluated, or anything about patients or outcomes.

## Beats

| # | Screen | Narration (summary) |
| --- | --- | --- |
| 1 | Overview of the drill "the missing 40 bottles"; the evidence library with a record kept in boxes (HOLD-103-B) | When a batch is recalled, the dispatch log, the pharmacies and the returns desk each hold part of the picture. The engine reconciles 1,000 bottles: 900 reported contained, 60 dispensed, 40 with no containment record. A record in boxes, a duplicate and a hold reference that names no shipment are held back, each with its reason. On a held-out case a spreadsheet filter finds 1 of 3 gaps; the engine finds all 3. |
| 2 | An earlier saved live run (25 Oct, 214 s, drill case), its tool activity and typed facts | The agent reads evidence only through read-only tools and chooses its own steps. It can state a fact only in typed form, and RecallReach checks every field against the engine and the records it actually received, then writes the wording. |
| 3 | `tests/trust.test.ts`, the false "RR-104 has 60 bottles dispensed" claim, and the test passing; then a real rejection in an earlier run's tool activity | A number that is true for a different shipment is refused, with the engine's real value. The live model's own results are weak: in 7 held-out runs it stated none of the 5 key facts, and the few facts it submitted were all true. |
| 4 | "Why this finding?" on RR-104 | The calculation, what each source says, what was not counted, what evidence would change the answer, why approving a follow-up does not, and a preview that is labelled hypothetical. |
| 5 | Rules mode (labelled): a new quarantine row added at the pharmacy source; the agent reads it through Zetaris before import (memory UNKNOWN); import; memory CURRENT; 900 → 940 contained | Zetaris gives read-only access to each separately owned system. New evidence changes the numbers only after it is imported and passes the engine's checks; memory says when an earlier conclusion can no longer be rechecked. |
| 6 | Integrations: connection check, then one query across all three sources through Zetaris | One read-only query across the three systems lists the consignment that neither the pharmacy nor the returns desk mentions: RR-104, 40 bottles. The same gap the engine found. |
| 7 | End card | The engine owns every number. The agent explains it. People decide what happens next. |
