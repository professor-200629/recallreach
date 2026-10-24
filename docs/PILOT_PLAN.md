# Pilot plan: a supervised mock recall

RecallReach has only been tested on fictional fixtures. Before anyone relies on it, it needs a supervised mock recall with one responsible operator: a regional distributor's recall coordinator, or a supervising pharmacist with a few pharmacies. The question to answer is narrow:

> Can a responsible operator find and close an evidence gap in a recall **more reliably or more quickly** with RecallReach than with their current process?

## Partner and roles

- **Operator:** one recall coordinator (distributor) or supervising pharmacist / quality officer.
- **Facilitator:** Balu. Prepares the exercise, observes, records times; does not operate the tool during timed tasks.
- **Data owner sign-off:** the partner decides which records may be used. Preferred: a de-identified export of a *past, closed* recall, or a synthetic exercise built from their real record formats. **No patient names, phone numbers or medical histories**; the tool does not need them and has no place for them.

## Exercise design (about half a day)

1. **Prepare (before the session).** Agree on one past or synthetic batch. Build a ground-truth answer sheet with the partner: shipments, final states, and 4–6 planted gaps (a missing confirmation, a duplicate return, a wrong unit, an ambiguous timestamp, a near-miss batch number). The facilitator holds the answer sheet.
2. **Baseline run.** The operator investigates with their usual tools (spreadsheet, ERP screens, email) and answers a fixed question sheet:
   - Which shipments still have unresolved stock, and how much?
   - What is recorded as dispensed, and where?
   - Which records can't be trusted, and why?
   - What would you ask whom, to close each gap?
3. **RecallReach run** on a matched exercise (same structure, different planted gaps, to limit learning effects). Rules mode, plus live mode if the partner agrees to a model provider. Alternate the order for a second operator if one is available.
4. **Debrief.** Ten minutes of structured questions on trust, wording and what was missing.

## Measures

| Measure | How |
| --- | --- |
| Gaps found correctly | Against the answer sheet, both runs |
| Wrong conclusions | Shipments wrongly called resolved or unresolved; records wrongly trusted |
| Time to first correct answer per question | Facilitator stopwatch |
| Follow-ups that name the right owner and the right evidence | Scored by the operator's supervisor, blinded to which run produced them |
| Unverified agent statements the operator noticed or missed | From the run record |
| Operator confidence and trust | 5-point ratings with free-text reasons |

Report results as observed, including where RecallReach was slower or worse. A single partner gives anecdotes, not statistics. Say so.

## Success criteria (agreed with the partner before starting)

- No case where RecallReach led the operator to treat unresolved stock as resolved.
- At least as many planted gaps found as the baseline, with each finding traceable to its source row.
- The operator can explain, unprompted, why each counted record was counted.

## Safeguards

- Read-only exports only; nothing is connected to live pharmacy systems in the first pilot.
- No outreach is sent from the tool (it cannot send any).
- Data stays in the partner's account, or in a private workspace they control, and is deleted at the end unless they ask otherwise.
- Physical verification and any real recall actions remain the partner's normal process. The exercise does not replace them.

## What would have to change before operational use

- A source format mapping for the partner's real exports, validated against their data.
- Team accounts with roles (coordinator, pharmacy staff, supervising pharmacist), instead of single-owner cases.
- Production authentication on the chosen host, and a security review.
- Retention, backup and deletion policies agreed with the data owner.
- Regulatory review of the wording of findings and follow-ups for the partner's jurisdiction.
- Evaluation on more than one partner and more than synthetic gaps.
