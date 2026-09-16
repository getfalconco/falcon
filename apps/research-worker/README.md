# research-worker — compute API

The on-demand half of the engine. `apps/news-worker` runs continuously on a
timer; this service answers requests that need an LLM or take minutes, which
neither a phone nor a Netlify function can do.

## Why it exists

Mobile has no Electron main process, so every `window.meridian.*` call the
desktop makes has no equivalent. Reads are fine — those go straight to Supabase
under RLS. What needs a server is anything that spends money or time:

| Endpoint | Method | Auth | Does |
|---|---|---|---|
| `/health` | GET | none | Liveness + which job store is active |
| `/api/capabilities` | GET | none | Analysis kinds the server currently offers |
| `/api/research/start` | POST | JWT | Starts a Step-1 SEC extraction, returns `jobId` |
| `/api/research/status?jobId=` | GET | JWT | Durable job progress |
| `/api/research/jobs` | GET | JWT | Caller's Step-1 jobs (optional `?ticker=`) |
| `/api/research/latest?ticker=` | GET | JWT | Most recent job for a ticker |
| `/api/research/result?ticker=` | GET | JWT | Persisted relationship graph result |
| `/api/signal/analysis` | POST | JWT | Full LLM briefing for a signal |
| `/api/signal/follow-up` | POST | JWT | Analyst Q&A on a briefing |
| `/api/propagation/run` | POST | JWT | Kicks a propagation run (202 + `jobId`) |
| `/api/brokerage/list` | GET | JWT | SnapTrade brokerages the user can connect |
| `/api/brokerage/connect` | POST | JWT | Connection Portal URL (`{ broker?, redirectUrl? }`) |
| `/api/brokerage/status` | GET | JWT | Live accounts + persist `broker_links` snapshot |
| `/api/brokerage/disconnect` | POST | JWT | Drop a SnapTrade connection (`{ authorizationId }`) |

## Auth

Every non-health route requires `Authorization: Bearer <supabase access token>`.
The token is verified against Supabase's own `/auth/v1/user` (see `src/auth.ts`)
rather than by checking a signature locally, so this service never needs the
project's JWT secret. Waitlisted-but-unapproved accounts get a 403 — compute
costs money and shouldn't be spendable before approval.

## Job state

Long jobs write to `public.research_jobs` (`apps/desktop/supabase/research_jobs.sql`)
via the service-role key. The step1 engine still tracks progress in an
in-process `Map`; `trackStep1` mirrors that into the table so a client can keep
polling across a restart and the service can run more than one instance. RLS
On Step-1 **done**, the worker writes the full result onto the job row and
upserts relationship edges into `public.graph_edges` so desktop and mobile can
read the same map later.

Errors return `{ error: { code, message } }` — a short sentence for the user
and a `FAL-…` code the Falcon team can look up.

## Environment

```
PORT=8787                     # Railway injects this
SUPABASE_URL=
SUPABASE_ANON_KEY=            # used to verify caller tokens
SUPABASE_SERVICE_ROLE_KEY=    # used to write job rows + signals + broker secrets
ANTHROPIC_API_KEY=            # step1 extraction
SNAPTRADE_CLIENT_ID=          # brokerage connect (same keys as desktop)
SNAPTRADE_CONSUMER_KEY=
DATA_DIR=/data                # mount a volume; propagation reads/writes here
```

## Deploying

Railway builds one service per config. This worker needs its own service
pointing at `apps/research-worker/Dockerfile` with root directory `/` (repo
root). The repo-root `railway.json` is wired for this HTTP API; run
`apps/news-worker` as a **separate** Railway service using
`apps/news-worker/railway.json` (no public port).

Mount a volume at `DATA_DIR`, set the env below, and expose port `8787`.
Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to the resulting URL.

Until then, failed Analyze calls show a short explanation plus a `FAL-…` ref
code. Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` (and
`RESEARCH_WORKER_URL` in `apps/desktop/.env`) to the worker URL.

## Local

```bash
pnpm dev:research-worker      # tsx watch on :8787
curl localhost:8787/health
```
