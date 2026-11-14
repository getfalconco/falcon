# @falcon/backtest

Daily-bar backtester behind the Workspace Strategy tab ("Strategy Lab v2",
docs/design/strategy-lab-v2.md). A strategy is a **StrategySpec v2**
(`src/spec.ts`) whose rules are **FSL** formulas (`src/fsl/`); engine v2
(`src/simulate.ts`) runs it; a deterministic quality suite (`src/audit/`)
grades the record; Claude only compiles words into a spec
(`src/ai/converse.ts`) and, on request, explains the report in slot templates
(`src/ai/review.ts`). The v1 JSON rules (`src/schema.ts`, `src/engine.ts`) stay
as the legacy path and for parity.

```bash
pnpm --filter @falcon/backtest test            # offline tests (node:test): v1, FSL, engine v2, audit, AI with a fake client
pnpm --filter @falcon/backtest typecheck
pnpm --filter @falcon/backtest expressiveness  # the 12 starter strategies on real data (Yahoo beta source, FRED DTB3)
pnpm --filter @falcon/backtest eval:converse   # live conversation eval v0 (30 prompts; needs ANTHROPIC_API_KEY; stops at EVAL_MAX_USD, default 2.5)
pnpm --filter @falcon/backtest test:live       # v1 live tests
```

## Website routes

| Route | What | Limits per IP (per instance) |
|---|---|---|
| `POST /api/strategy/turn` | one conversation turn: `{questions}` / `{spec}` / `{not_a_strategy}` | 5/min, 30/h, 300/h per instance |
| `POST /api/strategy/run` | spec in; curves, trades, years, metrics, Tier A report out | 10/min, 120/h |
| `POST /api/strategy/audit` | Tier B checks for a spec (second request) | 5/min, 60/h |
| `POST /api/strategy/review` | Explain: slot-templated text about a report | 3/min, 20/h, 100/h per instance |
| `POST /api/backtest/{parse,run}` | v1 (unchanged; the iPhone "Backtest this" still uses `/run`) | as before |

All `/api/strategy/*` routes: Node runtime, 25 s budget, an Origin allowlist
(getfalcon.co, www, app, any localhost port, same host, `STRATEGY_ALLOWED_ORIGINS`;
no Origin passes for the native app), body caps, no auth yet (Supabase session,
verified email and DB quotas come with the M1c migration).

## StrategySpec v2

`universe` (typed tickers, or a Falcon universe: `falcon_semis`, `sector_etfs`),
`params` (every tunable number is a named `$param`: int, number or pct; shown
as sliders), `defs` (named formulas, no cycles), `portfolio` in one of four
modes, `rebalance`, `risk` (stop, trailing stop, take profit, max hold),
`execution` (commission, spread "auto" or bps, gross cap), `cash` (T-bill or
zero), `period`, `benchmark` (SPY or the equal-weight universe). `legacy` is
set only by `v1ToV2` and reproduces v1 exactly (list-order ties, v1 re-entry,
fixed slippage, cash at 0%, drift rebalancing). `describe(spec)` writes the
numbered rules from operator templates; model text never reaches them.

Modes: **rules** (entry/exit conditions, max positions, close or pre-open clock,
edge re-entry or cooldown, seeded or scored tie-break, equal / inverse-vol / %
sizing), **rank** (score, order, top n or a quantile, filter, weighting),
**weights** (one formula per ticker; `w("SPY")` reads another weight),
**event_study** (event, targets, windows; market-model abnormal returns, N and
independent dates G, clustered t, wild bootstrap when G < 30).

## FSL

Formula style, parsed by a hand-written Pratt parser into an AST (no eval).
Prices `open high low close` (adjusted, type AdjPrice), `raw_close`, `volume`,
`dollar_volume`, `adv(n)`; time series `delay(x,k>=1) delta ret logret ts_mean
(sma) ema wma ts_max ts_min ts_sum ts_std ts_zscore ts_rank rsi atr macd vol
drawdown count streak days_since crosses_above crosses_below`; cross-sectional
`cs_rank cs_zscore cs_demean top_n bottom_n`; `at("T", x)`, `of("T", x)`,
`w("T")`; `tbill_ret(n)`; calendar `dow month tdom is_month_end
is_quarter_end`; `earnings.event/days_since/reaction_abn/surprise`;
`ripple.event/relation/degree/event_kind/event_sign/implied_dir/edge_tier/coverage`;
`if min max abs log sign clip`.

The checker makes look-ahead and level mistakes compile errors: no future
operator, windows are literals or int params (1..1260), an adjusted price can
only meet an adjusted price of the same ticker, a ratio, a return or 0
(`close > 50`, `close > $p` and `at("SPY", close) > close` fail with a
`raw_close` hint), bare `rank` is rejected, identifiers match
`^[a-z][a-z0-9_]{0,23}$`, defs and `w()` must be a DAG, dates cannot appear in
formulas, and `ripple.judged_dir` (an LLM judgment) is not backtestable.

## Engine v2 (`src/simulate.ts`)

Signals (rules) or Targets (rank, weights; NaN = hold, applied only on
rebalance dates). At each open: gap-through risk exits, signal and max-hold
exits, rebalance, entries; intraday stops, trailing stops and targets (stop
first); at the close cash earns DTB3 / 252. Clocks: **close** (decide on close
t, fill at open t+1) and **preopen** (decide at 09:15 New York on t from bars to
t-1 and events known by 09:15, fill at open t; event rules only). Earnings
release times are Yahoo buckets: before the open counts as 08:00, during as
12:00, after the close and unknown as 16:30. Costs (`src/costs.ts`): half-spread
floor by 20-session ADV and raw price (0.5 / 2 / 5 / 25 bp, Corwin-Schultz
raises the illiquid tiers), plus commission; a typed spread can only raise
costs. Outputs: trades with costs and ADV share, daily equity, turnover,
capacity. Benchmarks: SPY and the universe at equal weight, both held.

## Quality (`src/audit/`)

Tier A with every run: 1 spec valid, 2 prefix invariance (one sampled cut per
run; the CI property test runs 500 random formulas x 10 cuts on both clocks),
4 data availability, 5 data sanity, 6 sample size, 7 benchmarks and a 50-seed
null per mode, 8 block bootstrap range and HAC t, 9 costs x2 and break-even,
10 one-session delay, 12 concentration shares, 14 hindsight list, 15
survivorship, 16 liquidity, 17 deflated Sharpe with this browser's trial
count, 21 no model-derived inputs. Tier B (`/audit`): 200-seed null, parameter
neighbourhood, leave one ticker out, regimes. The evidence label ("Evidence in
past data": Insufficient sample / Thin / Some / Consistent) follows design 6.3;
flag texts are deterministic templates filled from `values`.

## AI

`converse()`: claude-sonnet-5-5, structured output for the envelope
(outcome, up to 3 questions with 2-4 tappable answers and a default,
assumptions, not-expressible items) with the spec as JSON text in the v2 shape
(a strict schema of the whole spec compiles to a grammar larger than the API
allows); the FSL reference is a 1-hour cached system prompt; one automatic
repair when zod, the checker or the ticker rule rejects the spec; tickers must
appear in text the person typed (SPY as the market reference and Falcon
universes are allowed), otherwise it asks. `review()`: slot templates only, any
digit or unresolved slot is rejected and retried once, numbers are filled by
the server, all text passes `neutralize()`. `nl.ts` (v1 parsing) is
deprecated; it no longer picks tickers for named groups and asks instead.

## Data

`MARKET_DATA_PROVIDER` (`yahoo` today, `vendor` later) and `FALCON_STAGE`
(`production` refuses Yahoo; unset counts as beta) pick the provider
(`src/data/provider.ts`). Yahoo bars now carry the printed close (rebuilt from
split events) and dollar volume (cache key `bars-v2`). FRED DTB3 is fetched as
CSV and cached for 24 h; if it fails, cash earns 0% and the run says so.
Sightings history is read from a point-in-time file when one exists
(`FALCON_RIPPLE_EVENTS_FILE` or `packages/engine/data/ripple-hits-pit.ndjson(.gz)`,
one `RippleEventRaw` per line); until then ripple rules never fire and runs say
so. "Backtest this" shows the card's own record as an event study (N, G, wins,
`eventStudyFromHistory`) when the card carries `history.events`, and "no
history source yet" for monthly-revenue cards instead of an empty run.

---

## v1 (legacy) reference

## Rules

Universe (tickers), entry conditions (`all` or `any`), exit conditions (any),
stop loss %, take profit %, max holding days, sizing (max positions, % of
equity per position), rebalancing (none, weekly, monthly).

Conditions: `price_vs_ma` (SMA/EMA, above/below/crosses), `ma_cross`, `rsi`
(Wilder), `n_day_return`, `gap`, `breakout` (new N-day high/low),
`earnings_surprise` (EPS surprise above/below X%, D trading days after the
release; `ticker` set reads another company's releases, e.g. trade TSM the day
after NVDA beats), `ripple_event` (a Ripple card hit with a given relation, direction,
confidence; fed by a `RippleSource`, none is connected yet). Technical
conditions can read another ticker (`ticker: "SPY"` as a market filter).

## Timing (no look-ahead)

- Conditions are read on the close of day t using data up to and including t.
  Earnings and ripple events count as known at the end of the day they are
  published (after-hours releases included).
- Orders fill at the open of day t+1: exits, then rebalancing, then entries
  while slots and cash last (skipped entries are counted). Ties go in a seeded
  order (a hash of the rules, the date and the ticker); `runBacktest(...,
  { tiebreak: "list_order" })` keeps the v1.0 universe order for parity.
- Stop loss and take profit fill during the day at their level, or at the open
  when the price gaps through. A bar touching both is assumed to hit the stop.
- Positions still open on the last day close at that day's close.
- `daysAfter: 1` on an event means: signal on the close of the first session
  on or after the release date, fill at the next open.

Prices are split- and dividend-adjusted (Yahoo `adjclose / close` applied to
open, high, low and close), so dividends count as reinvested. Fractional
shares. Slippage (bps) moves each fill against the trade; commission (bps) is
charged on each fill's notional. Defaults: 100k capital, 1 bps commission,
5 bps slippage, last 10 years.

Metrics: total and annualized return (CAGR), Sharpe (daily, risk-free 0,
sqrt 252), max drawdown, volatility, win rate, trade count, exposure, all
against SPY buy-and-hold over the same sessions with the same costs.

## Data

`PriceSource`, `EarningsSource` and `RippleSource` (`src/data/types.ts`) are
the only things the engine depends on. Yahoo Finance is the source until the
first paying user; then a licensed source (Massive) implements the same
interfaces.

- Prices: Yahoo v8 chart API. Earnings: Yahoo's earnings calendar archive
  (back to about 2000, currently ending mid 2025) plus the quote summary's last
  four quarters. A quarter between the two can be missing; runs warn about it.
- Polite fetching: 6 requests at a time, 75 ms between starts, 10 s timeout per
  request, one retry on 429/5xx, and a deadline for the whole run.
- Cache: memory, then disk. Disk is `packages/backtest/.cache` locally
  (gitignored), the OS temp dir on Netlify, or `FALCON_BACKTEST_CACHE_DIR`.
  Prices are kept 12 h, earnings 24 h; a stale entry is re-fetched whole (adjusted
  history changes with every dividend).

**Survivorship bias:** Yahoo only serves symbols that trade today. Delisted,
merged and bankrupt companies are missing, which flatters any list of stocks
picked today. Every result carries this caveat.

## Limits (serverless)

At most 25 tickers (universe plus reference tickers), 10 years, from 1995,
6 conditions per side, indicator periods up to 250. `/run` has an 8 s deadline
(`BACKTEST_RUN_TIMEOUT_MS`): a cold 15-ticker earnings run took about 6 s
locally, a cached one well under 1 s; on a deadline it answers 504 and keeps
what it loaded, so a retry is faster. `/parse` waits up to 9 s for Claude
(`BACKTEST_PARSE_TIMEOUT_MS`). Rate limits per IP: `/run` 10 a minute and 120
an hour; `/parse` 5 a minute, 30 an hour, 300 an hour per server instance.

## Natural language

`parseStrategy(text)` calls `claude-sonnet-5-5` with a JSON schema (structured
output), thinking off, server-side refusal fallback. No `temperature` is sent:
the API version the SDK uses rejects it. The reply is validated, the summary is
written from the rules (`describeStrategy`), and model text (assumptions,
unsupported parts) is filtered for advice-like sentences (`neutralize`).
Requests for tips or predictions come back as `not_a_strategy`.
