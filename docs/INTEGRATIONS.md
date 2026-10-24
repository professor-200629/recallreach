# Integrations: setup and verification

RecallReach uses three external pieces. Each one is optional at runtime, and the app says plainly when one is missing, mocked or failing.

| Piece | Role | Status on 24 Oct 2026 |
| --- | --- | --- |
| Zetaris | Federated, read-only access to separately owned source systems | Adapter built and contract-tested. **Not connected**: no Zetaris instance has been reachable yet. |
| Meterless H-MEM | Investigation memory across runs | **In use**: vendored, unmodified reference engine; upstream conformance suite 13/13. |
| Language model (Groq, OpenAI-compatible) | Chooses tools and explains evidence | **Working** with Groq free tier, `openai/gpt-oss-120b`. Rules mode works with no model. |

All secrets are read on the server from Worker bindings (`.dev.vars` locally). None are sent to the browser, written to exports or included in error messages.

---

## 1. Zetaris

### What RecallReach does with it

A recall investigation needs records from systems that are owned by different organisations and were never one dataset: the distributor's dispatch log, each pharmacy's stock system and the returns desk. RecallReach queries each through Zetaris with a fixed, code-owned `SELECT` (see `lib/recall/sources/external.ts`):

- Only `SELECT` statements written in code. The model and the operator supply filter values only (batch, shipment ID). Values are restricted to `[A-Za-z0-9 ._()/-]` and quote-escaped; table names come from server configuration and must be plain identifiers.
- Every query is bounded (`LIMIT` ≤ 500) and times out after 20 s.
- Each source keeps its native column names. The mapping to RecallReach's ledger columns, and the assumption it makes, is stated per source and shown to the agent and in the audit trail. For example, a return note is mapped to quarantined → returned, because the register does not record the prior state.
- Imported rows become a new evidence source with system, mode, table, query ID, fetch time, latency and SQL attached. Re-imported identical rows are counted once.
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

`tests/zetaris.test.ts` checks this request shape, positional row mapping, exponent-format numbers (`4.0E1` → 40), failure classes (auth, timeout, unreachable, bad shape) and SQL-injection resistance with a fake `fetch`. It does not prove compatibility with a real instance.

### Setting up a local instance (your steps)

Zetaris requires an account, a licence acceptance and registry credentials that only you can obtain. The steps below follow the official guide, [`docs/install/updated_zetaris_installation_guide.md`](https://github.com/zetaris/getting-started/blob/main/docs/install/updated_zetaris_installation_guide.md). It was checked unchanged at upstream commit `6a2fbaa` on 24 Oct 2026. Run the shell commands in **WSL2 (Ubuntu)**, not PowerShell.

**Machine check (24 Oct 2026).** Docker Desktop 4.64.0, Compose v5.1.0, WSL 2.6.3 with Ubuntu on WSL2. No `.wslconfig`, so WSL's default cap is 7.7 GB, the same memory Zetaris's own install test used. The test record measures the Zetaris containers at about 1.9 GiB idle and 2.3 GiB after queries; plan for about 4 GB of free Windows memory while it runs. Ports 3000, 8888, 10000 and 5433 were free. A native PostgreSQL already uses 5432.

1. **Account.** Register at <https://cloud.enterprise.zetaris.com/register> (or Zetaris Cloud → *Start Free*). Read the [terms](https://cloud.enterprise.zetaris.com/terms) and [privacy policy](https://cloud.enterprise.zetaris.com/privacy) yourself. Without an order, the agreement allows internal evaluation for up to 30 days.
2. **Bundle and registry login.** Open the *Run locally* page, <https://cloud.enterprise.zetaris.com/dashboard/download>. Download `zetaris-platform.zip` and keep the registry sign-in command it shows. That page also lists the current startup steps; if they differ from these, follow the page.
3. **Free memory, then start Docker Desktop.** Close what you don't need (on this laptop: ChatGPT, Notion, Wispr Flow, spare Edge windows). Start Docker Desktop and wait until it shows *Engine running*. In Settings → Resources → WSL integration, make sure **Ubuntu** is enabled.
4. **Unpack in Ubuntu** (`unzip` isn't installed yet; the first command asks for your Linux password):
   ```bash
   sudo apt-get update && sudo apt-get install -y unzip
   mkdir -p ~/zetaris && cp /mnt/c/Users/Balu/Downloads/zetaris-platform.zip ~/zetaris/
   cd ~/zetaris && unzip zetaris-platform.zip && cd zetaris-platform
   docker version && docker compose version
   ```
5. **Registry login.** Paste the `docker login zetarishackathon.azurecr.io` command from the *Run locally* page and type the credentials at the prompt. Never paste them into a chat or a file.
6. **Preflight:** `./preflight.sh` (or `bash preflight.sh`). A warning that memory is below 8 GB is expected with the 7.7 GB default; the official test passed with the same warning. Fix any failure before continuing.
7. **Configure `.env`** (in `~/zetaris/zetaris-platform`, e.g. `nano .env`). Keep the supplied image settings and set:

   | Variable | Value |
   | --- | --- |
   | `ZETARIS_ADMIN_EMAIL` | your administrator email |
   | `ZETARIS_ADMIN_PASSWORD` | your own password: ≥ 8 characters, lowercase, uppercase, a digit and one of `@ ! % * ? &` (avoid `$`, which the shell may expand) |
   | `ZETARIS_ADMIN_ORG` | an organisation name, e.g. `recallreach` (choose before first start) |
   | `ZSPARK_DRIVER_MEM` / `ZSPARK_DRIVER_CORES` / `ZSPARK_MASTER_URL` / `ZETARIS_API_MAX_HEAP` | `2g` / `2` / `local[2]` / `1g` |
   | `UI_PORT` | `127.0.0.1:3000` (this machine only, as in the official test) |
   | `ALLOWED_ORIGINS` and `GUI_URL` | `http://localhost:3000` |
   | `COMPOSE_PROFILES` | empty |
   | `ZETARIS_SEED_TPCH` | `true` |

   Then `chmod 600 .env && docker compose config --quiet`.
8. **Pull and start** (the first pull downloads about 4 GB): `docker compose pull && docker compose up -d`. Wait until `docker compose ps --all` shows `init` and `bootstrap` as `Exited (0)` and the other services healthy, then run `./verify.sh`; expect 9 of 9 checks to pass.
9. **First login.** Open <http://localhost:3000>, sign in as the administrator and run `SELECT 1 AS one` in the SQL Editor.

### Load the fictional source systems

From the RecallReach folder (PowerShell or WSL):

```bash
docker compose -f integrations/zetaris/docker-compose.yml up -d
docker network ls --filter name=zetaris
docker network connect --alias recallreach-sources <network-from-the-previous-command> recallreach-sources
```

This starts PostgreSQL as container `recallreach-sources`, with three databases and a read-only login, `recallreach_reader`. It publishes `127.0.0.1:5433` on this machine only, for inspection. The `docker network connect` command puts it on the Zetaris Compose network, so the Zetaris engine reaches it as `recallreach-sources:5432` without exposing it on your LAN. The fixture SQL is generated from the same fictional scenarios the app uses (`npm run zetaris:fixtures`):

| Database.table | System it stands for | Native columns |
| --- | --- | --- |
| `recall_distributor.dispatches` | Distributor ERP | dispatch_id, consignment_ref, batch_no, qty, consignee, invoice_no, dispatched_at |
| `recall_pharmacy.stock_events` | Pharmacy stock systems | txn_id, consignment_ref, from_status, to_status, qty, pharmacy_name, doc_ref, recorded_at |
| `recall_returns.return_notes` | Distributor returns desk | rma_id, consignment_ref, qty, returned_from, rma_ref, received_at |

Then, in the Zetaris SQL Editor as administrator, run the statements in [`integrations/zetaris/setup-datasources.sql`](../integrations/zetaris/setup-datasources.sql) one at a time: three `CREATE DATASOURCE`, three `REGISTER DATASOURCE TABLES`, and a read-only check. If the check says *table not found*, run `SHOW DATASOURCE TABLES recall_distributor` and use the qualified names it shows in `ZETARIS_TABLES` (below). The `<datasource>.<table>` names follow the Zetaris command reference but were not yet checked against a running instance.

**API key.** In the Zetaris UI, open Management → API Tokens, click **+**, and copy the key; it is shown once. The key carries the permissions of the user who created it. RecallReach only ever sends fixed, read-only SELECTs, but an administrator key could do more if it leaked. **Least privilege (recommended beyond a local demo):** create a non-administrator user with SELECT on these three datasources only (Management → Users, Access Control), and create the key while signed in as that user.

### Configure RecallReach

Add to `.dev.vars` (gitignored; never paste the key into a chat or commit it):

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
5. New evidence through Zetaris: `docker exec -i recallreach-sources psql -U postgres -d recall_pharmacy < integrations/zetaris/fixtures/02-followup-quarantine.sql`, then import *Pharmacy stock events* again. Existing rows count once as duplicates; the new 40-bottle quarantine moves the case to 940 contained.

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
| Records with mandatory `source`, `confidence`, `provenance.refs` | Verified agent findings, open questions and operator decisions, each citing evidence record IDs |
| Hybrid retrieval (`HMEM.query`) scoped by `chatId` | Agent tool `recall_memory`, scoped to the case |
| `supersedes` / `supersededBy` lineage via `store.update` | When cited evidence changes, a recheck note supersedes the old memory; nothing is deleted |
| Trust ledger | Every create, read, update and conflict is logged; summary shown in the UI |
| Conflict detection (`conflicts.scan`) | Detection only; contradictions are listed, never auto-resolved |
| Layers | Operator-approved decisions go to `long_term`; unreviewed agent findings stay in `working` |

RecallReach's own additions: an evidence fingerprint per memory, covering the cited records and every record on the shipments the memory is about. It is used to label each memory `current`, `stale` or `superseded` against today's evidence, and the label is shown to the agent and to the operator. Memory never feeds stock numbers; the agent is told that current records win.

Limits: upstream calls this a reference implementation, "not a production library", with a deterministic hash embedder rather than a learned embedding model. The ledger kept in D1 is capped at 800 entries per case (older entries are counted as dropped and the count is shown).

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

**Cost observed:** all live runs so far used Groq's free tier: $0 charged. Groq's free tier limits each model to **8,000 tokens per minute** (read from response headers on 24 Oct 2026). A live run uses about 25–30k input tokens, so it spends most of its time (up to about 4 minutes) waiting. The runner honours Groq's "try again in N s", does not count those waits against the model-call budget, and records the waiting time in the run.

Bounds per run (`DEFAULT_LIMITS` in `runner.ts`): 10 model calls, 16 tool calls, 30 s per call, 240 s in total, 1 retry for transient errors, 6 rate-limit retries of up to 30 s, 1,600 output tokens per call. When a budget runs low the model is told to finish, and the last call is forced to `submit_findings`.

NVIDIA: the `nvidia` preset targets NVIDIA's OpenAI-compatible endpoint, but **no NVIDIA model has been run or tested** with RecallReach. Do not claim NVIDIA use in the submission unless you configure it and record a run.
