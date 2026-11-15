# Options and order-flow core

Data and math for the options hypotheses (4 to 7) and the stock-flow
hypotheses (1, 3) in the vault note `Falcon/Engine/Options Signals.md`.
Everything is pure and tested except the fetchers in `client.ts` and
`rates.ts`.

| File | What |
| --- | --- |
| `cost.ts` | Spend guard: shared ledger, lock, budgets, on-disk response cache |
| `client.ts` | Databento HTTP client (the only way to pull), record parsers, day-level fetchers |
| `math.ts` | Normal CDF, Black-Scholes-Merton with dividend yield, Greeks, Brent, IV, quote screen |
| `american.ts` | Bjerksund-Stensland 2002, CRR tree, bivariate normal, American IV |
| `rates.ts` | FRED DTB3 risk-free rate, Yahoo trailing dividend yield |
| `surface.ts` | Per underlying-day features from an end-of-day snapshot |
| `flow.ts` | Per ticker-day trade-side flow and the quiet-accumulation score |
| `cards.ts` | The Sightings card block (`RippleOptions`): implied moves raw and beyond the market, matched comparison with a hit's record, beta |
| `sightings-options.ts` | The options job of a Sightings run: names, snapshot, caps, pulls, blocks onto the cards |
| `cli.ts` | `spend`, `features`, `flow`, `cards` commands |

Tests: `test/options-math.test.ts`, `test/options-cost.test.ts`,
`test/options-surface.test.ts`; fixtures (real KLAC records, trimmed) live
locally in `test/fixtures/options/` and are not committed (Databento licence);
the suites that need them skip when the files are missing.

## Options on Sightings cards

`sightings-options.ts` runs inside every Sightings run (`src/cli/sightings.ts`,
after the cards are built, before they are published). For the tickers on the
published cards (event company, then hits; deduplicated, US listings, liquid
by `quality.ts isLiquid`, at most `OPTIONS_MAX_NAMES`, default 80) it takes
one `cbbo-1m` snapshot of each chain at 15:45 New York (12:45 on early-close
days) of the latest session whose snapshot is at least 15 minutes old and
inside Databento's range: the morning runs read the previous close, the
evening run that day's. Definitions come from the OSI symbols in the quote
records (no `definition` pull); the spot is the XNAS.ITCH 1-minute bar
ending at the snapshot (Yahoo's close or the parity spot as fallbacks). A
snapshot already computed is kept in `.cache/options/` and reused for free.

Per name (`cards.ts`, @falcon/ripple `RippleOptions`): ATM IV 30 days; the
implied move over 5 and 20 sessions, raw (ATM IV of the first expiry on or
after the window's last session x sqrt(L/252) x sqrt(2/pi)) and beyond the
market (the variance minus beta^2 VIX^2 first; beta from a year of Yahoo
closes against SPY, VIX from FRED VIXCLS; null when the market part is the
whole variance); XZZ skew and the CW call-put spread as descriptive numbers;
spot and as-of time. On a hit with a record (>= 6 past events), `matched`
sets the implied move beyond the market over the record's own window next
to the record's mean |move - benchmark move| (`historyAbsMovePct`): the H7
matched units. The raw implied move is never compared with the history
(options price more than the abnormal history 87% of the time in raw units).
No IV percentile (no trailing IV history is kept yet) and no open interest
(no GEX: about $0.035 a name). Chains with a surface warning, no ATM curve or
fewer than 20 contracts with an IV are left out.

Cost and caps: about $0.06 for 60 names (four 15-parent requests priced at
one 10-minute block each, plus ITCH bars). Every pull is priced first and
checked under the ledger lock against the per-run cap (`OPTIONS_RUN_CAP_USD`,
default $0.75: the run's own caller `sightings-options@<time>`) and the
monthly cap (`OPTIONS_MONTH_CAP_USD`, default $20: every `sightings-options`
caller in the UTC month, a `SpendCap`). In GitHub Actions the ledger and the
snapshot cache travel between runs in the "options ledger" cache. A refused
pull stops the job quietly and the run summary line says so, e.g.
`options: 46 of 62 names priced at 2026-11-13 15:45 ET; left out 21: ...;
$0.06 this run (cap $0.75), $0.06 this month (cap $20.00)`.

`node --import tsx src/options/cli.ts cards --feed https://getfalcon.co/api/sightings [--dry-run]`
runs the job on any feed (`--dry-run` only prices it).

### Display licensing (open question)

Showing numbers derived from OPRA quotes to outside users may need exchange
and vendor display licensing: OPRA's vendor and subscriber agreements (fees
for displaying OPRA data, including derived data, to non-professional and
professional users) and Databento's redistribution terms for the plan in
use. Until the founder confirms the licensing position, the website shows
the options block to the founder admin only: `OPTIONS_DISPLAY` (Netlify env,
`admin` by default, `all` or `off`) is read by `/api/sightings`, which strips
`options` from every card and hit for anyone else (apps/web
`lib/sightings-options.ts`). The blocks are still stored in Supabase with
the cards (the table is not readable by clients). The iPhone app reads the
same API, so it never sees them either.

## Spending money: the rules

- Every pull goes through `DatabentoClient.getRange(req, { caller, maxCallUsd, maxCallerUsd, dryRun })`.
  Order: disk cache (free, no call at all) -> `metadata.get_cost` -> dry run
  stops here -> budget check and ledger line under one lock -> pull -> cache.
- Ledger: `packages/engine/.cache/databento/spend.ndjson`, append-only,
  one line per paid pull: `{at, kind, dataset, schema, symbols: {count, first}, start, end, costUsd, caller, key}`.
  A pull that fails after it was charged gets a `refund` line (negative cost).
  Any 2xx answer is a success: Databento's 206 Partial Content (some symbols
  did not resolve) comes back with `partial: true` and its X-Warning. A
  dropped or undecodable body is downloaded again (up to 4 attempts, with
  backoff) under the same single ledger line; only when every attempt fails
  is it refunded.
- Budgets: total `DATABENTO_BUDGET_USD` (default 90, env or `apps/web/.env.local`)
  over the whole ledger; `maxCallUsd` per pull; `maxCallerUsd` over the
  ledger lines with your caller name. Use a distinct caller name per agent
  (`options-h4`, `flow-h1`, ...). A refusal throws `BudgetError` (`reason`:
  `per_call`, `per_caller`, `total`) and writes nothing.
- The lock is an exclusive `mkdir` of `.cache/databento/spend.lock`, safe
  across processes; a lock older than 60 s is broken.
- Cache files: `.cache/databento/data/<key>.json.zst` plus `.meta.json`.
  The key is a hash of dataset, schema, sorted symbols, start and end as UTC
  instants, `stype_in` and `limit`, so `"2026-11-13"` and
  `"2026-11-13T00:00:00Z"` are the same request. Never delete the cache.
- Ledger costs are Databento's estimates, rounded up to 10-minute blocks
  (UTC midnight for `definition`): a 2-minute window is recorded at the
  10-minute price. The real bill is by bytes and is lower.
- The API key is read with `env("DATABENTO_API_KEY")` and only ever goes into
  the Authorization header.
- `node --import tsx src/options/cli.ts spend` prints the ledger by caller.
  Always run a pull plan with `--dry-run` (or `dryRun: true`) first.

## Measured costs (get_cost, KLAC, 2026-11-13)

| Pull | Records | USD |
| --- | ---: | ---: |
| OPRA `definition`, 1 day | 2,694 | 0.0045 |
| OPRA `statistics`, 1 day | 228,640 | 0.1499 |
| OPRA `statistics`, 00:00 UTC to the open (open interest only) | 53,760 | 0.0352 |
| OPRA `ohlcv-1d`, 1 day | 1,499 | 0.0469 |
| OPRA `ohlcv-1d`, 2 days in one request | | 36.57 (!) |
| OPRA `ohlcv-1d`, 5 days in one request | | 77.07 (!) |
| OPRA `cbbo-1m`, 2 minutes (priced as one 10-minute block) | 4,137 pulled | 0.0031 |
| OPRA `cbbo-1m`, 1 day | 894,143 | 0.1332 |
| OPRA `trades`, 1 day / `tcbbo`, 1 day | 2,901 | 0.0363 / 0.0454 |
| Stock trades XNAS.ITCH, 1 day (side on ~23% of Nasdaq volume) | 54,383 | 0.0146 |
| Stock trades EQUS.MINI, 1 day (98% side N) | 9,080 | 0.0024 |
| Stock trades DBEQ.BASIC, 1 day (99.9% side N) | 9,090 | 0.0065 |
| Stock trades XNAS.BASIC, 1 day (consolidated incl. TRF, 100% side N) | 112,661 | 0.0302 |
| Stock `tcbbo` XNAS.BASIC, session | 110,280 | 0.0493 |
| Stock `ohlcv-1d` EQUS.SUMMARY, 1 day / 1 year | 1 | 0.000002 / 0.0004 |
| XNAS.ITCH trades KLAC, 1 year | | 3.44 |

Other names, same day: NVDA options `definition` 0.0073, `cbbo-1m` 10 min
0.0063, `statistics` 0.27, `ohlcv-1d` 0.93. Five semis at once (KLAC, LRCX,
AMAT, MU, AMD): `cbbo-1m` 0.037, `definition` 0.045, OI window 0.348,
`ohlcv-1d` 1.93. XNAS.ITCH trades for 10 semis incl. NVDA, one session: 0.40.
Older days are cheaper (KLAC 2023-06-15: `cbbo-1m` 0.0022, OI 0.0146,
`ohlcv-1d` 0.011).

Rules that follow: request `ohlcv-1d` on OPRA parents one day per request;
take open interest from the pre-open statistics window only; take quotes as
a 6-minute `cbbo-1m` window, not whole days; one parent or many per request
costs the same per byte.

## Data sources and conventions

- **Options** (`fetchOptionDay`): OPRA.PILLAR with `stype_in=parent`
  (`KLAC.OPT`). Definitions: `definition` (one record per contract; OPRA
  leaves the multiplier fields undefined, so 100). Expiration arrives as the
  expiry date at 00:00 UTC; contracts expire at the 16:00 New York close.
  Open interest: `statistics` with `stat_type` 9, published ~06:30 ET, one
  identical record per exchange (20 publishers). Volume: `ohlcv-1d`, one bar
  per contract per exchange, summed. Quotes: `cbbo-1m` in [15:40, 15:46) ET,
  the last sample at or before 15:45 ET per contract (a contract with no
  sample in the window has no quote; 92% of KLAC contracts had one). On
  early-close days pass `snapshotMin: 12 * 60 + 45`.
- **Spot**: close of the XNAS.ITCH 1-minute bar ending at the snapshot
  (`fetchStockSpot`); the surface reports the put-call-parity spot as a check.
- **Stock volume**: EQUS.SUMMARY `ohlcv-1d` (consolidated, from 2024-07-01;
  before that only venue datasets exist).
- **Trade side**: Databento `side` B = buyer-initiated, A = seller-initiated,
  N = none. Only XNAS.ITCH has a usable side: on KLAC 2026-11-13, 1.07M of
  4.64M Nasdaq shares were signed (the closing cross alone was 2.78M, the
  rest N is hidden-order executions); consolidated volume was 12.5M. The
  consolidated alternatives (EQUS.MINI, DBEQ.BASIC, XNAS.BASIC) carry N on
  almost everything. `flow.ts` can sign N trades by the tick rule
  (`classify: "tick"`, auction prints excluded) for XNAS.BASIC; on that day
  the given-side imbalance was -15.8% (ITCH), tick-rule -9.0% (ITCH) and
  -9.6% (XNAS.BASIC): same sign, different scale. Treat them as different
  measures.
- **Risk-free rate**: FRED DTB3 (3-month bill, discount basis) converted to a
  continuous rate, one flat rate for all expiries.
- **Dividends**: trailing 12-month cash dividends from Yahoo (`events=div`),
  split adjusted, over Yahoo's split-adjusted close: q = ln(1 + D/S). It
  ignores discrete ex-dates (matters for American calls just before one).

## Math

- `math.ts`: BSM with continuous yield; theta per year, vega and rho per 1.00.
  `normCdf` is Hart/West double precision (|err| < 1e-14). IV by Brent on
  [0.0001, 5], null outside the European no-arbitrage bounds.
- `american.ts`: Bjerksund-Stensland 2002 (Haug's formulation, Genz
  bivariate normal), put by put-call transformation. Within 1% of a
  2000-step CRR tree on the test grid; it slightly underprices (it is a
  lower bound), so American IVs read a hair high (~0.4% relative at the
  money). A call with q <= 0 is BSM exactly. `impliedVolAmerican` is null
  when the mid has no time value over intrinsic (deep ITM) or is out of
  bounds. `ivModel: "crr"` (100-step tree) and `"european"` are available
  for checks; on KLAC the three give ATM IV30 within 0.15 vol points.
- Greeks used for GEX are BSM Greeks at the contract's own (American) IV.

## Surface features (`surfaceFeatures`)

Input: snapshot quotes, definitions, optional OI and volume, spot, rate,
yield, stock volume. Each contract gets an IV only if bid > 0 (a missing
bid is 0), ask > bid, (ask - bid) / mid <= 0.5, the quote is within 15 min
of the snapshot, and it has at least 1 day left. Flags per contract:
`no_quote`, `stale_quote`, `zero_bid`, `no_ask`, `crossed`, `wide`,
`too_short`, `no_iv`; counts in `quality.flags`, problems in
`quality.warnings`.

| Feature | Definition |
| --- | --- |
| `atmIv30/60/90` | per expiry: mean of call and put IV per strike, linear in strike to spot (the 2 strikes around spot); then total variance linear in time to 30/60/90 days, flat beyond the ends; expiries under 2 days left out |
| `termSlope` | `atmIv30 - atmIv90` (positive = inverted, an event priced near term) |
| `impliedMoves` | per target date, the first expiry on/after it: `straddlePct` = (call + put mid at the strike closest to spot) / spot; `ivAbsPct` = ATM IV x sqrt(T) x sqrt(2/pi) (the same quantity from IV); `ivSdPct` = ATM IV x sqrt(T) (one sd). Default target: next expiry |
| `skew` | Xing, Zhang & Zhao (2010): IV of the put with K/S in [0.80, 0.95] closest to 0.95 minus IV of the call with K/S in [0.95, 1.05] closest to 1, same expiry, 10 to 60 days; headline at the expiry closest to 30 days, `skewMean` over all, `skewByExpiry` each |
| `callPutSpread` | Cremers & Weinbaum (2010): mean of (call IV - put IV) over same-strike, same-expiry pairs, weighted by the pair's mean OI (both legs OI >= 1); 7 to 365 days, K/S 0.8 to 1.2; equal weights and `callPutUnweighted` when OI was not pulled |
| `oToS` | Johnson & So (2012): total option contracts / (stock shares / 100) |
| `gex` | naive dealer gamma, $ per 1% move: sum of gamma x OI x 100 x S^2 x 0.01, calls +, puts -. Assumes dealers are long calls and short puts, which is often wrong; a rough regime flag only. Contracts without their own IV borrow the nearest strike's IV in the same expiry (`gexIvFallbacks`) |

Single-contract IVs are noisy: the XZZ skew on KLAC ranged from 0.6 to 8.6
points across expiries on one day. Prefer `skewMean`, or changes in a
name's own skew over time, to cross-sectional levels.

## Flow features (`aggregateFlow`, `quietAccumulation`)

Per New York date, regular session (09:30 to 16:00 plus 5 s for the
closing cross): buy, sell and unknown volume and dollars, `netSignedDollar`,
`imbalance` (shares) and `dollarImbalance` over signed trades only,
`signedShare` (signed / all volume), `auctionVolume` (side-less prints in
the opening 2 s or at/after the close), VWAP. Unknown-side trades are never
guessed unless `classify: "tick"`.

Quiet accumulation over a window of `window` sessions (default 5): window
dollar imbalance; window return from the close before the window to the
last close; sigma = sd of daily log returns over the 60 sessions before the
window (>= 20); `zMove = |ln(1 + ret)| / (sigma sqrt(window))`; `quiet` when
zMove <= 0.5; `score = imbalance x max(0, 1 - zMove)`. Days with
signedShare under 2% are skipped.

## KLAC 2026-11-13 (validation pull)

Spot 151.38 (15:44 bar close), r 4.22%, q 0.55%, 2,694 contracts, 2,480
quoted, 1,831 with IV. ATM IV 30/60/90 63.1% / 60.3% / 61.7%, slope +1.4
pts; XZZ skew 3.4 pts (mean 3.5); CW spread -3.75 pts over 256 pairs;
option volume 10,566 vs 12.5M shares, O/S 0.084; GEX -$7.5M per 1%
(calls +$32.4M, puts -$39.9M); implied move to 2026-11-20 (7 days) 7.46%
by straddle and by IV. Flow (XNAS.ITCH): buy 451k, sell 620k, unknown 3.57M
shares (2.85M auction), net -$25.7M, imbalance -15.8%.

## Usage

```ts
import { DatabentoClient, fetchOptionDay, fetchStockDaily, fetchStockSpot } from "./client.ts";
import { surfaceFeatures } from "./surface.ts";
import { fetchDtb3, fetchDividends, rateOn, dividendYieldOn } from "./rates.ts";

const client = new DatabentoClient();
const pull = { caller: "options-h4", maxCallUsd: 0.5, maxCallerUsd: 20 };
const day = await fetchOptionDay(client, { parents: ["KLAC.OPT"], date, volume: false, pull });
// ... spot, rate, yield, then surfaceFeatures({...})
```

CLI: `node --import tsx src/options/cli.ts features --ticker KLAC --date 2026-11-13 --caller options-h4 --max-caller 20 [--dry-run] [--no-oi] [--no-volume] [--json]`.
