# Integrations: setup and verification

RecallReach uses three external pieces. Each one is optional at runtime, and the app says plainly when one is missing, mocked or failing.

| Piece | Role | Status on 25 Oct 2026 |
| --- | --- | --- |
| Zetaris | Read-only access, through one Zetaris instance, to three fictional databases representing separately owned systems, registered as its datasources (each import reads one source table; one cross-source query joins all three) | **Connected to a local instance** (the hackathon's local download, Zetaris 2.4.3, on this laptop) and verified with real queries on 25 Oct 2026; see [Verification record](#verification-record-25-oct-2026). The three source systems behind it hold fictional fixture data. |
| Meterless H-MEM | Investigation memory across runs | **In use**: vendored, unmodified reference engine; upstream conformance suite 13/13. |
| Language model (Groq, OpenAI-compatible) | Chooses tools and explains evidence | **Working** with Groq free tier, `openai/gpt-oss-120b`. Rules mode works with no model. |

All secrets are read on the server from Worker bindings (`.dev.vars` locally). None are sent to the browser, written to exports or included in error messages.

---

## 1. Zetaris

### What RecallReach does with it

A recall investigation needs records from systems that are owned by different organisations and were never one dataset: the distributor's dispatch log, each pharmacy's stock system and the returns desk. RecallReach queries each through Zetaris with a fixed, code-owned `SELECT` (see `lib/recall/sources/external.ts`):

- Only `SELECT` statements written in code. The model and the operator supply filter values only (batch, shipment ID). Values are restricted to `[A-Za-z0-9 ._()/-]` and quote-escaped; table names come from server configuration and must be plain identifiers.
- Every query is bounded (`LIMIT` ≤ 500 per page) and times out after 20 s; an investigation's deadline also cancels a query in flight.
- Each source keeps its native column names. The mapping to RecallReach's ledger columns, and the assumption it makes, is stated per source and shown to the agent and in the audit trail. For example, a return note is mapped to quarantined → returned, because the register does not record the prior state.
- **An import is a complete read.** RecallReach first runs `SELECT COUNT(*)` for the batch, then reads pages of 200 rows in a stable order (the source's timestamp column, then `row_no` as the tie-breaker, as a keyset condition bound as literals). The read succeeds only if the pages return exactly the counted number of distinct rows; a failed page, a row returned twice or a count mismatch fails the whole read and nothing is imported. "No matching rows" is a recorded, successful check, distinct from a failed query. A read is capped at 2,000 rows.
- **Identity and versions.** Each row is identified by source instance (`zetaris://host/org/<id>`), table and the source's row key, and its content is hashed. Re-importing skips unchanged rows; a row that changed at the source under the same key is imported as a new version and the earlier version is superseded by an audited correction (kept, no longer counted, so nothing is double counted); a previously imported row the source no longer returns is reported in the import message and the audit log, never reversed; equal row keys from two instances are different rows. Imports saved before instances and hashes were recorded are still recognised (their hash is recomputed from the retained row).
- Imported rows become a new evidence source with system, mode, instance, table, query IDs, fetch time, latency, SQL, each row's key and content hash, and the coverage of the read (pages, rows, source count).
- Every health check and query is recorded (owner, mode, operation, result, latency, short detail) and shown on **Integrations**. Zetaris is shown as **connected only after a live `SELECT 1` succeeds**.

Request contract (from `zetaris/getting-started`, `docs/connections/client-setup.md` and `scripts/zetaris_sql.py`):

```
POST {ZETARIS_REST_URL}/sql-editor/sqls/run
Authorization: Bearer {ZETARIS_API_KEY}
X-Org-ID: {ZETARIS_ORG_ID}
X-Request-ID: <uuid>
{"queryId": "<uuid>", "sql": "...", "source": "SqlEditor", "limit": 50}
→ {"data": [["value", ...], ...]}
```

`tests/zetaris.test.ts` checks this request shape, positional row mapping, exponent-format numbers (`4.0E1` → 40), failure classes (auth, timeout, unreachable, bad shape) and SQL-injection resistance with a fake `fetch`. Compatibility with a real instance was checked separately (Verification record below). One difference from the documented contract was found there: Zetaris 2.4.3 answers a wrong API key or organisation ID with HTTP 400 `{"msg":"Not Allowed"}`, not 401. The adapter reports that as `auth_failed`.

### Setting up a local instance

Sources: the *Run the platform locally* page in Zetaris Cloud (<https://cloud.enterprise.zetaris.com/dashboard/download>, read 24 Oct 2026) and the bundle's own `README.md`. They match the getting-started guide (upstream commit `6a2fbaa`) except in one respect: the current bundle ships with a filled-in `.env` and a **default administrator account** (documented in the bundle README), whose password you change after first sign-in. No `.env` editing is needed.

**State of this laptop (25 Oct 2026, IST):**

| Step | State |
| --- | --- |
| Zetaris Cloud account | Done (yours) |
| `zetaris-platform.zip` (26.7 MB) downloaded and unpacked to `~/zetaris/zetaris-platform` in Ubuntu | Done |
| `.env`: `UI_PORT=127.0.0.1:3000` so the UI is reachable from this machine only (original kept as `.env.original`) | Done |
| Docker Desktop 4.64 running, WSL integration for Ubuntu on | Done (see troubleshooting) |
| Registry login (in Ubuntu) | Done |
| `./preflight.sh` | 6 PASS, 1 WARN (memory available to Docker 7 GB of 8 recommended); "the stack will run" |
| Images pulled, Zetaris started, `verify.sh` | Done: four images (about 10 GB unpacked); all containers healthy; one-time bootstrap exited 0; **`verify.sh` 9 of 9 PASS**, including a query through ui → api → driver → Spark |
| Fictional source database (`recallreach-sources`) | Running and attached to `zetaris_default` as `recallreach-sources`; 12 dispatch rows readable from the Zetaris network |
| Datasources registered in Zetaris | Done: `recall_distributor`, `recall_pharmacy`, `recall_returns` (`npm run zetaris:setup`, 7 statements) |
| RecallReach configured (`.dev.vars`) | Done: REST URL, organisation `1`, API key saved with `set-zetaris-key.ps1` (never displayed) |

### Finish the connection (in this order)

1. **Registry login — in Ubuntu, not PowerShell.** On the *Run locally* page click **Get the platform** (step 1), copy the `docker login zetarishackathon.azurecr.io …` command and paste it into an **Ubuntu** window. Expect `Login Succeeded`. (Never paste it anywhere else.)
2. **One command for the rest of the install** (in the same Ubuntu window; 20–30 minutes, mostly the 4 GB download):
   ```bash
   bash <your RecallReach clone>/integrations/zetaris/bring-up.sh
   ```
   On Windows the clone is under `/mnt/c/...` in Ubuntu, for example `/mnt/c/Users/<you>/recallreach`. The script expects the Zetaris download in `~/zetaris/zetaris-platform`; set `ZETARIS_DIR` to use another folder.
   It runs `preflight.sh`, `docker compose pull`, `docker compose up -d`, waits for the one-time bootstrap, runs `verify.sh` (expect 9 of 9 PASS), starts the fixture database, attaches it to the Zetaris network as `recallreach-sources`, and checks that Zetaris's network can read it. It stops at the first failure and is safe to rerun.
3. **Sign in and change the password.** Open <http://localhost:3000>, sign in with the default administrator account from the *Run locally* page (step 7), then change the password from the user menu (top right). Type the password carefully: **three wrong attempts lock the account**, and the login then says "Not Allowed" even with the right password (see troubleshooting).
4. **Organisation ID and API key.** Management → Organisation shows the numeric **ID** (`1` on a fresh local install). Management → API Tokens → **+** creates a key; it is shown once. Then, in PowerShell:
   ```bash
   powershell -ExecutionPolicy Bypass -File scripts\windows\set-zetaris-key.ps1
   ```
   It asks for the key with hidden input, saves `ZETARIS_ORG_ID` and `ZETARIS_API_KEY` to `.dev.vars`, and tests them with one `SELECT 1` ("Test passed"). Editing `.dev.vars` by hand also works, but an unsaved editor is easy to miss. The key carries the rights of the user who created it; RecallReach only sends fixed, read-only SELECTs. For anything beyond a local demo, create the key as a non-administrator user with SELECT on the three datasources only.
5. **Register the three source systems** (administrator key needed for this one step):
   ```bash
   npm run zetaris:setup -- --dry-run
   npm run zetaris:setup
   ```
   It runs only the statements in [`integrations/zetaris/setup-datasources.sql`](../integrations/zetaris/setup-datasources.sql), skips anything already registered, and stops at the first failure. You can instead paste those statements into the Zetaris SQL Editor one at a time. No password appears in them: the fixture's read-only login needs none (it can only SELECT fictional tables; every other database account keeps password authentication).
6. **Verify** (next section).

### Load the fictional source systems (what `bring-up.sh` step 6 does)

```bash
docker compose -f integrations/zetaris/docker-compose.yml up -d
docker network connect --alias recallreach-sources zetaris_default recallreach-sources
```

This starts PostgreSQL as container `recallreach-sources`, with three databases and a read-only login, `recallreach_reader`. It publishes `127.0.0.1:5433` on this machine only, for inspection, and joins the Zetaris Compose network (`zetaris_default`, named on the *Run locally* page) so the Zetaris engine reaches it as `recallreach-sources:5432` without exposing it on your LAN. The fixture SQL is generated from the same fictional scenarios the app uses (`npm run zetaris:fixtures`):

| Database.table | System it stands for | Native columns |
| --- | --- | --- |
| `recall_distributor.dispatches` | Distributor ERP | dispatch_id, consignment_ref, batch_no, qty, consignee, invoice_no, dispatched_at |
| `recall_pharmacy.stock_events` | Pharmacy stock systems | txn_id, consignment_ref, from_status, to_status, qty, pharmacy_name, doc_ref, recorded_at |
| `recall_returns.return_notes` | Distributor returns desk | rma_id, consignment_ref, qty, returned_from, rma_ref, received_at |

The qualified `<datasource>.<table>` names above work on Zetaris 2.4.3 (checked 25 Oct 2026). If a query on another version says *table not found*, run `SHOW DATASOURCE TABLES recall_distributor` in the SQL Editor and put the names it shows into `ZETARIS_TABLES` in `.dev.vars`.

### Configure RecallReach

`.dev.vars` (gitignored; never paste the key into a chat or commit it):

```
ZETARIS_REST_URL=http://localhost:8888/api/v1.0
ZETARIS_ORG_ID=<numeric ID from Management → Organisation>
ZETARIS_API_KEY=<key from Management → API Tokens>
# only if your table names differ:
# ZETARIS_TABLES={"distributor_dispatches":"recall_distributor.dispatches","pharmacy_stock_events":"recall_pharmacy.stock_events","return_records":"recall_returns.return_notes"}
```

When all three `ZETARIS_*` values are present the mock is disabled automatically. Restart `npm run dev`.

### Verify it really works

1. **Command-line check (read-only):** `npm run zetaris:check`. It runs `SELECT 1`, `SHOW DATASOURCES`, a row count per source table, and the exact mapped query RecallReach uses for batch `DEMO-042`, with latencies. Expected for DEMO-042: 4 dispatches, 6 stock events, 4 return notes. Any failure prints its class and the script exits non-zero.
2. **Integrations → Run connection check.** Expect `CONNECTED · LAST CHECK PASSED` and a latency in the history table. Failures show their class (auth, unreachable, timeout, query failed, invalid response), and nothing is reported as connected.
3. Create a case with the scope `Example Pharma (fictional)` / `Nivara oral solution` / `DEMO-042` / `bottles`. Use **Import records → From a connected source** for all three sources. Expect 1,000 accepted, 40 awaiting containment, and each source tagged `ZETARIS` with its table and query ID.
4. Run the agent. Its `query_connected_source` steps show the table, row count and latency, without a `MOCK` label.
5. New evidence through Zetaris: `docker exec -i recallreach-sources psql -U postgres -d recall_pharmacy < integrations/zetaris/fixtures/02-followup-quarantine.sql` (run this in Ubuntu or Git Bash; PowerShell has no `<` redirection), then import *Pharmacy stock events* again. Rows already in the case are skipped; the new 40-bottle quarantine moves the case to 940 contained. To rehearse again, run `fixtures/03-reset-followup.sql` the same way and start a new case.

### Verification record (25 Oct 2026)

All against the local Zetaris 2.4.3 instance on this laptop, with the fictional fixture data. Nothing here involves real recall data.

| Check | Result |
| --- | --- |
| `verify.sh` (Zetaris's own) | 9 of 9 PASS |
| `npm run zetaris:setup` | 3 datasources created and their tables registered (7 statements). The check query through Zetaris returned DEMO-042 4, DEMO-043 1, VL-2207 5, VL-2207A 1, VL2207 1, as expected |
| `npm run zetaris:check` | All passed: `SELECT 1` in 272–282 ms; `SHOW DATASOURCES` lists the three; 12 / 18 / 6 rows in the three tables; the mapped DEMO-042 queries return 4 / 6 / 4 rows. Saved output: [`eval/zetaris-check-2026-10-25.txt`](../eval/zetaris-check-2026-10-25.txt) |
| Integrations → Run connection check | `CONNECTED · LAST CHECK PASSED`, live `SELECT 1` in 198 ms |
| New case, all three sources imported through Zetaris | 4 + 6 + 4 rows; 1,000 accepted; 900 contained (800 quarantined, 100 returned); 60 dispensed; **40 awaiting containment (RR-104)**; 4 records to review; 1 duplicate counted once. Matches the scenario's answer key |
| Live-model investigation (Groq, `openai/gpt-oss-120b`) on the imported case | Completed in 140 s: 9 tool steps, including `query_connected_source` against `recall_distributor.dispatches` (1 row, 401 ms; that row was already in the case from the import); 2 of 2 findings "verified" under the earlier free-text validator, which EVALUATION.md §4 says not to quote; 1 follow-up proposed for approval; 3 memories stored |
| Re-import with no new evidence | "no new rows. All 6 rows from Zetaris are already in this case"; nothing changed |
| Follow-up quarantine added to the pharmacy source, then re-imported | "1 new row imported from Zetaris; 6 already in this case skipped"; **940 contained (94%)**, 0 awaiting containment, 840 quarantined; review and duplicate counts unchanged (4 and 1); earlier memory notes marked for recheck |

Recorded with the code of 25 Oct 2026 morning. The import was then rebuilt as a complete, versioned read (above) and checked again against the same instance that evening: complete paged reads, the same case totals, an unchanged re-import, a new row, a row changed in place (imported as a new version, nothing double counted) and a removed row (reported, not reversed). See `eval/zetaris-import-check-2026-10-25.md`. Found and fixed during the first verification: the HTTP 400 "Not Allowed" answer to a wrong key (was reported as a failed query), datasource descriptions with spaces (Zetaris rejects them), and re-imports that added rows already in the case again (they inflated the review and duplicate counts but not the totals).

### Troubleshooting on this laptop (Windows 11 26H2, build 26300)

- **Docker Desktop crashes at start** with `remove …\Docker\run\<name>: The file cannot be accessed by the system`. On this Windows build Docker can create its AF_UNIX socket files but cannot delete them on its next start; WSL can. Start Docker with `powershell -ExecutionPolicy Bypass -File scripts\windows\start-docker-desktop.ps1` (it removes only those socket entries via WSL, starts Docker Desktop and waits until the engine stays up for a minute), not with the Docker Desktop icon.
- **WSL integration for Ubuntu** was off; it was enabled in Docker Desktop's `settings-store.json` (backup `settings-store.json.bak-2026-10-24`). Inside Ubuntu, `command -v docker` should print `/usr/bin/docker`.
- **`Wsl/Service/E_UNEXPECTED`** right after Docker applied the integration: `wsl --terminate Ubuntu` fixed it.
- **`preflight.sh` says not signed in** although you saw `Login Succeeded`: the login was run somewhere else (another terminal or account). Run it inside Ubuntu as yourself, without `sudo`.
- **"Unauthorized" on the Zetaris Cloud *Run locally* page** when you click *Get the platform*: your website session has expired, but the page doesn't send you back to the sign-in screen. Reload (F5), sign in again, and click it again.
- **The local Zetaris login says "Not Allowed"** although the password is right: three failed sign-ins (`LOGIN_ATTEMPTS_LIMIT` 3) lock the account, and the API log then says `User does not exist`. On a local instance you can clear the counter, which is what Zetaris itself does after a successful sign-in: `docker exec zetaris-postgres-1 psql -U zetaris -d metastore -c "DELETE FROM failed_login_attempt WHERE user_email = 'ADMIN@ZETARIS.COM'"`.
- **A wrong API key or organisation ID** gets HTTP 400 `{"msg":"Not Allowed"}` from the REST API. RecallReach shows it as an authentication failure; `set-zetaris-key.ps1` says "Test failed".
- **`CREATE DATASOURCE` fails with "Description is invalid"**: descriptions may contain only letters, digits and `_ . - ,` (no spaces).
- **After a restart:** start Docker with the helper script above, then run `bring-up.sh` again in Ubuntu. With the images already downloaded it takes a couple of minutes, re-runs `verify.sh` and re-attaches the fixture database.

### Mock mode

With `RECALLREACH_MOCK_SOURCES=1` and no Zetaris settings, the same interface serves the local fixtures. Everything it touches is labelled: the mode is `mock`, the source names carry `(MOCK fixture)`, the agent's tool output says `MOCK data … This is not a Zetaris query`, and Integrations shows `MOCK · NOT ZETARIS`. Mock activity is never counted as a Zetaris connection.

---

## 2. Meterless H-MEM

- Source: [Meterless/Meterless](https://github.com/Meterless/Meterless), `engines/hmem/reference/src`, commit `1742dec` (19 Oct 2026), Apache-2.0. Vendored **unmodified** in `vendor/meterless-hmem/`; `tests/memory.test.ts` checks every file against the upstream git-blob SHA-256 values in `SHA256SUMS`.
- Runtime fit: the reference engine has no runtime dependencies. RecallReach constructs it without `persistDir`, so it never touches a filesystem, and it runs inside the Cloudflare Worker. Its state (`store.snapshotAll()`) and trust ledger are stored in D1 table `case_memory` and restored on each request (`store.restoreAll()` plus ledger replay with the original timestamps). No extra service was needed.
- Upstream verification on 24 Oct 2026: `npm test` in `engines/hmem/reference` passed 10/10; the conformance suite run against the vendored copy (`HMEM_IMPL=…/vendor/meterless-hmem/src/index.ts npx tsx conformance/runner.ts`) passed 13/13.

How RecallReach uses it (`lib/recall/memory/hmem.ts`):

| H-MEM feature | RecallReach use |
| --- | --- |
| Records with mandatory `source`, `confidence`, `provenance.refs` | Validated typed facts (in RecallReach's wording) and operator decisions; `provenance.refs` holds each one's dependencies (case, shipment, record, or connected-source row with instance, table, key, content hash and capture time) |
| Hybrid retrieval (`HMEM.query`) scoped by `chatId` | Agent tool `recall_memory`, scoped to the case |
| `supersedes` / `supersededBy` lineage via `store.update` | When a dependency changes, a recheck note supersedes the old memory and quotes its text |
| Trust ledger | Every create, read, update and conflict is logged; summary shown in the UI |
| Conflict detection (`conflicts.scan`) | Detection only; contradictions are listed, never auto-resolved |
| Layers | Operator-approved decisions go to `long_term`; unreviewed agent findings stay in `working` |

RecallReach's own additions: dependencies per memory and a fingerprint of the case evidence they cover, rechecked on every read. Each memory is labelled `current` (every dependency checked and unchanged), `stale` (a dependency changed, including a connected-source row whose content changed or that a later complete read no longer returned), `superseded`, or `unknown` (nothing recorded to check, or a connected-source row not read again since it was captured; unknown is never shown as current). The label and its reason are shown to the agent and to the operator. Memory never feeds stock numbers, and the agent cannot cite a memory, or a record a memory merely names, as evidence.

Limits: upstream calls this a reference implementation, "not a production library", with a deterministic hash embedder rather than a learned embedding model. **Retention is bounded:** per case, D1 keeps the newest 200 memories and 800 ledger entries. Older ones are dropped; the number dropped is stored and shown in the memory panel, so the history is complete only until those limits are reached.

---

## 3. Language model

`lib/recall/agent/provider.ts` speaks the OpenAI-compatible chat-completions protocol with tool calling.

| Setting | Meaning |
| --- | --- |
| `AGENT_PROVIDER` | `groq` (default when `GROQ_API_KEY` is set), `openai`, `openrouter`, `nvidia`, `custom` or `none` |
| `AGENT_MODEL` | Required except for Groq (default `openai/gpt-oss-120b`, checked against Groq's model list on 24 Oct 2026) |
| `GROQ_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `NVIDIA_API_KEY` / `AGENT_API_KEY` | Server-side key |
| `AGENT_BASE_URL` | https base URL for `custom` |
| `AGENT_PRICE_INPUT_PER_MTOK`, `AGENT_PRICE_OUTPUT_PER_MTOK` | Optional; enables a cost estimate. No prices are assumed. |
| `AGENT_TIME_LIMIT_S` | Optional time limit for one live run, a whole number of seconds from 60 to 900. Default 480 for Groq, 240 for other providers. An invalid value falls back to the default and the reason is shown. |
| `AGENT_MAX_REQUEST_TOKENS` | Optional ceiling for one request (prompt plus `max_tokens`), a whole number from 7,000 to 2,000,000, or `none` (the fixed instructions, tool definitions and question are estimated at up to about 4,800 tokens before calibration, and an answer needs at least 900 more). Default 8,000 for Groq (its free tier refuses larger requests), none for other providers. |

**Cost observed:** all live runs so far used Groq's free tier: $0 charged. Groq's free tier limits each model to **8,000 tokens per minute** (read from response headers on 24 Oct 2026). A live run uses about 20–47k input tokens, so it spends most of its time waiting; the free tier also caps a day at **200,000 tokens**, which three or four runs can use up (seen on 25 Oct 2026), and a single request above 8,000 tokens is refused outright (HTTP 413). How the runner handles each:

- **Request size:** before every call it estimates the request's tokens (calibrated against the prompt tokens Groq reports) and keeps it under 92% of the ceiling. Tool results the model has already read become summaries first (oldest first; they can be fetched again), then the output allowance shrinks (not below 900 tokens), then older assistant text is dropped; results it has not yet read are summarised only if nothing else fits. Each result in a turn is capped so that all of that turn's results fit one request together. If Groq still refuses a request as too large, the runner recalibrates from the count Groq states, lowers the run's ceiling to the limit it states (or, with only a count, one token less; with neither, the refused request's estimate), records that ceiling on the run, and resends a smaller request (up to 3 times per run, not counted as model calls); an identical request is never resent.
- **Malformed tool calls** (Groq `tool_use_failed`): the first 3 in a run are retried at a higher temperature without using the model-call budget; after that each retry uses a model call, so the budget and the forced final answer still decide how the run ends.
- **Rate limits:** Groq's "try again in N s" is honoured; those waits do not count against the model-call budget and are recorded in the run.
- **Daily allowance** (tokens or requests per day): the run ends at once with a clear message instead of waiting.

Evidence counts as delivered to the model only when a request that carries the tool result in full has been answered, so a result that was only ever sent as a summary cannot support a fact.

Bounds per run (`DEFAULT_LIMITS` in `runner.ts`, with the provider's time and request limits for live runs): 10 model calls, 16 tool calls, 30 s per call, 480 s in total for Groq (240 s for other providers and rules mode), requests under 8,000 tokens for Groq, 1 retry for transient errors, 3 free retries for malformed tool calls, 3 smaller resends after a too-large refusal, 6 rate-limit retries of up to 30 s, up to 1,600 output tokens per call (as low as 900 when a request must fit the ceiling). When a budget runs low the model is told to finish, and the last call is forced to `submit_findings`.

NVIDIA: the `nvidia` preset targets NVIDIA's OpenAI-compatible endpoint, but **no NVIDIA model has been run or tested** with RecallReach. Do not claim NVIDIA use in the submission unless you configure it and record a run.
