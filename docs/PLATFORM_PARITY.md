# Platform parity: keeping desktop and mobile in sync

**The rule: capabilities and the research pipeline stay 1:1. Layout on the
phone may diverge on purpose.**

A feature change on one client must land on the other in the same pull request,
unless it is explicitly marked platform-only. The **engine** — model selection,
SEC extraction, Falcon graph search — is not reimplemented per client. Mobile
and desktop both call `apps/research-worker`, which runs `@meridian/research`
unchanged.

The **phone layout is allowed to look different.** An investor on Falcon mobile
is triggering an analysis from their pocket to read later at a desk, not doing
dense work on a small screen. Cloning the desktop instrument panel onto a phone
is the rejected approach.

## Which apps this covers

| App | What it is | In scope for parity |
|---|---|---|
| `apps/desktop` | Electron + React. **This is the product.** | ✅ Yes |
| `apps/mobile` | Expo / React Native. The same product on a phone. | ✅ Yes |
| `apps/web` | Marketing site + auth/waitlist + admin panel (Next.js, Netlify) | ⚠️ Partial — see below |
| `apps/news-worker` | Headless engine on Railway | ➖ Backend |
| `apps/research-worker` | Local dev HTTP server for the step1 engine | ➖ Backend |

`apps/web` is **not** the product — it is the public site. It shares parity with
mobile only for the **onboarding, waitlist and auth flow** (the signup funnel
exists on both). Product screens — dashboard, signals, events, agents — live in
`apps/desktop` and `apps/mobile`, and those two are what must mirror each other.

## What has to stay in sync

**1. Capabilities.** If desktop can start a Step-1 analysis, mobile can too —
through the same worker. Screens may be simpler on the phone (progressive
disclosure instead of the full edges table).

**2. Copy for shared facts.** Error *meanings* stay aligned. User-facing
failures use a short sentence plus a `FAL-…` ref code (see
`apps/research-worker/src/errors.ts` and the mirrored catalogs on each client).

**3. Design tokens — one canvas, two palettes.** The **page background is
shared**: `#eaeae6`, the colour the desktop window paints (Electron
`backgroundColor` in `apps/desktop/src/main/index.ts` and `--background:
60 10% 91%` in `globals.css`), mirrored by `COLORS.bg` and `PRODUCT.bg` in
`apps/mobile/src/theme.ts`. If that canvas moves on one client, move it on the
other. Everything **on top of** the canvas still diverges by design: mobile
speaks a pocket language (white cards, soft shadows, black selection pills,
giant numerals, floating circular nav); desktop keeps the dense instrument
panel. Do **not** force those two layers to match. Market colors (gain/loss)
should read the same on both.

Note that mobile onboarding no longer matches the marketing site's `#fcfcfa`
canvas — it follows the desktop/product canvas instead.

**4. Business logic and thresholds.** Anything that decides *what the user is
told* must produce the same answer on both clients. Today that means the
helpers in `apps/desktop/src/renderer/lib/open-signals.ts` — `MIN_CONF`, the
24-hour window, `shortMechanismLine` — which are ported verbatim into
`apps/mobile/src/lib/signals.ts`. If you tune a threshold, tune both.

**5. Data contracts and the pipeline.** The deterministic chain — Tracker →
Classifier → Base → Propagation — runs on **one box**, `apps/falcon-engine` on
Railway, and both clients read it rather than reproducing it. Desktop points
`FALCON_ENGINE_URL` at it and forwards its panel channels there; mobile calls
the same service directly over HTTP (`EXPO_PUBLIC_ENGINE_URL`, see
`apps/mobile/src/lib/engine.ts`). Auth on both sides is the user's own Supabase
JWT — the service verifies it and requires an approved account, so no provider
key is ever on a client. The pure shaping over those runs (which run the card
speaks for, how a day is coloured) lives in
`apps/desktop/src/renderer/lib/second-order-card.ts` and is ported verbatim into
`apps/mobile/src/lib/propagation-runs.ts`; tune one, tune both.

Both clients also read the same Supabase
tables (`daily_top_signals`, `second_order_signals`, `tracking_agents`,
`onboarding_responses`, `research_jobs`, `graph_edges`, `paper_portfolios`,
`broker_links`). Step-1 always runs
inside `@meridian/research` via the worker (desktop falls back to in-process
only if the worker is unreachable). `GET /api/capabilities` is the bridge so
mobile renders whatever the server advertises — new analysis kinds do not
require a mobile code change for model names.

## The exception: platform-only features

Some things genuinely belong to one platform. That is fine — but it must be
**stated in code**, not left implicit. Mark it with a comment at the top of the
component or module:

```ts
// PLATFORM-ONLY: desktop.
// Reason: depends on the Electron main process for local filesystem access.
```

```ts
// PLATFORM-ONLY: mobile.
// Reason: push notifications have no desktop equivalent yet.
```

Legitimate reasons include: a native capability the other platform lacks (push
notifications, biometric unlock, menu-bar integration), something that needs
Electron's Node main process, or a screen that is genuinely unusable at the
other form factor. "We didn't get to it yet" is **not** a platform-only
exception — that is a tracked gap (see below).

## Known gaps right now

These are **not** accepted divergences. They are work-in-progress and should
close.

| Capability | Desktop | Mobile | Blocker |
|---|---|---|---|
| Dashboard, Signals list, Signal detail, Agents | ✅ | ✅ | — |
| Brokers (Falcon paper + SnapTrade live) | ✅ Add asset | ✅ Settings → Brokers | `paper_portfolios` + `broker_links` |
| Step-1 Analyze (SEC relationship map) | ✅ Stock Begin | ✅ Analyze tab | Shared `research-worker` |
| Events feed | ✅ | ✅ drill-in | `material_news_events` |
| Relationship graph | ✅ | ✅ drill-in | `graph_edges` |
| Signal follow-up chat | ✅ | ⚠️ behind compute URL | Worker must be running |
| Calendar | ✅ | ❌ | Not yet ported |

Closing remaining gaps (calendar, a deployed Railway service for the worker)
should not fork the pipeline. Point `EXPO_PUBLIC_API_URL` and
`RESEARCH_WORKER_URL` at the same worker.

## Checklist before merging a feature change

- [ ] Does this change a feature, a threshold, copy, or a design token?
- [ ] If yes: is the matching change included for the other client?
- [ ] If it is deliberately one-platform: is there a `PLATFORM-ONLY:` comment
      with a reason?
- [ ] If it touches a Supabase table: are the types updated on both sides?
- [ ] `pnpm lint` (desktop tsc) and `pnpm --filter mobile lint` both pass?
- [ ] If a token changed: onboarding tokens still match the site; product
      chrome on mobile is allowed to diverge (see above).

## Why this is manual

React Native cannot import the DOM components or Tailwind CSS that desktop and
web share. Signal thresholds in `apps/mobile/src/lib/signals.ts` stay mirrored
from desktop. Product chrome does **not** — the phone is a different use case.
