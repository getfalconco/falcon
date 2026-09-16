# falcon-engine

The deterministic chain — **Tracker → Classifier → Base → Propagation** — running
24/7, independent of whether anyone has the desktop app open.

## Why it exists

The chain used to live in the Electron main process. Measured on the live store,
that cost a **median 43.5 hours** between an article being published and the run
that reacted to it: the message stream only advanced while the app was running
(20 gaps over 60 minutes, the largest 28.8 h), so by the time a second-order move
was found it was already priced. This service runs the same hosts, on the same
code, without waiting for anyone.

## What it owns

* the **Tracker** poll loop — news, filings, insiders, quant, gap events
* the **Classifier** Phase A cycle (Anthropic, budgeted by Base)
* the **Propagation** cycle, the event-driven fast path, and the reprice sweep
* the shared mirrors — `propagation_runs` and `tracker_universe` — written with
  the service-role key

The desktop does **not** run any of it when `FALCON_ENGINE_URL` is set: two
chains would double the Finnhub quota and the Anthropic budget and produce two
divergent message streams, so the same event would end up with two incident ids
and two runs.

## HTTP surface

`GET /health` is open (Railway's healthcheck runs before any user exists).
Everything else requires a **signed-in, approved** Supabase user — the same
check `apps/research-worker` makes, for the same reason: this box holds the
provider keys and every cycle spends real money.

| Route | Purpose |
|---|---|
| `GET /health` | version, uptime, tracked tickers, run count, loop state |
| `GET /status` | propagation + classifier + tracker status |
| `GET /runs?limit=&synthetic=` | run list rows |
| `GET /run?id=` | one run and its incident chain |
| `GET /absorption?run=&target=` | the day-0/day-1 absorption curve |
| `GET /pair?root=&target=` | the pair record between two names |
| `POST /run-cycle` | the desktop's "Run now" |
| `POST /fast-path` `{ticker}` | force the fast lane for one ticker |
| `POST /set-enabled` `{enabled}` | the Phase A loop switch |
| `GET /channels` | the implemented channel names |
| `POST /channel` `{channel, args}` | one allowlisted desktop channel |

`/channel` is how the desktop panels keep the contract they already had: the
renderer asks for `propagation:runs` exactly as before, and the main process
forwards it here instead of answering locally. The allowlist lives in
`@meridian/research/engine-channels` and types the handler map, so a channel the
desktop forwards but this service does not implement is a **compile error**, not
a 404 discovered in production.

## Deploy (Railway)

* Root Directory `/` (repo root), Dockerfile Path `apps/falcon-engine/Dockerfile`
* **Mount a volume at `/data`.** The Tracker's message log and per-ticker state,
  the Classifier's verdicts and the propagation run store all have to survive a
  restart, or the chain re-learns the world — and re-spends the budget — on
  every deploy.

Set `FALCON_PROPAGATION_ENABLED=true` to start the Phase A loop with the
service. The desktop toggles it from the Shift+P panel and keeps the answer in
a config file; a service has no panel and its config file arrives baked into
the image, so the deployment says it instead. Boot only — the panel can still
turn the loop on at runtime and nothing here undoes that until a restart.

Env: `FINNHUB_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY` (verifies user tokens), `SUPABASE_SERVICE_ROLE_KEY`
(privileged writes). Data dirs and `FALCON_GRAPH_PATH` are set by the Dockerfile.

Then point the desktop at it with `FALCON_ENGINE_URL=https://…`. Without that
var the app runs the chain locally exactly as before, which is also the fallback
if the service is unreachable at boot.
