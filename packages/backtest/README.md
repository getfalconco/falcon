# @falcon/backtest

Daily-bar backtester behind the Workspace Strategy tab. A strategy is explicit
JSON rules (`src/schema.ts`); the engine (`src/engine.ts`) is pure; data comes
through swappable sources (`src/data`); plain English becomes rules with
Claude (`src/nl.ts`).

```bash
pnpm --filter @falcon/backtest test        # offline unit tests (node:test)
pnpm --filter @falcon/backtest test:live   # real Yahoo data; Claude tests skip without ANTHROPIC_API_KEY
pnpm --filter @falcon/backtest examples    # 3 example strategies on real data, metrics vs SPY
pnpm --filter @falcon/backtest examples -- --nl   # same, rules parsed from the English text
```

Website routes: `POST /api/backtest/parse` (text to rules and summary) and
`POST /api/backtest/run` (rules to results; `GET` returns the limits).

## Rules

Universe (tickers), entry conditions (`all` or `any`), exit conditions (any),
stop loss %, take profit %, max holding days, sizing (max positions, % of
equity per position), rebalancing (none, weekly, monthly).

Conditions: `price_vs_ma` (SMA/EMA, above/below/crosses), `ma_cross`, `rsi`
(Wilder), `n_day_return`, `gap`, `breakout` (new N-day high/low),
`earnings_surprise` (EPS surprise above/below X%, D trading days after the
release), `ripple_event` (a Ripple card hit with a given relation, direction,
confidence; fed by a `RippleSource`, none is connected yet). Technical
conditions can read another ticker (`ticker: "SPY"` as a market filter).

## Timing (no look-ahead)

- Conditions are read on the close of day t using data up to and including t.
  Earnings and ripple events count as known at the end of the day they are
  published (after-hours releases included).
- Orders fill at the open of day t+1: exits, then rebalancing, then entries in
  universe order while slots and cash last (skipped entries are counted).
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
