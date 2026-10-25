# Demo script (target 3:30; the official limit is 1–4 minutes)

Rule 6.1 asks the video to show the main workflow, how the agent solves the challenge, its key features, and how Zetaris and Meterless are integrated. Timings are a guide. Cut the optional lines first if you run long.

**Before recording**

- Zetaris is connected on this laptop. Start Docker with `scripts\windows\start-docker-desktop.ps1`, run `bring-up.sh` in Ubuntu (it re-runs `verify.sh`), and reset the follow-up row with `integrations/zetaris/fixtures/03-reset-followup.sql` (see INTEGRATIONS.md).
- `npm run dev` and sign in. Then either:
  - **Zetaris path (recommended):** New case → Example Pharma (fictional) / Nivara oral solution / DEMO-042 / bottles, then **Import records → From a connected source** for all three sources. The numbers match the drill below.
  - **Drill path:** **New case → The missing 40 bottles** (sample records, no Zetaris).
- Live model runs take up to about 4 minutes on Groq's free tier. Start the live run, then **cut or speed up** the waiting in editing and say so on screen ("sped up ×8"). Never imply it took seconds.
- Show **Integrations → Run connection check** passing. If Zetaris is down on the day, say so; never show the labelled mock as Zetaris.
- Everything shown is fictional: say it once at the start.

| Time | Screen | Say (plain, short) |
| --- | --- | --- |
| 0:00 | Overview | "When a medicine batch is recalled, the records that say where it went are spread across distributors, pharmacies and returns desks. RecallReach helps the recall coordinator find what is still unresolved, and shows the evidence for every finding. Everything here is fictional." |
| 0:15 | Stat cards, stock bar | "1,000 bottles shipped. The deterministic engine reports 900 contained and 60 dispensed, and 40 bottles have no containment record. It also refused to count a duplicate return, two conflicting versions, a wrong unit and a record with no shipment ID." |
| 0:35 | Evidence library, filter *Needs review*, open one record | "Nothing is swept aside: each record says why it was or wasn't counted, with its original row." |
| 0:50 | Agent screen: ask the prefilled question, Live model | "Now the investigation agent. It's a bounded, tool-using agent: it can only read evidence through these tools, and it can't change stock." |
| 1:00 | Tool activity (sped up) | "It chose its own steps: scope, reconciliation, the RR-104 ledger, the original dispatch row, a reference trace. Each step shows its stated purpose." |
| 1:20 | Findings with *Verified* tags and citation chips; click a chip | "Every claim cites records it actually retrieved. RecallReach checks the citations and the numbers; anything it can't support is marked unverified, not hidden." |
| 1:40 | Follow-up queue → Approve the proposal | "It proposes a follow-up, asking the distributor for proof of delivery. A person approves it." |
| 1:50 | Overview: still 40 | "Approval alone changes nothing: still 40 bottles to follow up." |
| 2:00 | Zetaris path: run `02-followup-quarantine.sql` off camera, then **Import records → Pharmacy stock events** ("1 new row imported from Zetaris; 6 already in this case skipped"). Drill path: *Add fictional follow-up evidence* | "Now the pharmacy's own system records those 40 bottles as quarantined, and RecallReach picks up just that new record through Zetaris." |
| 2:10 | Overview: 940 contained, 0 available, 60 dispensed; staleness banner | "The engine reconciles to 940 contained and zero available. The 60 dispensed bottles still need a pharmacist, and the destination is still unconfirmed: a quarantine record isn't proof of where the stock is. Earlier conclusions are now flagged as stale." |
| 2:30 | Agent: *What changed since the previous run* (rules mode is instant; live is slower) | "Reassessing: it compares the evidence snapshots and recalls its earlier notes from Meterless H-MEM memory. The old conclusion is marked superseded, not reused." |
| 2:50 | Memory panel (CURRENT / SUPERSEDED tags) | "Meterless H-MEM stores verified findings and decisions with their evidence. When that evidence changes, the memory is superseded, never silently overwritten." |
| 3:05 | Integrations screen: **Run connection check** (LIVE, about 200 ms) and the query log | "Zetaris lets RecallReach query each source system read-only, with latency and failures recorded. Here it's a local Zetaris instance with fictional source systems, and the last check passed." |
| 3:20 | Audit tab → Verify hash chain; Export | "Every decision and change is in a hash-chained log you can export. RecallReach never sends messages and never declares a recall complete." |
| 3:30 | End | "RecallReach: every batch, every handoff, with evidence." |

**Optional cut-ins if time allows:** the second scenario (*Velora pens*), where the agent finds 12 pens held back by a quarantine record with an ambiguous timestamp; or the instruction hidden in a source row being flagged as data.

**Don't say:** "production-ready", "complete", "first-prize", "verified physically", "no patients were affected", "real-time integration", or that Zetaris is connected unless the check passed on screen.
