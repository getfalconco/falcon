# Options hypotheses 4-7: Falcon's own test on OPRA history

Plan: vault note `Falcon/Engine/Options Signals.md`, hypotheses 4 to 7.
Pre-registration (frozen before any outcome was read):
`data/preregistration/options-v1.json`. Code: `src/options/study-options.ts`
(pure: OSI parsing, price alignment, sorts, tests, H7 measures),
`scripts/options-study.ts` (pulls, features, analysis; resumable), tests in
`test/options-study.test.ts`. Option features come from the options core
(`src/options/surface.ts`, unchanged); outcomes from `src/study/abnormal.ts`.
Outputs (gitignored) in `.cache/options-study/`: `panel.ndjson`,
`h7-events.json`, `h7-snapshots.ndjson`, `results.json`, `results.md`,
`h7-pairs.json`, run logs.

Internal research only. Stock prices are Yahoo (a stand-in); nothing here is
shown to users.

```
node --import tsx scripts/options-study.ts prices
node --import tsx scripts/options-study.ts events
node --import tsx scripts/options-study.ts panel --dry-run   # then without --dry-run
node --import tsx scripts/options-study.ts h7 --dry-run      # then without --dry-run
node --import tsx scripts/options-study.ts analyze
```

## Method (as pre-registered)

**Options data.** Databento OPRA.PILLAR through `DatabentoClient.getRange`
(caller `options-hypotheses`, $50 cap, $1 per call; every batch priced with a
dry run first). Per snapshot: `cbbo-1m` in [15:40, 15:46) New York
([12:40, 12:46) on 13:00 closes), the last sample at or before 15:45 per
contract. No `definition` pull: each cbbo record carries its OSI symbol, which
gives right, strike and expiry (`parseOsi`, `definitionsFromRecords`; adjusted
roots such as `KLAC1` are left out). No open interest (too costly: ~$0.015 to
$0.07 per name-day). H6 adds `ohlcv-1d` (one day per request) for its names.
Parents are requested 15 at a time (same price per byte, bounded memory).

**Spot, rates, dividends.** Spot = close of the XNAS.ITCH 1-minute bar ending
at the snapshot (from 2018-05); before that the put-call-parity spot from
`surface.ts`, started from the unadjusted Yahoo close. Rate: FRED DTB3. Dividend
yield: trailing 12-month Yahoo cash dividends over the split-adjusted close.

**Features** (`surfaceFeatures`, American IV by Bjerksund-Stensland 2002;
contracts outside K/S 0.7-1.3 or beyond 400 days dropped first):
- skew (H4): `skewMean`, the XZZ skew averaged over expiries with 10-60 days;
- call-put spread (H5): CW spread over same-strike pairs, 7-365 days, K/S
  0.8-1.2, equal weights (CW weight by open interest, not pulled here);
- O/S (H6): contracts traded that day on the standard root / (Yahoo shares
  traded, split-unadjusted / 100);
- change versus the name's own trailing mean: x minus the mean of its previous
  6 monthly snapshots (>= 3); for O/S the log ratio ("spike").

**Outcome.** `measureEvent` with the snapshot instant as the public time:
entry at the next open, market model on SPY over sessions [-260, -11],
CAR over L = 5 and 20 sessions, percent.

**Panel (H4, H5, H6).** The last NYSE session of each month, 2013-06 to
2026-10 (161 dates). Universe: the 58 semis plus every other US-listed ticker
on either side of a `data/graph.json` edge (OTC names left out), when Yahoo has
>= 150 prior sessions and the unadjusted close is >= $5. H6 uses the semis only,
without the 15 with the highest trailing 60-session median dollar volume that
date (point in time). Each date: terciles of the feature (>= 9 names), long the
tercile predicted to do better, short the other end, equal weights.
Primary statistic: the per-date long-short spread of CAR_L, its mean over dates
and t with df = dates - 1 (one value per date, i.e. clustered by date;
month-end snapshots with L <= 20 do not overlap). Also: pooled side x CAR over
the legs with date and two-way (firm x month) clustering, per-name Spearman
correlations, by year, first 2/3 vs last 1/3 of dates, net of 0.40 points per
period (10 bp a side, both legs in and out).

**H7.** Events: the semis' 8-K item 2.02 earnings releases (sign = EPS surprise
from the Yahoo EPS record, matched as `history.ts matchQuarters`) and the
Taiwan monthly revenue 6-Ks of TSM, UMC and ASX (sign = change from a year
earlier). Public instant = the earlier of EDGAR acceptance and the release's
own time. Current events: public 2023-01-01 to 2026-11-05. Hits: every
degree-1 graph neighbour in the panel universe. Snapshot: the first session
whose 15:45 is after the public instant (for an after-close release, the next
day's close: the "has not reacted yet?" moment a card is read).
- I_L (options): ATM IV of the first expiry on or after the window's last
  session, idiosyncratic part sqrt(max(IV^2 - beta^2 VIX^2, 0)) with the hit's
  market-model beta and FRED VIXCLS, times sqrt(L/252) sqrt(2/pi): the expected
  absolute abnormal move.
- H_L (Falcon's history): mean |CAR_L| of the hit after the event company's
  past events of the same kind and sign within 5 years, measured the same way,
  windows ending before the current snapshot, >= 6 events.
- R_L (realized): |CAR_L| from the open after the current snapshot.
- Primary: among pairs with gap = H_5 - I_5 > 0, the share with R_5 > I_5,
  tested as mean(1{R > I} - 0.5) clustered by snapshot date.

**Pass bar.** One-sided p of the primary < 0.05 after Benjamini-Hochberg across
the 4 primaries, the predicted sign, and the same sign over the most recent
year. Primaries: H4 skew change, L = 20 (long low, short high); H5 call-put
spread level, L = 5 (long high); H6 O/S spike, L = 5 (long low); H7 exceed
share, L = 5.

## Results (full run, computed 2026-11-14)

### Bottom line

| | primary (pre-registered) | estimate | one-sided p | BH p | recent year | verdict |
|---|---|---:|---:|---:|---:|---|
| H4 skew steepening -> lower returns | skew change vs own mean, L = 20, long low / short high | +0.28% per month | 0.170 | 0.170 | +3.75% | **fail** |
| H5 call-put spread -> higher returns | CW level, L = 5, long high / short low | +0.28% per week | 0.023 | 0.046 | +1.32% | **pass (marginal)** |
| H6 O/S spike -> lower returns | O/S spike, L = 5, mid caps, long low / short high | +0.22% per week | 0.133 | 0.170 | +1.89% | **fail** |
| H7 history > implied -> realized > implied | share of gap > 0 pairs with R_5 > I_5 | 54.5% (vs 50%) | 0.010 | 0.039 | 59.7% | **pass (marginal)** |

Two of four pass the pre-registered bar, both narrowly, and neither survives
stricter clustering: with H7 clustered two ways (snapshot date x hit, 63 hits)
its p is 0.029 (date x event company: 0.012), and with that p both BH-adjusted
values become ~0.058. Read them as "promising, not established".

- **H5 passes but does not pay after costs at L = 5**: the weekly long-short
  makes +0.28 points gross, -0.12 net of 0.40 points of round-trip costs. It is
  stronger at L = 20 (+0.77 points a month, t 2.74, net +0.37), and the change
  version agrees (+0.34 weekly, t 2.29; +0.78 monthly, t 2.68). It is weaker in
  the last third of the sample (weekly +0.18, t 0.62) and pooled two-way t is
  1.70. The long leg carries most of it (+0.19 vs the date mean, short -0.10).
  Equal-weighted pairs (no open interest), not CW's OI weights.
- **H4 fails, and the sign wobbles**: the level sort is flat (-0.07, t -0.24);
  the change sort is +0.28 at L = 20 (t 0.96) with a negative median: negative
  in most years to 2018, mixed after, and strongly positive only in 2024-2026. Per name, a skew rise was followed by *higher*
  returns slightly more often (signed rho -0.036, t -2.6), the opposite of XZZ.
  Single-name semis skew is noisy (the README's warning holds).
- **H6 fails at the primary horizon**; the 20-session spike sort is positive
  (+0.88, t 2.29, net +0.48) but driven by the last third (2026 alone +7.1
  points over 9 months) and not significant in the first two thirds (t 0.95).
  The level sort (Johnson & So's own) is weaker still. One day of option volume
  a month is a thin measure.
- **H7 passes**: when Falcon's history says more than the options price, the
  realized abnormal move beat the implied one 54.5% of the time (39.3% when it
  did not). Same at L = 20 (54.2%, p 0.006), but at L = 20 the recent year is
  48.4%. By year: 2023 46%, 2024 54%, 2025 62%, 2026 62%; earnings 53.7%,
  Taiwan monthly revenue 55.8%.

### What this means for the cards

1. **"Options price only X%, history says Y%" carries some information, but
   only in matched units.** Options imply a *total* move; Falcon's history is an
   *abnormal* (market-model) move. In raw units the options price at least
   Falcon's history 87% of the time (mean total implied 5.4% vs history 3.6% at
   5 sessions), so a raw "gap" would rarely show and would mislead. After taking
   the market part out (beta^2 VIX^2), options price at least the history 50%
   of the time at L = 5 (40% at L = 20).
2. **History adds information beyond the options.** Regressing the realized
   |CAR| on both: options b = 0.60 (t 10.1), history b = 0.19 (t 2.6) at L = 5;
   0.62 and 0.31 (t 3.3) at L = 20; positive in both halves of the sample. The
   pre-registered "slope of (R - I) on the gap" (0.38, t 6.8) overstates this:
   the implied move sits on both sides of that regression, so noise in it alone
   makes the gap look predictive. Use the two-variable version.
3. **"Priced in" happens about half the time.** Across all 2,950 pairs the
   realized abnormal move stayed within the options' expected move 53% of the
   time (L = 5); median realized / implied = 0.85. Options are a fair, slightly
   generous, yardstick for the size of a hit's move; they are no use for its
   direction (not tested here).
4. A card line that would be honest today: "Options price about +/-X% beyond
   the market; similar past events moved it Y% on average." Show the gap as
   context, not as a signal: a 54.5% hit rate is not a trade.
5. The rich-calls tilt (H5) is the only surface feature worth a second look,
   as a confirming tag on positive ripples at a 1-month horizon, not as a
   stand-alone signal.

### Data and what it cost

- 161 month-end snapshots x up to 84 names (11,392 name-days; skew on 9,182,
  call-put spread on 10,888); O/S on 5,073 name-days of mid-cap semis.
- H7: 1,308 signed events (2017-2026, for history), 2,951 (event, hit) pairs
  with >= 6 similar past events in 2023-2026, 2,740 hit-days on 311 snapshot
  dates; 2,950 pairs measured at L = 5, 2,827 at L = 20.
- Spend (ledger, caller `options-hypotheses`): **$45.25** of the $50 cap
  (cbbo-1m $19.06, ohlcv-1d $26.13, ITCH 1-minute bars $0.06), 2,787 pulls.
  Dry runs projected $39.07 (panel) + $5.99 (H7). The H6 option volume was the
  expensive part: about $1.2 per month-end in 2026 against ~$0.35 of quotes for
  84 names.

### Caveats

- **Stock prices are Yahoo** (stand-in, internal only). Survivorship: today's
  tickers; QRVO has no usable Yahoo history (dropped), WOLF only after its 2025
  relisting; renamed tickers (META before mid-2022 traded options as FB, SHEL
  before 2022 as RDS) have Yahoo prices but no chain under the new root, so
  they drop out of those dates.
- **Spot**: ITCH 15:45 bar for 6,637 name-days, parity spot for 3,537, the
  Yahoo 16:00 close for 1,218 (parity unavailable or > 3% off). ITCH requests
  that Databento answered with HTTP 206 fell back to parity (see below).
- **No open interest**: CW spread equal-weighted; no GEX.
- **H6** uses one day of option volume per month (JS use a week or month), and
  stock volume from Yahoo (split-unadjusted by our code).
- **H7 events**: the Yahoo EPS record has no surprise for most July-October
  2025 releases, so those quarters' earnings drop out (unknown sign, by the
  pre-registered rule): 75 earnings events in 2025 vs ~130 in other years.
  Hits share dates, events and names; clustering is by date in the primary
  (two-way checks above). Implied moves use one ATM IV per expiry and a flat
  sqrt(L/252) scaling; VIX is a 30-day index used for every horizon.
- **Multiple looks**: 12 panel tests and 4 H7 variants are reported; only the 4
  primaries count. Secondary "significant" results (H5 at L = 20, H6 spike at
  L = 20) are exploratory.
- The exploratory regression of R on I and H was added after the H7 results
  were seen (to check the mechanical bias in the pre-registered slope); it is
  labelled as such and does not change any verdict.

### Problems found in the core (both fixed on 2026-11-15: 206 is a success, dropped bodies are retried under one ledger line)

- `client.ts` `DatabentoClient.call` accepts only HTTP 200. Databento answered
  some XNAS.ITCH `ohlcv-1m` multi-symbol requests (2018-2022, batches with a
  symbol that did not trade under that ticker then, e.g. SHEL) with **206
  Partial Content** and a valid body; the client throws, the guard writes a
  refund line, and the data is lost. Fix: treat 206 as success (and surface
  Databento's partial-resolution warning). Real billing for those 206 bodies
  is probably not zero, so the ledger slightly understates (ITCH bars cost
  ~$0.00001 each).
- A dropped download (`TypeError: terminated`, a 300 s body timeout) inside
  `getRange` is refunded and rethrown; `call`'s retry loop does not cover the
  body read. The study script retries per date instead.

### What to build next

1. Fix the 206 handling in `client.ts`.
2. For cards: compute the hit's idiosyncratic implied move (ATM IV of the
   first expiry past the window, minus beta^2 VIX^2) next to the history line;
   label both as abnormal moves. Do not show a raw-units gap.
3. If H5 is pursued: pull open interest for a subsample to test the OI-weighted
   CW spread, and test it as a confirmation filter on positive ripple cards
   (does rich-calls + positive ripple beat the ripple alone over 20 sessions?).
4. Re-run H7 when the mid-2025 EPS gap is filled (a second EPS source), and
   with firm-level matched controls.
5. Drop H4 and H6 as stand-alone signals; O/S could stay as a descriptive
   "unusual activity" tag only.

## Full tables

Generated by `analyze` (`.cache/options-study/results.md`). Panel spreads are
CAR in percent per period; "net of 0.40" subtracts round-trip costs; "long -
date mean" / "short - date mean" are the legs net of the date's cross-sectional
mean (the matched outcome); "recent 12" is the last 12 snapshot dates with a
complete outcome. H7 percentages are expected / realized absolute abnormal
moves; "raw units" compares total implied moves with raw returns (history stays
abnormal there: the card's number).

#### Spend (ledger, caller options-hypotheses)

Total $45.2513 over 2787 pulls (ledger total, all callers: $74.7971).

| dataset schema | USD |
|---|---:|
| OPRA.PILLAR cbbo-1m | 19.0643 |
| XNAS.ITCH ohlcv-1m | 0.0566 |
| OPRA.PILLAR ohlcv-1d | 26.1304 |

#### Panel coverage

11392 name-dates, 161 dates, 84 names; skew on 9182, call-put spread on 10888, O/S on 5073. Spot: ITCH 6637, parity 3537, close 1218. Median skewMean 0.0211, median CW 0.0049, median O/S 0.0344. Name-dates with a surface warning: 247.

#### Verdicts (primary tests, pre-registered)

| hypothesis | primary test | estimate | one-sided p | BH p | recent year | pass |
|---|---|---:|---:|---:|---:|---|
| H4 | H4-change-L20 | 0.278 | 0.170 | 0.170 | 3.754 | fail |
| H5 | H5-level-L5 | 0.283 | 0.023 | 0.046 | 1.324 | PASS |
| H6 | H6-spike-L5 | 0.219 | 0.133 | 0.170 | 1.894 | fail |
| H7 | H7-exceed-L5 | 0.045 | 0.010 | 0.039 | 0.097 | PASS |

Panel estimate = mean per-date long-short spread of CAR_L in percent (predicted orientation, so > 0 = as published). H7 estimate = share of gap > 0 pairs with realized > implied, minus 0.5.

#### Panel sorts (H4, H5, H6)

| test | primary | dates | leg obs | spread % (mean) | median | t (dates) | p one-sided | hit rate | net of 0.40 | long - date mean | short - date mean | pooled t (date) | pooled t (two-way) | early mean (t) | late mean (t) | recent 12 | per-name rho (t, share >0) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---:|---|
| H4-change-L20 | yes | 157 | 5736 | 0.278 | -0.342 | 0.96 | 0.170 | 45.2% | -0.122 | 0.186 | -0.092 | 1.38 | 1.36 | -0.117 (-0.39) | 1.076 (1.73) | 3.754 | -0.036 (-2.61, 39.7%) |
| H4-level-L20 |  | 160 | 6070 | -0.073 | -0.216 | -0.24 | 0.595 | 47.5% | -0.473 | -0.079 | -0.006 | 0.11 | 0.11 | -0.392 (-1.16) | 0.572 (0.96) | 1.017 | -0.034 (-2.74, 38.8%) |
| H4-change-L5 |  | 158 | 5788 | -0.086 | -0.166 | -0.59 | 0.723 | 47.5% | -0.486 | -0.025 | 0.061 | -0.39 | -0.42 | -0.158 (-0.97) | 0.061 (0.21) | 0.678 | -0.006 (-0.50, 48.7%) |
| H4-level-L5 |  | 161 | 6122 | 0.025 | -0.014 | 0.19 | 0.426 | 49.7% | -0.375 | 0.008 | -0.017 | 0.18 | 0.18 | -0.051 (-0.32) | 0.181 (0.76) | -0.093 | 0.012 (0.98, 56.3%) |
| H5-level-L5 | yes | 161 | 7268 | 0.283 | 0.257 | 2.01 | 0.023 | 57.8% | -0.117 | 0.186 | -0.097 | 1.79 | 1.70 | 0.332 (2.17) | 0.183 (0.62) | 1.324 | 0.014 (1.32, 55.4%) |
| H5-change-L5 |  | 158 | 7047 | 0.342 | 0.351 | 2.29 | 0.012 | 62.0% | -0.058 | 0.212 | -0.129 | 2.03 | 1.83 | 0.349 (2.29) | 0.327 (0.99) | 1.740 | 0.008 (0.72, 56.1%) |
| H5-level-L20 |  | 160 | 7213 | 0.769 | 1.089 | 2.74 | 0.003 | 62.5% | 0.369 | 0.405 | -0.364 | 2.70 | 2.73 | 0.656 (2.17) | 0.995 (1.68) | 2.710 | 0.028 (2.50, 61.4%) |
| H5-change-L20 |  | 157 | 6992 | 0.779 | 0.647 | 2.68 | 0.004 | 58.0% | 0.379 | 0.428 | -0.350 | 2.55 | 2.53 | 0.660 (2.27) | 1.018 (1.55) | 2.870 | 0.014 (1.23, 57.3%) |
| H6-spike-L5 | yes | 158 | 3245 | 0.219 | 0.240 | 1.12 | 0.133 | 56.3% | -0.181 | 0.175 | -0.044 | 1.60 | 1.33 | 0.096 (0.40) | 0.468 (1.42) | 1.894 | 0.032 (1.78, 60.5%) |
| H6-level-L5 |  | 161 | 3386 | 0.104 | -0.133 | 0.55 | 0.291 | 48.4% | -0.296 | 0.013 | -0.091 | 0.73 | 0.54 | 0.146 (0.68) | 0.019 (0.05) | 0.932 | 0.027 (1.51, 64.4%) |
| H6-spike-L20 |  | 157 | 3217 | 0.883 | 0.733 | 2.29 | 0.012 | 58.6% | 0.483 | 0.444 | -0.439 | 2.90 | 2.57 | 0.402 (0.95) | 1.856 (2.39) | 6.542 | 0.060 (4.26, 76.7%) |
| H6-level-L20 |  | 160 | 3358 | 0.481 | 0.570 | 1.30 | 0.097 | 55.0% | 0.081 | 0.145 | -0.337 | 1.94 | 1.98 | 0.216 (0.49) | 1.016 (1.53) | 4.179 | 0.068 (4.93, 72.7%) |

##### By year (mean spread %, dates)

| test | 2013 | 2014 | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| H4-change-L20 | -0.42 (4) | -0.45 (12) | 0.05 (12) | -0.58 (12) | -0.70 (12) | -0.54 (12) | 2.58 (12) | -1.96 (12) | 0.50 (12) | -0.06 (12) | -1.05 (12) | 1.51 (12) | 1.29 (12) | 4.27 (9) |
| H4-level-L20 | -0.91 (7) | -0.16 (12) | -0.27 (12) | -0.18 (12) | -1.34 (12) | 0.11 (12) | 0.90 (12) | -0.99 (12) | -1.38 (12) | -0.29 (12) | 0.88 (12) | 0.79 (12) | 0.12 (12) | 1.80 (9) |
| H4-change-L5 | -0.17 (4) | 0.20 (12) | -0.02 (12) | -0.43 (12) | -0.51 (12) | -0.88 (12) | 0.45 (12) | -0.82 (12) | 0.54 (12) | 0.08 (12) | -0.49 (12) | 0.08 (12) | -0.02 (12) | 0.90 (10) |
| H4-level-L5 | 0.23 (7) | 0.18 (12) | 0.53 (12) | -0.18 (12) | -0.23 (12) | -0.65 (12) | 0.23 (12) | -0.53 (12) | -0.18 (12) | 0.13 (12) | 0.30 (12) | 0.42 (12) | 0.12 (12) | 0.06 (10) |
| H5-level-L5 | -0.17 (7) | 0.78 (12) | 0.80 (12) | 0.17 (12) | 0.41 (12) | 0.57 (12) | 0.22 (12) | -0.23 (12) | 0.08 (12) | 0.32 (12) | 0.26 (12) | -0.76 (12) | 0.10 (12) | 1.40 (10) |
| H5-change-L5 | 0.48 (4) | 0.63 (12) | 0.88 (12) | 0.02 (12) | 0.24 (12) | 0.76 (12) | 0.85 (12) | -0.57 (12) | 0.12 (12) | 0.34 (12) | 0.35 (12) | -0.80 (12) | -0.13 (12) | 1.97 (10) |
| H5-level-L20 | -1.93 (7) | 2.45 (12) | 0.51 (12) | -0.34 (12) | 1.35 (12) | 1.45 (12) | 1.20 (12) | -1.02 (12) | 0.78 (12) | 1.66 (12) | 0.31 (12) | -0.03 (12) | 1.11 (12) | 2.60 (9) |
| H5-change-L20 | -1.74 (4) | 0.99 (12) | 1.56 (12) | -0.40 (12) | 1.47 (12) | 1.66 (12) | 2.12 (12) | -1.87 (12) | 0.21 (12) | 1.10 (12) | 0.81 (12) | 0.27 (12) | 0.49 (12) | 3.13 (9) |
| H6-spike-L5 | 0.89 (4) | 0.90 (12) | -1.36 (12) | -1.51 (12) | 0.29 (12) | 0.21 (12) | -0.39 (12) | 2.11 (12) | 0.43 (12) | 0.02 (12) | -0.21 (12) | 0.96 (12) | -0.17 (12) | 1.58 (10) |
| H6-level-L5 | -0.01 (7) | 1.09 (12) | -0.62 (12) | -1.33 (12) | 0.60 (12) | 0.38 (12) | 0.08 (12) | 1.31 (12) | -0.19 (12) | -0.13 (12) | -0.50 (12) | 0.76 (12) | -0.11 (12) | 0.09 (10) |
| H6-spike-L20 | -0.96 (4) | 0.35 (12) | -1.64 (12) | 1.05 (12) | 1.61 (12) | -0.58 (12) | -0.82 (12) | 2.43 (12) | 1.04 (12) | 1.57 (12) | -0.22 (12) | 0.40 (12) | 1.37 (12) | 7.08 (9) |
| H6-level-L20 | -3.63 (7) | 0.15 (12) | 0.26 (12) | -0.16 (12) | 0.90 (12) | -0.07 (12) | -0.14 (12) | 1.27 (12) | 0.13 (12) | 2.36 (12) | -0.08 (12) | 0.81 (12) | 0.92 (12) | 2.92 (9) |

#### H7: implied move vs ripple history

Candidate (event, hit) pairs with >= 6 similar past events: 2951.

| sample | pairs | dates | mean implied % | mean history % | mean realized % | gap > 0 | realized > implied (gap > 0) | t | p one-sided | same, gap <= 0 | options >= history | realized <= implied (all) | slope (R-I on gap) | t | Spearman | median R/I | R on I: b (t) | R on H: b (t) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| L=5 abnormal (primary) | 2950 | 311 | 3.81 | 3.62 | 4.18 | 1468 | 54.5% | 2.35 | 0.010 | 39.3% | 50.2% | 53.2% | 0.384 | 6.83 | 0.257 | 0.85 | 0.595 (10.09) | 0.189 (2.59) |
|   first 2/3 (< 2025-06-10) | 1920 | 208 | 3.21 | 3.50 | 3.54 | 1138 | 53.1% | 1.34 | 0.091 | 35.7% | 40.7% | 54.0% | 0.443 | 6.15 | 0.287 | 0.82 | 0.489 (6.70) | 0.158 (1.86) |
|   last 1/3 | 1030 | 103 | 4.93 | 3.85 | 5.39 | 330 | 59.4% | 2.97 | 0.002 | 43.3% | 68.0% | 51.6% | 0.410 | 4.91 | 0.239 | 0.91 | 0.583 (6.77) | 0.265 (2.00) |
|   recent year (> 2025-11-06) | 933 | 95 | 5.08 | 3.84 | 5.53 | 263 | 59.7% | 2.59 | 0.006 | 43.7% | 71.8% | 51.8% | 0.432 | 5.02 | 0.241 | 0.91 | 0.563 (6.36) | 0.320 (2.24) |
|   2023 | 770 | 89 | 3.06 | 3.49 | 3.03 | 496 | 46.0% | -1.24 | 0.890 | 33.9% | 35.6% | 58.3% | 0.344 | 4.73 | 0.214 | 0.81 | 0.565 (6.01) | 0.174 (2.04) |
|   2024 | 750 | 85 | 3.38 | 3.45 | 3.75 | 406 | 54.4% | 1.15 | 0.126 | 37.5% | 45.9% | 53.3% | 0.434 | 3.58 | 0.257 | 0.80 | 0.483 (4.09) | 0.024 (0.16) |
|   2025 | 587 | 52 | 3.41 | 3.68 | 4.22 | 329 | 62.0% | 3.59 | <0.001 | 38.8% | 44.0% | 48.2% | 0.460 | 3.82 | 0.344 | 0.89 | 0.526 (4.30) | 0.296 (1.60) |
|   2026 | 843 | 85 | 5.16 | 3.85 | 5.60 | 237 | 62.0% | 3.01 | 0.002 | 42.9% | 71.9% | 51.7% | 0.467 | 5.35 | 0.262 | 0.91 | 0.524 (5.80) | 0.304 (2.02) |
| L=20 abnormal | 2827 | 300 | 6.88 | 7.56 | 8.36 | 1709 | 54.2% | 2.52 | 0.006 | 45.6% | 39.5% | 49.2% | 0.368 | 4.48 | 0.209 | 0.95 | 0.615 (7.05) | 0.311 (3.25) |
|   first 2/3 (< 2025-05-13) | 1862 | 200 | 5.66 | 7.27 | 7.33 | 1321 | 55.0% | 2.47 | 0.007 | 47.5% | 29.1% | 47.2% | 0.413 | 4.61 | 0.201 | 0.98 | 0.471 (4.61) | 0.252 (2.69) |
|   last 1/3 | 965 | 100 | 9.23 | 8.11 | 10.36 | 388 | 51.5% | 0.61 | 0.271 | 43.8% | 59.8% | 53.1% | 0.373 | 2.88 | 0.207 | 0.88 | 0.635 (4.97) | 0.401 (2.25) |
|   recent year (> 2025-10-08) | 836 | 85 | 9.67 | 8.07 | 10.55 | 283 | 48.4% | -0.52 | 0.696 | 43.2% | 66.1% | 55.0% | 0.368 | 2.64 | 0.188 | 0.84 | 0.637 (4.71) | 0.386 (1.94) |
|   2023 | 767 | 89 | 5.67 | 7.19 | 6.68 | 569 | 47.3% | -0.98 | 0.834 | 42.4% | 25.8% | 54.0% | 0.209 | 1.90 | 0.111 | 0.89 | 0.695 (4.44) | 0.163 (1.39) |
|   2024 | 749 | 85 | 5.95 | 7.21 | 7.34 | 509 | 55.4% | 1.87 | 0.033 | 47.9% | 32.0% | 47.0% | 0.452 | 3.92 | 0.203 | 1.00 | 0.436 (3.64) | 0.227 (1.57) |
|   2025 | 582 | 52 | 5.95 | 7.86 | 8.62 | 394 | 64.0% | 3.76 | <0.001 | 52.1% | 32.3% | 39.9% | 0.413 | 2.93 | 0.253 | 1.08 | 0.509 (3.45) | 0.248 (1.46) |
|   2026 | 729 | 74 | 9.83 | 8.06 | 10.97 | 237 | 52.3% | 0.70 | 0.243 | 43.3% | 67.5% | 53.8% | 0.433 | 2.98 | 0.225 | 0.86 | 0.585 (4.17) | 0.507 (2.34) |
| L=5 raw units | 2950 | 311 | 5.43 | 3.62 | 5.34 | 386 | 43.5% | -2.04 | 0.978 | 41.0% | 86.9% | 58.6% | 0.196 | 2.18 | 0.103 | 0.82 | 0.791 (8.58) | 0.022 (0.23) |
|   first 2/3 (< 2025-06-10) | 1920 | 208 | 4.85 | 3.50 | 4.78 | 323 | 47.1% | -0.83 | 0.795 | 40.1% | 83.2% | 58.7% | 0.294 | 2.16 | 0.112 | 0.82 | 0.644 (4.65) | 0.017 (0.15) |
|   last 1/3 | 1030 | 103 | 6.50 | 3.85 | 6.39 | 63 | 25.4% | -4.41 | 1.000 | 42.5% | 93.9% | 58.5% | 0.100 | 0.94 | 0.081 | 0.83 | 0.900 (8.45) | 0.052 (0.31) |
|   recent year (> 2025-11-06) | 933 | 95 | 6.66 | 3.84 | 6.65 | 55 | 23.6% | -4.45 | 1.000 | 44.1% | 94.1% | 57.1% | 0.157 | 1.44 | 0.112 | 0.85 | 0.843 (7.74) | 0.159 (0.90) |
|   2023 | 770 | 89 | 4.27 | 3.49 | 4.07 | 191 | 46.6% | -0.66 | 0.745 | 37.0% | 75.2% | 60.6% | 0.256 | 2.56 | 0.100 | 0.79 | 0.645 (5.61) | 0.119 (1.06) |
|   2024 | 750 | 85 | 4.83 | 3.45 | 5.06 | 105 | 48.6% | -0.27 | 0.604 | 43.7% | 86.0% | 55.6% | 0.216 | 1.16 | 0.071 | 0.88 | 0.689 (3.77) | -0.148 (-0.72) |
|   2025 | 587 | 52 | 5.80 | 3.68 | 5.63 | 37 | 40.5% | -1.26 | 0.888 | 40.7% | 93.7% | 59.3% | 0.295 | 0.94 | 0.099 | 0.79 | 0.693 (2.23) | 0.038 (0.13) |
|   2026 | 843 | 85 | 6.75 | 3.85 | 6.54 | 53 | 24.5% | -4.20 | 1.000 | 42.0% | 93.7% | 59.1% | 0.172 | 1.54 | 0.118 | 0.80 | 0.828 (7.42) | 0.182 (1.05) |
| L=20 raw units | 2827 | 300 | 10.14 | 7.56 | 10.28 | 495 | 44.4% | -2.00 | 0.976 | 40.9% | 82.5% | 58.5% | 0.202 | 1.59 | 0.131 | 0.82 | 0.788 (5.71) | 0.164 (1.29) |
|   first 2/3 (< 2025-05-13) | 1862 | 200 | 9.04 | 7.27 | 9.48 | 411 | 47.7% | -0.74 | 0.771 | 43.8% | 77.9% | 55.4% | -0.001 | -0.01 | 0.040 | 0.89 | 0.993 (9.49) | -0.013 (-0.14) |
|   last 1/3 | 965 | 100 | 12.26 | 8.11 | 11.82 | 84 | 28.6% | -3.87 | 1.000 | 36.1% | 91.3% | 64.6% | 0.337 | 1.87 | 0.219 | 0.70 | 0.660 (3.60) | 0.325 (1.35) |
|   recent year (> 2025-10-08) | 836 | 85 | 12.63 | 8.07 | 11.75 | 61 | 21.3% | -5.49 | 1.000 | 33.4% | 92.7% | 67.5% | 0.302 | 1.64 | 0.218 | 0.63 | 0.695 (3.82) | 0.288 (1.05) |
|   2023 | 767 | 89 | 8.14 | 7.19 | 8.81 | 237 | 50.2% | 0.05 | 0.478 | 42.3% | 69.1% | 55.3% | 0.029 | 0.17 | 0.083 | 0.87 | 0.954 (4.21) | 0.022 (0.14) |
|   2024 | 749 | 85 | 9.00 | 7.21 | 9.01 | 146 | 45.2% | -0.82 | 0.790 | 41.1% | 80.5% | 58.1% | 0.240 | 1.47 | 0.093 | 0.81 | 0.720 (3.59) | 0.196 (1.16) |
|   2025 | 582 | 52 | 10.89 | 7.86 | 11.44 | 59 | 37.3% | -1.81 | 0.959 | 48.4% | 89.9% | 52.7% | -0.295 | -2.37 | -0.104 | 0.95 | 1.246 (10.23) | -0.381 (-1.94) |
|   2026 | 729 | 74 | 12.81 | 8.06 | 12.21 | 53 | 24.5% | -4.54 | 1.000 | 33.7% | 92.7% | 66.9% | 0.438 | 2.38 | 0.269 | 0.66 | 0.579 (3.18) | 0.522 (1.76) |

