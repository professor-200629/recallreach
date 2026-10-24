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

Zetaris requires an account and registry credentials that only you can obtain. Follow the official guide, `docs/install/updated_zetaris_installation_guide.md` in [zetaris/getting-started](https://github.com/zetaris/getting-started):

1. Register at Zetaris Cloud and download `zetaris-platform.zip` from the *Run locally* page. The licence allows internal evaluation for 30 days without an order.
2. Start Docker Desktop with **at least 8 GB of memory and 4 CPUs** allocated (this machine has 15.5 GB in total). Run the commands from WSL2.
3. `docker login zetarishackathon.azurecr.io`, then `./preflight.sh` and `docker compose up -d` inside the bundle folder.
4. Sign in to the UI (`http://localhost:3000`) and run `SELECT 1` in the SQL Editor.

### Load the fictional source systems

From the RecallReach folder:

```bash
docker compose -f integrations/zetaris/docker-compose.yml up -d
```

This starts PostgreSQL on `127.0.0.1:5433` with three databases and a read-only login, `recallreach_reader`. The fixture SQL is generated from the same fictional scenarios the app uses (`npm run zetaris:fixtures`):

| Database.table | System it stands for | Native columns |
| --- | --- | --- |
| `recall_distributor.dispatches` | Distributor ERP | dispatch_id, consignment_ref, batch_no, qty, consignee, invoice_no, dispatched_at |
| `recall_pharmacy.stock_events` | Pharmacy stock systems | txn_id, consignment_ref, from_status, to_status, qty, pharmacy_name, doc_ref, recorded_at |
| `recall_returns.return_notes` | Distributor returns desk | rma_id, consignment_ref, qty, returned_from, rma_ref, received_at |

Then, in the Zetaris SQL Editor as an administrator, run one statement at a time:

```sql
CREATE DATASOURCE recall_distributor DESCRIBE BY "Fictional distributor ERP (RecallReach demo)" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://host.docker.internal:5433/recall_distributor", username "recallreach_reader", password "recallreach-demo-only")
REGISTER DATASOURCE TABLES FROM recall_distributor
CREATE DATASOURCE recall_pharmacy DESCRIBE BY "Fictional pharmacy stock systems (RecallReach demo)" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://host.docker.internal:5433/recall_pharmacy", username "recallreach_reader", password "recallreach-demo-only")
REGISTER DATASOURCE TABLES FROM recall_pharmacy
CREATE DATASOURCE recall_returns DESCRIBE BY "Fictional returns desk (RecallReach demo)" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://host.docker.internal:5433/recall_returns", username "recallreach_reader", password "recallreach-demo-only")
REGISTER DATASOURCE TABLES FROM recall_returns
SELECT * FROM recall_distributor.dispatches LIMIT 5
```

If the last query says *table not found*, run `SHOW DATASOURCE TABLES recall_distributor` and use the qualified names it shows in `ZETARIS_TABLES` (below). The names above follow the `<datasource>.<table>` form in the Zetaris command reference, but they have not been checked against a running instance.

**Least privilege (recommended).** Create a non-administrator Zetaris user for RecallReach with SELECT on these three datasources only (Management → Users, Access Control). Create its API key under Management → API Tokens while signed in as that user.

### Configure RecallReach

Add to `.dev.vars` (never commit it):

```
ZETARIS_REST_URL=http://localhost:8888/api/v1.0
ZETARIS_ORG_ID=<numeric ID from Management → Organisation>
ZETARIS_API_KEY=<key from Management → API Tokens>
# only if your table names differ:
# ZETARIS_TABLES={"distributor_dispatches":"recall_distributor.dispatches","pharmacy_stock_events":"recall_pharmacy.stock_events","return_records":"recall_returns.return_notes"}
```

When all three `ZETARIS_*` values are present the mock is disabled automatically. Restart `npm run dev`.

### Verify it really works

1. **Integrations → Run connection check.** Expect `CONNECTED · LAST CHECK PASSED` and a latency in the history table. Any failure shows its class (auth, unreachable, timeout, query failed, invalid response) and nothing is reported as connected.
2. Create a case with the scope `Example Pharma (fictional)` / `Nivara oral solution` / `DEMO-042` / `bottles`. Then use **Import records → From a connected source** for all three sources. Expect 1,000 accepted, 40 awaiting containment, and each source tagged `ZETARIS` with its table and query ID.
3. Run the agent. Its `query_connected_source` steps show the table, row count and latency, without a `MOCK` label.
4. New evidence through Zetaris: `docker compose -f integrations/zetaris/docker-compose.yml exec -T sources psql -U postgres -d recall_pharmacy < integrations/zetaris/fixtures/02-followup-quarantine.sql`, then import *Pharmacy stock events* again. Existing rows count once as duplicates; the new 40-bottle quarantine moves the case to 940 contained.

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

**Cost observed:** all live runs so far used Groq's free tier: $0 charged. Groq's free tier limits each model to **8,000 tokens per minute** (read from response headers on 24 Oct 2026). A live run uses about 25–30k input tokens, so it spends most of its 1–3 minutes waiting. The runner honours Groq's "try again in N s", does not count those waits against the model-call budget, and records the waiting time in the run.

Bounds per run (`DEFAULT_LIMITS` in `runner.ts`): 10 model calls, 16 tool calls, 30 s per call, 240 s in total, 1 retry for transient errors, 6 rate-limit retries of up to 30 s, 1,600 output tokens per call. When a budget runs low the model is told to finish, and the last call is forced to `submit_findings`.

NVIDIA: the `nvidia` preset targets NVIDIA's OpenAI-compatible endpoint, but **no NVIDIA model has been run or tested** with RecallReach. Do not claim NVIDIA use in the submission unless you configure it and record a run.
