# Stock order flow: quiet accumulation (H1) and ripple + flow (H3)

Plan: Obsidian `Falcon/Engine/Options Signals.md`, order flow, hypotheses 1 and 3.
Pre-registration (frozen before any flow or outcome was pulled):
`data/preregistration/flow-v1.json`. Code: `src/options/study-flow.ts` (pure),
`scripts/flow-study.ts` (runner), `test/flow-study.test.ts`. Features come from
`src/options/flow.ts` unchanged; measurement from `src/study/abnormal.ts`.
Outputs (gitignored): `.cache/flow-study/flow-panel.ndjson` (daily flow per
name), `events.json`, `results.json`, `results.md`.

Internal research only. Prices are Yahoo adjusted bars (the F7 study's cache) as
a stand-in.

## Verdict

Both hypotheses fail the pre-registered bar. Neither is close.

| | Statistic | n | dates | estimate | t | p (1-sided) | BH | later half > 0 | Pass |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| H1 quiet accumulation | CAR10 minus same-date control | 211 events | 122 | +0.37% | 0.84 | 0.20 | no | yes (+0.10%) | **fail** |
| H3 ripple + flow | confirmed minus not confirmed, CAR10 | 156 vs 163 hits | 81 | -0.14% | -0.22 | 0.59 | no | no (-0.22%) | **fail** |

The signed flow itself is real: a name-day's dollar imbalance correlates 0.17
with the same day's return (7,140 name-days), and hits whose flow went the
implied way had already moved that way (median +1.19% excess over the flow
window vs -0.34% for the others). It does not predict what comes next: the
next-day correlation is 0.005, and neither signal carries into the following
10 sessions.

## Data and cost

- XNAS.ITCH `trades`, 28 Nasdaq-listed semis, every NYSE session 2023-06-26 to
  2024-06-28 (255), 09:30 to 16:10 New York, one request per session for all
  names (`fetchStockTrades`, `regularOnly`), so no day was paid twice.
- Every batch was dry-run first (`plan` phase: projected $29.38). Ledger,
  caller `flow-hypotheses`: 255 charges, 0 refunds, **$29.38** (get_cost
  estimates, which overstate the bill slightly) of the $35 cap. Ledger total
  across callers at the end of the pull: $29.55 of $90.
- Per session the batch cost $0.04 to $0.19 (median $0.11). Per name-day in 2023-24: NVMI
  $0.0002 to AMD $0.046 (AMD and NVDA left out on cost); the same names cost 2
  to 4 times more in 2025-26.
- Raw trades stay in the shared cache: 255 files, about 2.8 GB under
  `.cache/databento/data`. Only daily aggregates are kept in the panel.
- Events: EDGAR (8-K item 2.02, Taiwan monthly revenue 6-Ks), Yahoo EPS record
  for the sign. Links: `data/graph.json` degree 1. Prices: Yahoo adjusted
  opens and closes, SPY market model.

Coverage (what "signed" means here): over the sample, signed trades were 36.7%
of the dollars traded on Nasdaq's book and **13.7% of consolidated dollar
volume** (per name 9.8% AVGO to 18.5% MXL). About half of Nasdaq volume was the
closing cross, which has no side. So every flow number is the net of the
aggressive, displayed, on-Nasdaq part of trading: roughly one dollar in seven.
2023-24 coverage is higher than the 23% / 9% measured on KLAC in 2026.

## H1 quiet accumulation

Rule (pre-registered): 5-session window, `quietAccumulation` defaults; signal
when every window day has signedShare >= 2%, net signed dollars > 0, window
dollar imbalance >= the name's own 80th percentile (and >= 0), and
|5-day log return| <= 0.5 sd of its own 60-day volatility. One event per name
per 10 sessions. Entry next open; outcome CAR10 (SPY market model). Primary:
CAR10 minus the mean CAR10 of the universe names with no signal that date
(removes the common semis move), date-clustered.

7,028 eligible name-days, 521 signal days (7.4%), 211 events on 122 dates.

| Test | n | dates | mean | median | t | p | hit rate | early / late | mean - 20 bp |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Primary: CAR10 - same-date control** | 211 | 122 | +0.37% | -0.23% | 0.84 | 0.20 | 46.4% | +0.65% / +0.10% | +0.17% |
| raw CAR10 | 211 | 122 | +0.55% | +0.08% | 1.10 | 0.14 | 50.7% | +0.11% / +0.98% | +0.35% |
| CAR10 - same name's non-signal mean | 211 | 122 | +0.73% | +0.11% | 1.45 | 0.075 | 51.2% | +0.31% / +1.15% | +0.53% |
| CAR5 - same-date control | 211 | 122 | +0.11% | -0.02% | 0.35 | 0.36 | 49.8% | +0.34% / -0.12% | -0.09% |
| window 3 | 241 | 141 | +0.35% | -0.32% | 0.82 | 0.21 | 47.7% | +0.05% / +0.65% | +0.15% |
| fixed threshold 0.10 | 138 | 92 | +0.48% | +0.08% | 0.83 | 0.21 | 50.7% | +0.33% / +0.63% | +0.28% |
| mirror: quiet distribution (expect < 0) | 225 | 132 | -0.04% | -0.31% | -0.08 | 0.53 | 47.1% | +0.09% / -0.16% | -0.24% |
| reference: quiet price, any flow | 587 | 185 | +0.14% | +0.11% | 0.50 | 0.31 | 50.8% | +0.57% / -0.29% | -0.06% |

Primary robustness: two-way (firm x month) t 0.66; 10-session block clusters t
0.99 (26 blocks); placebo with the flow flags shuffled across names within each
date (1000 reps): null mean +0.08%, permutation p 0.13.

Reading: every variant has a small positive mean and a median near zero or
below; a few large winners carry the mean, the hit rate is a coin flip, and the
mirror (quiet selling) shows no negative drift, which a real flow effect would
also produce. Nothing is significant and the effect shrinks in the later half.

## H3 ripple + flow vs ripple alone

Events in the flow window: 191 signed events (semis earnings with an EPS sign,
TSM/UMC/ASX monthly revenue). Degree-1 linked hits in the universe: 442; after
one-per-ticker-day 426; 107 dropped for the hit's own earnings within
[day 0 - 1, day 0 + 12]; 319 measured on 81 event dates. Implied direction = the
event's sign. Flow window = day 0 to day 0 + 2; confirmed when its net signed
dollars go the implied way (156 of 319). Outcome = direction x CAR10 from the
open of day 0 + 3.

Primary: confirmed +0.03% (n 156, hit rate 47.4%) vs not confirmed +0.17%
(n 163, 50.3%), difference **-0.14%**, CR1 clustered by day 0, t -0.22 (80 df),
p 0.59. Early half -0.01%, later half -0.22%. Placebo (labels permuted within
day 0): p 0.60.

| Test | n | dates | mean | median | t | p | hit rate | early / late | mean - 20 bp |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ripple alone, entry day 0 + 1 | 319 | 81 | -0.12% | -0.26% | -0.25 | 0.60 | 48.0% | +0.39% / -0.63% | -0.32% |
| ripple alone, entry day 0 + 3 | 319 | 81 | +0.10% | -0.29% | 0.22 | 0.41 | 48.9% | +0.43% / -0.23% | -0.10% |
| flow confirmed, day 0 + 3 | 156 | 63 | +0.03% | -0.39% | 0.06 | 0.48 | 47.4% | +0.36% / -0.31% | -0.17% |
| flow not confirmed, day 0 + 3 | 163 | 65 | +0.17% | +0.09% | 0.27 | 0.40 | 50.3% | +0.57% / -0.24% | -0.03% |
| confirmed, earnings events only | 80 | 48 | +0.64% | +0.35% | 1.24 | 0.11 | 56.3% | +1.00% / +0.28% | +0.44% |
| confirmed, monthly revenue only | 81 | 18 | -0.61% | -0.94% | -0.85 | 0.80 | 39.5% | -0.52% / -0.71% | -0.81% |

Secondary differences (confirmed - not): 1-session flow, entry day 0 + 1:
-0.27% (t -0.39); supply-chain links only: +0.15% (t 0.17); competitor links
only: -0.55% (t -0.67); flow de-biased by the name's median imbalance: -0.68%
(t -1.04); CAR5: +0.31% (t 0.60).

Reading: in this year, the ripple itself had no drift after the reaction (the
implied-way CAR10 is about zero from either entry), so there was nothing for
flow to sharpen. Flow agreeing with the ripple marks hits that had already
moved, not hits that will move. The one positive-looking cell (confirmed hits
of earnings events, +0.64%, t 1.24) is a post-hoc split of a failed test and is
not evidence.

## What it means for Falcon's cards

- Do not show "quiet accumulation" or "flow confirms" as a predictive signal or
  as a reason to rank a hit higher. On this sample neither adds return over the
  next 2 weeks, before or after 20 bp of costs.
- Flow can still be shown as description ("aggressive buyers outnumbered
  sellers on Nasdaq over 3 days"): it tracks what the price did. It must not be
  framed as "the market has not priced this yet".
- Not worth buying live trade-side data for these two uses. If flow is retried,
  it needs a broader trade-signing source (consolidated tape with a quote-based
  classifier, or off-exchange prints), a longer sample, and a fresh
  pre-registration (flow-v2), not a re-cut of this one.

## Caveats

- Coverage: the signed sample is ~14% of consolidated dollars, the aggressive
  displayed part of Nasdaq's book only. Institutions working orders through
  dark pools, the closing cross, or passive limit orders are invisible here, so
  "no effect from ITCH signed flow" is not "no effect from institutional
  buying". This is the main limit on what the null means.
- One year (2023-07 to 2024-06), one sector, 28 names, a strong semis rally:
  the power for a ~0.5% 10-day effect is modest (H1 SE ~0.44%).
- NVDA and AMD were left out on cost, so H3 loses their roles as hits.
- Links are today's graph (10-Ks filed up to 2026), applied to 2023-24: a
  look-ahead in which links exist. Foreign filers (ASML, NVMI, CAMT, ARM, STM,
  GFS) have no 8-K earnings events; QRVO had no CIK in the ticker map.
- The H1 threshold is each name's own 80th percentile over the whole sample (a
  look-ahead in the threshold only; the fixed-0.10 version agrees).
- Yahoo prices are a stand-in; the SPY market model leaves the semis factor in,
  which is why the H1 primary uses a same-date universe control.

## Notes for the core (`src/options/`, not changed)

- `quietAccumulation` treats consecutive `flow` entries as consecutive
  sessions; a missing day silently widens the window. The study fills gaps
  with empty days (`fillSessions` in study-flow.ts). Suggest it take the
  session calendar, or document that the caller must fill gaps.
- README coverage numbers (23% of Nasdaq, 9% consolidated) are one KLAC day in
  2026; across 28 semis in 2023-24 they were 37% and 14%. Worth a line.
- README per name-day cost ($0.015 mid-cap) is a 2026 full-day (04:00-20:00)
  price; regular-session pulls in 2023-24 were $0.0002 to $0.01 for most
  names. Worth a line.
- `fetchStockTrades` keeps every trade in memory and the client caches raw
  JSON (~11 MB per 28-name session). A per-day aggregate cache would save the
  2.8 GB if flow is pulled again at scale.

## Reproduce

```bash
cd packages/engine
node --import tsx scripts/flow-study.ts plan       # dry run, prints the projected cost
node --import tsx scripts/flow-study.ts pull       # resumable; cached sessions are free
node --import tsx scripts/flow-study.ts events     # EDGAR + Yahoo EPS
node --import tsx scripts/flow-study.ts analyze    # results.json, results.md
```
