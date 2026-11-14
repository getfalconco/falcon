# F7 insider purchase clusters: Falcon's own post-2015 estimate

Design: `docs/design/ripple-engine-v1.md` 6.1-6.6, 7.1 ("Documented"), 10 a10 / b3.
Code: `src/study/abnormal.ts`, `src/study/stats.ts`, `src/study/controls.ts`,
`src/study/insider-events.ts`, `scripts/backfill-insider.ts`; tests in
`test/study.test.ts`. Outputs (gitignored): `.cache/study/f7-panel.ndjson`,
`f7-summary.json`, `f7-summary.md`.

Internal research only. Prices come from Yahoo as a stand-in; no price-derived
number from this study is displayed to users.

## Method

**Events.** SEC Insider Transactions Data Sets, 2012 Q1 to 2026 Q2 (tables
SUBMISSION, REPORTINGOWNER, NONDERIV_TRANS). Events are dated 2015-01-01 to
2026-06-30; 2012-2014 is read only so the routine filter has three prior years.

- Purchases: transaction code P, acquired, non-derivative common stock, original
  Form 4 (not 4/A), shares and price > 0. One filing = one insider (its first
  reporting owner).
- 10b5-1: filings with `AFF10B5ONE` = 1 (present from 2023) are dropped.
- Routine insiders (Cohen, Malloy & Pomorski 2012): an insider who traded (P or
  S) the issuer's stock in the same calendar month in each of the three prior
  years is dropped for that trade.
- Event rule: 3 or more distinct insiders with purchase filings at one issuer
  within 5 NYSE business days (the event is the filing date that reaches 3), or
  a single officer or director filing with purchases of $100k or more at a
  company worth under $2B (XBRL `dei:EntityCommonStockSharesOutstanding`, latest
  cover-page instant on or before the filing, times the purchase price).
- One event per issuer per 30 calendar days (later triggers of the same episode
  are not new events).
- Event time: the EDGAR acceptance (from the filing's `-index.htm` "Accepted"
  line) of the filing that completes the rule. When it could not be read, the
  event is taken as public after the close of the filing date (Section 16
  filings keep the acceptance day as their filing date until 22:00), which can
  only make the entry later, never earlier.

**Universe gate (the population cards would show).** The issuer's CIK maps to a
ticker currently listed on Nasdaq, NYSE or Cboe (`company_tickers_exchange.json`),
Yahoo has its history, unadjusted price > $5 at the last close before the event
(split-adjusted close times later split ratios) and 20-session median dollar
volume >= $5M.

**Measurement (`abnormal.ts`).**
- Entry t0 = the first regular-session open strictly after the public time plus
  latency (0 here). NYSE calendar from rules (weekends, holidays incl. Juneteenth
  from 2022, Good Friday, national mourning days, Sandy, 13:00 early closes);
  checked against SPY's trading days.
- Market model on SPY, close-to-close total returns, sessions [-260, -11]
  relative to day 0 (the first session whose close is after the public time),
  >= 120 valid days.
- PRE = last close before the public time -> t0 open (already happened at
  entry; not ranked). DRIFT_L = t0 open -> close of session t0 + L - 1, L in
  {5, 20, 60}; the first session is open-to-close.
- CAR = sum of market-model abnormal returns; SCAR = CAR / (sigma sqrt L).
  Abnormal % below is CAR in percent (= sigma sqrt(L) SCAR).
- Inference (`eventStudy`): t clustered by event date with G-1 df; two-way
  (issuer x calendar month, Cameron-Gelbach-Miller) as a second column;
  wild-cluster bootstrap p when G < 30.

**Matched controls (`controls.ts`).** For each event, 3-5 listed firms on the
same event date with the same 3-digit SIC (2-digit if fewer than 3 qualify),
the 10 nearest in log market value, then the 5 nearest in market-model beta;
price > $5, 20-day median dollar volume >= $5M; no own 8-K Item 2.02 and no own
F7 event from 5 sessions before day 0 to min(L, 20) sessions after entry
(controls are chosen per window). F7 is an
own-firm family, so there is no graph path to exclude. y = SCAR_hit - mean
SCAR_controls (sign +1), winsorized at +/-3. Controls come from today's listed
firms (the same survivorship as the hits).

**Calendar-time check.** Each day, an equal-weighted portfolio of open
positions (sessions t0 .. t0+19) of r_i - beta_i r_SPY (and, second, minus the
same for the event's matched controls). Mean in bp/day with a Newey-West t.

## Results (computed 2026-11-14, full run, matched controls on all events)

### Funnel and survivorship gap

| step | events |
|---|---|
| purchase filings 2015-01..2026-06 (P, original Form 4, common, not 10b5-1) | 170,447 filings (326,986 rows) |
| dropped: routine insiders / 10b5-1-flagged P rows | 10,736 filings / 4,775 rows |
| F7 events (cluster 6,499, single 8,736, both 1,486) | 16,721 |
| issuer not listed on Nasdaq/NYSE/Cboe today (**survivorship gap**) | 6,637 (39.7%) |
| no Yahoo series / Yahoo history does not cover the event | 5 / 231 |
| price <= $5 / 20-day median dollar volume < $5M | 2,513 / 4,423 |
| gated (liquid universe) | 2,912 |
| fewer than 120 estimation days (mostly recent IPOs) | 68 |
| **measured** | **2,844 events on 1,451 dates, 1,134 issuers** |
| event time from EDGAR acceptance / from the filing-date close | 2,836 / 8 |
| with >= 3 matched controls at L = 20 (SIC3 2,087, SIC2 521) | 2,608 |

The survivorship gap is large and not random: 57% of 2015 events but 15% of
2025 events are at issuers no longer listed (delisted, acquired, gone private
or moved to OTC). Among issuers still listed, 29% of events pass the liquidity
gate; at that rate roughly 1,900 liquid events are missing, about 40% of the
true liquid population. Yahoo has no delisted symbols and no delisting returns,
so neither performance delistings (negative) nor takeovers (positive) are in
the sample. The sign of the bias is not known; treat the numbers as an upper
bound on what a survivor-free panel would show until a licensed source with
delisted names is used.

Timing: 1,960 events became public after the close, 574 intraday and 310
before the open.

### DRIFT_L from the tradable entry, all events

Abnormal % = market-model CAR in percent. t (date) clusters by event date
(df = G - 1); t (2-way) clusters by issuer and calendar month. y is the
matched-control outcome in SCAR units (winsorized at +/-3); "beta-only" drops
the estimation-window alpha (see caveat 1).

| L | n | G | mean % | median % | t (date) | p (date, 2-sided) | t (2-way) | beta-only mean % (t) | raw minus SPY % (t) | y n | mean y | t y (date) | t y (2-way) | y beta-only (t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5 | 2,844 | 1,451 | 0.84 | 0.42 | 3.85 | 0.0001 | 4.34 | 0.69 (3.15) | 0.63 (2.91) | 2,664 | 0.156 | 7.49 | 5.72 | 0.120 (5.73) |
| 20 | 2,844 | 1,451 | **1.56** | **1.54** | **4.67** | 0.000003 | 3.28 | 0.96 (2.99) | 0.70 (2.29) | 2,608 | 0.135 | 7.27 | 6.83 | 0.059 (3.31) |
| 60 | 2,844 | 1,451 | 4.26 | 3.78 | 6.39 | < 0.0001 | 2.83 | 2.46 (4.18) | 1.94 (3.31) | 2,608 | 0.202 | 9.38 | 7.49 | 0.072 (3.55) |

At L = 20 the matched y of 0.135 SCAR is about 1.34% in return terms
(y x sigma sqrt 20; 0.78% beta-only). G >= 30 everywhere, so no bootstrap p.

PRE (last close before acceptance -> entry open), already happened at entry:
mean +1.87% (t 29). Most of the market's first reaction happens before anyone
can trade on the filing; v0's reading from the prior close counted it.

### By period (L = 20)

| period | n | G | mean % | median % | t (date) | t (2-way) | beta-only % (t) | y n | mean y (t date) | y beta-only (t) |
|---|---|---|---|---|---|---|---|---|---|---|
| development 2015-2021 | 1,502 | 816 | 1.67 | 1.79 | 3.33 | 2.51 | 1.33 (2.69) | 1,349 | 0.146 (5.33) | 0.085 (3.23) |
| validation 2022-2023 | 530 | 271 | 1.47 | 1.59 | 2.53 | 1.50 | 0.09 (0.16) | 509 | 0.097 (2.35) | -0.002 (-0.04) |
| holdout 2024-2026H1 | 812 | 364 | 1.41 | 0.96 | 2.33 | 1.53 | 0.84 (1.57) | 750 | 0.141 (4.59) | 0.055 (1.86) |

L = 5 and L = 60 by period are in `f7-summary.md`. At L = 60 the holdout is
weaker: mean 1.97% (t 1.59), beta-only 0.24% (t 0.26).

### By size and kind (L = 20)

| group | n | mean % | t (date) | beta-only % (t) | mean y (t) |
|---|---|---|---|---|---|
| micro < $300M | 65 | 0.04 | 0.01 | 2.52 (1.01) | 0.089 (0.76) |
| small $300M-2B | 1,823 | 1.88 | 4.66 | 1.30 (3.40) | 0.151 (6.76) |
| mid $2-10B | 522 | 1.42 | 2.81 | 0.30 (0.63) | 0.134 (2.98) |
| large > $10B | 216 | 0.93 | 1.80 | 0.46 (0.97) | 0.132 (2.20) |
| size unknown (no XBRL shares) | 218 | 0.25 | 0.23 | -0.28 (-0.27) | -0.012 (-0.14) |
| cluster (3+ insiders, incl. both rules) | 1,232 | 1.78 | 3.92 | 1.06 (2.36) | 0.152 (5.02) |
| single officer/director >= $100k, < $2B | 1,612 | 1.39 | 3.49 | 0.88 (2.41) | 0.122 (5.25) |
| excluding events with own 8-K 2.02 in the window | 2,667 | 1.52 | 4.65 | 0.88 (2.83) | 0.134 (7.02) |

### Calendar time (L = 20)

Daily equal-weighted portfolio of open positions, 2,905 days, about 20
positions a day, Newey-West (8 lags):
- r_i - beta_i r_SPY: +3.1 bp/day (about 0.6% over 20 sessions), t = 1.42, p = 0.16.
- minus the matched controls' r_c - beta_c r_SPY: +4.2 bp/day, t = 2.73, p = 0.006.

## Own estimate written to the registry

`data/evidence-registry.json` F7 `ownEstimate`: L = 20 DRIFT from the tradable
entry, market model, all measured events: n 2,844, nEvents (distinct event
dates) 1,451, mean 1.56%, median 1.54%, t 4.67 (clustered by event date), p
0.0000017 (one-sided, H1: mean > 0, as 7.1 uses it; two-sided 0.0000034).

Under 7.1 the point estimate is > 0 and F7 is `exact`, so F7 qualifies as
Documented. Every column is positive at L = 20 pooled: market model, beta-only,
raw minus SPY, matched-control y, and the matched calendar-time portfolio.

## Caveats and what they imply

1. **The market-model alpha flatters the estimate.** Insiders buy after
   declines, so the estimation-window alpha over [-260, -11] is negative on
   average, and subtracting it adds about 0.6 points at L = 20 (1.56% vs 0.96%
   beta-only) and about 1.8 points at L = 60. The matched control difference
   does not remove it either (y 0.135 vs 0.059 beta-only). The beta-only
   matched y is still positive pooled (t 3.3) and in the holdout (t 1.9), but
   about zero in the 2022-2023 validation period. Expect a real post-2015
   edge nearer 0.5-1% over 20 sessions than 1.5%, before costs, concentrated
   in $300M-2B companies. Recommendation for b4: use beta-only (or a
   characteristics-matched benchmark) as the ranking column, and keep the
   market model as the 6.1 headline only with this robustness column beside it.
2. **Survivorship.** 40% of events are at issuers that are no longer listed
   and are absent; no delisting returns. See the funnel.
3. **Yahoo as a price source** (internal stand-in, terms forbid commercial use;
   nothing here is displayed). Dividend-adjusted closes; opens scaled by the
   same factor; unadjusted price rebuilt from Yahoo's split events for the $5
   gate. Current tickers only (CIK -> today's ticker), so renamed firms are
   kept but reused symbols are not checked.
4. **Acceptance times** came from each filing's EDGAR index page for 2,836 of
   2,844 measured events; 8 fall back to the filing date's close. Event time is
   the acceptance of the filing that completes the rule; when several filings
   complete it on one day, the needed-th earliest new-insider acceptance.
5. **Size** uses the cover-page share count (XBRL frames) times the purchase
   price, so the $2B single-purchase rule and the size buckets are
   approximate; 218 measured events have no XBRL share count ("unknown").
6. **Controls** are drawn from today's listed firms (same survivorship as the
   hits). The 8-K 2.02 screen covers [-5, +min(L, 20)] sessions: for L = 60 a
   [-5, +60] screen leaves almost no candidates, since nearly every firm
   reports inside 65 sessions. Controls are screened for their own F7 events
   in the same span.
7. **Overlap.** One event per issuer per 30 days; 60-session windows of the
   same issuer can still overlap, which the issuer dimension of the two-way SE
   covers. The two-way t is the more conservative column (3.28 at L = 20).
8. **One filing = one insider** (first reporting owner). Joint filings by
   related entities count once; separate filings by affiliated funds can still
   count as separate insiders.
9. Costs are not deducted. The liquid gate keeps spreads small, but a 0.5-1%
   edge over 20 sessions is thin after costs for the smaller names.

## Reproduce

```bash
cd packages/engine
# all phases: download (resumable curl of the 2012q1..2026q2 zips listed on
# https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets),
# parse, events, sec, prices, accept, measure
node --max-old-space-size=6144 --import tsx scripts/backfill-insider.ts
node --max-old-space-size=6144 --import tsx scripts/backfill-insider.ts measure    # re-measure only (~20 s)
```

Runtime on 2026-11-14: parse and events about 1 min; SEC submissions for 6,032
CIKs about 19 min; Yahoo for 5,636 tickers about 30 min (one restart after
Yahoo began answering 429 to a long browser User-Agent); EDGAR acceptance for
6,311 accessions about 15 min; measurement with matched controls about 20 s.
Every phase resumes from its cache.
