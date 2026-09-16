# Meridian (internally branded "Falcon")

AI equity-research platform. Extracts relationship graphs from SEC filings,
generates multi-pass LLM company reports, produces a daily "top signal", and
propagates news events across the relationship graph into **second-order
signals**. Product strings often say **"Falcon"**; the package/repo is `meridian`.

## Monorepo layout (pnpm + Turborepo)

```
packages/research      Core "brain" (@meridian/research) — all LLM/data logic
apps/desktop           Electron + React desktop app (the actual product)
apps/web               Next.js marketing + auth/waitlist site (Netlify)
apps/research-worker   Tiny Node http server (:8787) exposing the step1 engine
packages/ui            Shared React components + design tokens
packages/tailwind-config  Shared Tailwind preset
```

## Core: `packages/research/src` (barrel: `index.ts`)

| Subsystem | Purpose | Entry | LLM |
|---|---|---|---|
| `analyze/` | ~18-phase company report (pass0→pass7 → scoring → merge) → `MeridianReport` | `runMeridianPipeline` (`analyze/pipeline.ts`) | OpenAI gpt-4o + Perplexity |
| `council/` | Multi-persona deliberation layered on analyze (institutional tier) | `runCouncil` / `runDeepResearchPipeline` | OpenAI + live Perplexity |
| `dailySignal/` | Daily single "top signal" + validation/decision layer | `generateDailyTopSignal` | Perplexity discovery + OpenAI |
| `step1/` | SEC 10-K/20-F → counterparty relationship graph (async job engine) | `startResearchJob` (`step1/jobs.ts`) | **Anthropic** claude-sonnet-4-5 |
| `propagation/` | News event + graph → multi-hop traversal → LLM judge → `SecondOrderSignal` | `runPropagation` (`propagation/run-propagation.ts`) | OpenAI judge |
| `tracker/` | Engine1 deterministic monitor: news/filings/insiders/quant → `TrackerMessage` stream | `getTrackerEngine` (`tracker/engine.ts`) | none |
| `base/` | Deterministic coordination: messages → incidents → priority → routing (replay-only today); B9 classifier re-score + `propagation_candidates` | `replayBase` (`base/replay.ts`) | none |
| `classifier/` | Classifier spec v1.0: news / unmapped 8-K → per-ticker relevance·materiality·direction + event_type verdict; validators, verdict store, breaker, eval gate | `ClassifierService` (`classifier/service.ts`) | **Anthropic** claude-haiku-4-5 (structured JSON, temp 0) |

- Config / model selection / env: `config.ts` (`loadConfig`, `ResearchTier` = standard|deep|institutional).
- Central streaming contract: `StreamEvent` in `types.ts` — emitted by the pipeline,
  forwarded over IPC channel `research:event`, consumed by `useResearchAnalysis.ts`.
- Providers called: OpenAI, Perplexity, Anthropic, Massive (market data), Finnhub (news), SEC EDGAR.

## Desktop: `apps/desktop/src`

- `main/` — Electron main. Entry `main/index.ts` (frameless 1060×680 window) registers
  IPC per domain: stock, research, step1, graph, events (Finnhub news → propagation),
  propagation, daily-signal, tracking agents, calendar, tracker (Shift+T panel), base (Shift+B
  panel, replay-only), classifier (`main/classifier/classifier-host.ts` — Phase A loop, off by
  default via `data/classifier/config.json` `enabled`; Phase B re-score via Base config
  `classifier.rescoreEnabled`; both toggles live in the Base panel's "classifier" tab).
  IPC helper: `main/ipc-register.ts`.
- `preload/index.ts` — the full IPC surface via `contextBridge.exposeInMainWorld("meridian", …)`.
- `renderer/` — React + Vite; Supabase-session gated (Login → Home). Domain-grouped
  `components/`, `hooks/` (`useResearchAnalysis`, `useTopSignal`), `lib/` (`supabase.ts`).
- `shared/` — desktop-side mirror of research contracts (`research-types.ts`,
  `propagation-types.ts`, `top-signal.ts`, `graph-types.ts`, `step1-research.ts`) so the
  renderer/main don't import the Node-only research package directly.

**Persistence:** No local SQL DB. (a) **Supabase** — renderer uses `@supabase/supabase-js`
with the anon key (`VITE_SUPABASE_*`) for auth; main process uses raw REST with the
service-role key for privileged writes (signal cache, tracking agents). (b) **Local JSON
files** on disk under a runtime `data/` dir (events, signals, step1 cache).

## Commands

```bash
pnpm install          # installs + wires git hooks
pnpm dev:desktop      # run the Electron app
pnpm dev:web          # run the marketing site (http://localhost:3000)
pnpm dev:research-worker
pnpm build            # turbo build all
pnpm lint             # turbo lint all
pnpm seed / graph / backfill-strength / propagate   # research data scripts (scripts/*.ts)
```

Tests: Vitest lives next to source as `*.test.ts` (heavy coverage in `dailySignal/`,
`propagation/`, `step1/`). Run within a package, e.g.
`pnpm --filter @meridian/research test`.

## Conventions / gotchas

- **Secrets live only on the worker/main process.** API keys (OpenAI, Perplexity,
  Anthropic, Massive, Finnhub) must never reach the renderer. Renderer gets Supabase
  anon key + RLS only. `apps/desktop/.env` currently holds real keys — keep it out of any
  shared output.
- Line endings: repo is LF; on Windows git warns about CRLF conversion — harmless.
- On `git push`/`pull`, a Discord webhook posts one Turkish line (`.githooks`, `.env.discord`).
- Product naming is inconsistent (Meridian vs Falcon) — match whatever the file already uses.

## In-progress work (as of 2026-07)

Uncommitted branch work adds **edge-strength scoring** end to end: `step1/strength.ts`
(new) classifies relationship edges into critical/important/marginal tiers; propagation
`traverse.ts` uses strength in path scoring; the desktop `OpenSignalsCard.tsx` +
`renderer/lib/open-signals.ts` surface "open signals". Script `scripts/backfill-edge-strength.ts`
backfills strength onto pre-existing graph edges. The dashboard "Today's Signal" cards
area was churned by the propagation commit (see the revert in git log) and may be unfinished.
