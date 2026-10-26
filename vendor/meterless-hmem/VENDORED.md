# Meterless H-MEM reference implementation (vendored, unmodified)

- Upstream: https://github.com/Meterless/Meterless, path `engines/hmem/reference/src/`
- Upstream commit: `1742dec56a66e58eef9dda2d2b865823758ca8cd` (2026-10-19)
- Licence: Apache-2.0 (see `LICENSE` in this folder)
- Copied on: 2026-10-24
- Changes: none. `SHA256SUMS` lists the upstream file hashes; the first test in `tests/memory.test.ts` checks them (`npm test`).

Upstream describes this as "a minimal deterministic reference implementation" that
"makes the spec executable. It is not a production library." It uses a deterministic
hash embedder (64 dimensions), not a learned embedding model.

How RecallReach uses it (see `lib/recall/memory/hmem.ts`):

- One H-MEM instance per case, constructed without `persistDir`, so no filesystem access.
- State (`store.snapshotAll()`) and the trust ledger are saved to the D1 table
  `case_memory` and restored on the next request by `store.restoreAll()` and ledger replay.
- RecallReach writes reviewed findings and open questions as H-MEM records with
  `source`, `confidence`, `provenance.refs` (evidence record IDs) and an evidence
  fingerprint tag. Retrieval uses `HMEM.query()` (H-MEM's hybrid ranking).
- When evidence changes, RecallReach adds a recheck record that `supersedes` the stale
  one and sets `supersededBy` through `store.update()`, so the ledger records the change.
  Nothing is deleted. `conflicts.scan()` is used for detection only; RecallReach never
  calls auto-resolution.

Verification performed on 2026-10-24 (Node 24.14, Windows 11):

- Upstream `npm test` in `engines/hmem/reference`: 10/10 passed.
- Upstream conformance suite (`engines/hmem/conformance/runner.ts`) with
  `HMEM_IMPL` pointing at this folder's `src/index.ts`: 13/13 checks passed.
