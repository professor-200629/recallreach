# Operator test script

A manual check of the main workflow by a person, in about 20 minutes, with fictional data. Record each result as **Pass**, **Fail** (with what you saw) or **Not run**. The expected results below are for the *missing 40 bottles* drill.

Setup: `npm run dev`, sign in at `http://localhost:5173/signin-with-chatgpt?return_to=/`, then **New case → The missing 40 bottles**. Rules mode needs nothing else; a live run needs `GROQ_API_KEY` in `.dev.vars`.

| # | Do this | Expect | Result |
| --- | --- | --- | --- |
| 1 | Open the Overview | 1,000 accepted · 900 contained (90%) · 40 awaiting containment · 60 dispensed | |
| 2 | Evidence library → filter *Needs review* → open the 2-boxes record | It is not counted; the reason names the unit mismatch (boxes vs bottles); the original row is shown | |
| 3 | Overview → *Locate and check 40 bottles* → **Why this finding?** | Calculation: opening +40, nothing moved; "None of the 4 records held for review … names RR-104"; what could change it; approval does not change stock; hypothetical preview: 40 → 0 available, *Confirm where shipment RR-104 went* stays open | |
| 4 | Agent → keep the first question → **Rules mode** → Investigate | Status COMPLETED; label RULES MODE · NO LANGUAGE MODEL; a checked summary; every typed fact VALIDATED; RR-104 40 available and RR-103 60 dispensed among them | |
| 5 | On a validated fact, **Why this finding?** | The same kind of explanation as step 3, with the fact's snapshot | |
| 6 | (Optional, live) Same question → **Live model** | Completes or stops with an honest status within the limit shown under the question (8 minutes for Groq by default); any rejected fact shows its reason; the model's summary is labelled interpretation | |
| 7 | Follow-up queue → approve the RR-104 proposal with a note | Recorded; Overview still shows 40 awaiting containment | |
| 8 | Evidence → *Add fictional follow-up evidence* | 940 contained (94%), 0 awaiting containment; staleness banner appears | |
| 9 | Overview → *Confirm where shipment RR-104 went* → **Why this finding?** | Says the reported quarantine does not name a responsible recipient; lists the follow-up record under "Added since the previous run" | |
| 10 | Agent → *What changed since the previous run…* → Rules mode | Interpretations mention the recheck note; no fact restates RR-104 as 40 available | |
| 11 | Memory panel | The old RR-104 note is SUPERSEDED, a recheck note quotes it; the retention line states the 200 / 800 limits and how many were dropped | |
| 12 | A memory → **Mark as wrong** with a note | MARKED WRONG tag; confidence lower; audit entry | |
| 13 | Integrations | Without Zetaris: MOCK · NOT ZETARIS or not configured, never "connected" | |
| 14 | Audit → Verify hash chain | Chain verified | |
| 15 | Export → each of the three formats | Files download with readable content | |
| 16 | Phone width (or a phone) | No sideways scrolling; *Why this finding?* readable | |

Tester: ____________ Date: ____________ Build/commit: ____________
