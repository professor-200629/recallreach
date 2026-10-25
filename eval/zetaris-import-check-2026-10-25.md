# Rebuilt import checked against the local Zetaris instance (25 Oct 2026, ~16:37–16:39 UTC)

Instance `zetaris://localhost:8888/org/1` (local Zetaris 2.4.3, three fictional PostgreSQL source databases). App: `npm run dev` with the current code, case "DEMO-042 via Zetaris (paged import check)", driven through the app's own API from the signed-in browser session.

1. **Paged reads** (`scripts/zetaris-read-check.ts 2`, saved in `zetaris-read-check-2026-10-25.txt`): every source read completely with a page size of 2 (2–7 pages, distinct keys equal to the COUNT), including VL-2207 stock events whose text timestamps are not in row-number order; an unknown batch returned 0 rows as a successful check.
2. **Case built from three imports:** 4 + 6 + 4 rows, each a complete read matching the count; instance recorded on each source. Result 1,000 accepted / 900 contained / 40 available / 60 dispensed, 4 to review, 1 duplicate (the answer key).
3. **Re-import with no change:** 0 new, 0 changed, 6 unchanged; no source added.
4. **Rules-mode investigation** on this case: completed, 6 of 6 typed facts validated; both connected-source queries ran against Zetaris; case and memory saved together on local D1 (6 memories, all current).
5. **Follow-up row added at the source** (`02-followup-quarantine.sql`, row 21): re-import → 1 new, 6 unchanged; 940 contained, 0 available; 3 memories marked for recheck.
6. **Same row changed at the source** (quantity 40 → 39, same row key): re-import → 0 new, 1 changed, 6 unchanged; correction recorded ("Source row 21 changed … The new version replaces it; the earlier version is kept"); quarantined 839, available 1; nothing double counted.
7. **Row removed at the source** (`03-reset-followup.sql`): re-import → nothing imported; "1 previously imported row(s) are no longer returned by the source (21); they were not reversed"; balances unchanged (839 / 1).

The pharmacy source was left in its original state (row 21 removed).
