# Running and deploying RecallReach

## Status (24 Oct 2026)

- **Local:** reproducible and verified on Windows 11, Node 24.14 (steps below).
- **Hosted:** **not deployed.** There is no live URL. The project keeps its original hosting identity, an OpenAI Sites project (`.openai/hosting.json`, project `appgprj_6adbc4…`). Sites publishing is done from Codex with the Sites plugin, which was not available in this build session.

## Run locally

Requirements: Node.js ≥ 22.13 (tested on 24.14), npm, Git. No Docker is needed unless you run Zetaris.

```bash
npm ci
cp .dev.vars.example .dev.vars        # then edit: GROQ_API_KEY is optional
npm run build                         # once, creates dist/server/wrangler.json
npm run db:migrate:local              # applies drizzle/*.sql to the local D1 (idempotent)
npm run dev                           # http://localhost:5173
```

Open `http://localhost:5173/signin-with-chatgpt?return_to=/`. In development this signs you in as the local test user `Seedy` (loopback only, not in production builds). Then choose **Explore a mock recall**, or **New case → Fictional training drills**.

Checks:

```bash
npm test            # 60 tests (node:test, Node's built-in SQLite for server tests)
npm run typecheck   # tsc --noEmit
npm run eval        # fixture evaluation vs the batch-lookup baseline -> eval/results.json
```

Local data lives in `.wrangler/state` (gitignored). Delete that folder to start fresh, then rerun `npm run db:migrate:local`.

## Option A — OpenAI Sites (keeps the existing hosting identity)

1. Open this folder in Codex with the Sites plugin and publish with its skill. The build copies `drizzle/` into `dist/.openai/`, and per the starter README Sites applies production migrations itself.
2. Sign-in is provided by Sites (*Sign in with ChatGPT*). Identity headers are injected by the Sites dispatcher, which is what makes `app/chatgpt-auth.ts` safe.
3. Secrets (`GROQ_API_KEY`, `ZETARIS_*`): **unverified** whether and how Sites lets you set Worker secrets. If it does not, the hosted app still works in rules mode with Zetaris shown as not configured.
4. Zetaris must be reachable from the hosted Worker, so a local Docker instance on your laptop will not work for a hosted app. Use the Zetaris AWS cluster route for that.

## Option B — Cloudflare Workers under your own account (needs an auth change first)

The Worker builds for Cloudflare (`npm run build` → `dist/server`). **Do not deploy it as-is.** Outside the Sites dispatcher nothing strips the `oai-authenticated-user-*` headers, so anyone could forge an identity. Before using this route:

- Put the app behind Cloudflare Access and change `identify()` in `lib/recall/server.ts` to verify the `Cf-Access-Jwt-Assertion` JWT (issuer, audience, signature) instead of reading Sites headers, or
- replace sign-in with another verified provider.

Then create a D1 database, set the binding `DB`, apply `drizzle/*.sql` with `wrangler d1 migrations` or `wrangler d1 execute --remote`, and set secrets with `wrangler secret put`. Cloudflare's free Workers plan limits CPU time per request; a large case may need the paid plan. This has not been measured.

## Costs

| Item | Cost observed or expected |
| --- | --- |
| Local development | $0 |
| Groq live model runs (free tier) | $0 so far; limited to 8,000 tokens/min per model |
| Zetaris local Docker | $0 software for a 30-day internal evaluation (per its install guide) |
| Zetaris on AWS (needed for a hosted demo) | Zetaris's guide estimates about $80 of AWS credit for a Mini cluster running a week; a new AWS account's free credits can cover it |
| OpenAI Sites hosting | Unknown; check your Sites plan |
| Cloudflare Workers + D1 | Free tier likely sufficient for a demo; CPU limits unmeasured |
