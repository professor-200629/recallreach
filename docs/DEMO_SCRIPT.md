# Demo script (target 3:15–3:30; the official limit is 1–4 minutes)

Rule 6.1 asks the video to show the main workflow, how the agent solves the challenge, its key features, and how Zetaris and Meterless are integrated. Seven beats; timings are a guide.

## Recording rules (keep the video honest)

- **No splicing.** Every run you show is one continuous run in one case. You may speed up waiting, but do not cut from one run's tool steps to another run's results, and do not re-record a single beat with a different outcome without saying so.
- **Label speed-ups on screen** ("sped up ×8") whenever waiting is compressed. A live run on Groq's free tier takes 1–4 minutes; never imply it took seconds.
- **Label rules mode on screen** ("RULES MODE · no language model") whenever a result comes from rules mode. The app shows the same label; keep it visible.
- **Say "fictional data" once at the start**, and "local Zetaris instance" when Zetaris appears. If the connection check fails on the day, say so and do not show the labelled mock as Zetaris.
- **Don't say:** "production-ready", "verified" for anything other than a validated fact, "complete", "first prize", "physically checked", "no patients were affected", "real-time", "independently evaluated".

## Before recording

- Zetaris: start Docker (`scripts\windows\start-docker-desktop.ps1`), run `bring-up.sh` in Ubuntu (it re-runs `verify.sh`), and reset the follow-up row with `integrations/zetaris/fixtures/03-reset-followup.sql` (see INTEGRATIONS.md).
- `npm run dev`, then sign in at `http://localhost:5173/signin-with-chatgpt?return_to=/`.
- **Zetaris path (recommended):** New case → Example Pharma (fictional) / Nivara oral solution / DEMO-042 / bottles → **Import records → From a connected source** for all three sources. **Drill path:** New case → *The missing 40 bottles*.
- Start the live investigation before you begin talking over beat 3, so the wait can be sped up.

## The seven beats

| # | Time | Screen | Say (plain, short) |
| --- | --- | --- | --- |
| 1 | 0:00 | Overview | "When a medicine batch is recalled, the records that say where it went are split across a distributor, pharmacies and a returns desk. RecallReach helps a recall coordinator find stock that is still unresolved and shows why. Everything here is fictional." |
| 2 | 0:20 | Stat cards, then Evidence library filtered to *Needs review* | "A deterministic engine reconciles the records: 1,000 bottles shipped, 900 reported contained, 60 dispensed, and 40 with no containment record. It refused to count a duplicate return, conflicting versions, a wrong unit and a record with no shipment, and each record says why." |
| 3 | 0:50 | Agent → prefilled question → **Live model**; tool activity (label "sped up ×N") | "The investigation agent can only read evidence through these tools. It chose its own steps: reconciliation, the RR-104 ledger, the original dispatch row, a reference trace, the connected sources through Zetaris." |
| 3 | 1:10 | Run result: **Checked summary** and **Typed facts** | "It can't just write a claim. Each fact is typed — this shipment, this state, this quantity, this unit — and RecallReach checks every field against the engine and the records the agent actually received, then writes the wording itself. The model's own summary sits below, marked as interpretation." (If the run has a **REJECTED** fact, show it: "here it got one wrong, and it was rejected with the reason.") |
| 4 | 1:35 | **Why this finding?** on the RR-104 balance | "Ask why. The calculation: 40 accepted, nothing moved. No rejected record names RR-104 or 40 bottles. What would change it: a dated quarantine, return or dispensing record. And approving a follow-up won't, because only evidence changes stock. The preview reruns the engine with one hypothetical record: the 40 would close, but the destination would stay unconfirmed." |
| 5 | 2:05 | Follow-up queue → approve → Overview still 40; then run `02-followup-quarantine.sql` off camera and **Import records → Pharmacy stock events** | "A person approves the proposed follow-up. Still 40. Now the pharmacy's own system records the 40 as quarantined, and RecallReach reads it through Zetaris: one new row, the unchanged ones skipped. 940 contained, zero available. The destination is still unconfirmed, and *Why this finding?* says why: a quarantine report isn't proof of who holds the stock. The 60 dispensed still need a pharmacist." |
| 6 | 2:35 | Agent → *What changed since the previous run* in **rules mode** (label it) → Memory panel | "Rules mode, no model, reassesses instantly. Meterless H-MEM memory stores validated facts with what they depend on; the old 40-bottle note is superseded by a recheck note, not reused. Anything it can't recheck is shown as unknown, never as current." |
| 7 | 3:00 | Integrations → **Run connection check** (LIVE); Audit → Verify hash chain | "Zetaris gives read-only access to each source system; here it's a local instance with fictional databases, and the check just passed. Every change is in a hash-chained log you can export. RecallReach sends no messages and never declares a recall complete." |
| | 3:25 | End card | "RecallReach: every batch, every handoff, with evidence." |

**If a live run fails or hits its limit on the day,** show it as it is (the status is on screen) and switch to rules mode with the label. Do not re-run until it looks good and present that as typical; the evaluation numbers in EVALUATION.md are what to quote.
