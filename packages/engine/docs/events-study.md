# Late filings, 13D stakes and 4.02 restatements: Falcon's own post-2015 estimates

Pre-registration (frozen and committed before any outcome was pulled):
`data/preregistration/events-v1.json`. Code: `src/study/filing-events.ts`
(pure event rules and the pass bar), `scripts/events-study.ts` (runner);
measurement is the F7 study's `src/study/abnormal.ts`, `controls.ts` and
`stats.ts`, unchanged. Tests: `test/filing-events.test.ts`. Outputs
(gitignored): `.cache/study/events-v1-panel.ndjson`, `events-v1-summary.json`,
`events-v1-summary.md`.

Internal research only. Prices come from Yahoo as a stand-in (the F7 study's
cache plus 274 symbols this study added). No LLM was used; Anthropic spend $0.

## Verdict

None of the three families passes the pre-registered bar. All three stay
Watch, and the evidence registry gets no new `ownEstimate`.

Primary: beta x SPY abnormal return over the 20 sessions after the first open
following EDGAR acceptance (the F7 registered column). p is one-sided in the
expected direction. Bar (same as F7): expected sign, p < 0.05 from the two-way
(issuer x month) t and from the date-clustered t, n >= 100.

| family | expected | n | dates | mean % | median % | t (2-way) | p (2-way) | t (date) | p (date) | pass |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| F6 late filing (NT 10-K / NT 10-Q) | - | 501 | 253 | -0.80 | -0.80 | -0.60 | 0.275 | -0.73 | 0.234 | **fail** |
| F8 initial 13D by a third party | + | 1,033 | 832 | -0.52 | -0.13 | -0.73 | 0.766 | -0.77 | 0.781 | **fail** (wrong sign) |
| 4.02 restatement (8-K non-reliance) | - | 187 | 156 | -0.28 | -1.49 | -0.10 | 0.461 | -0.17 | 0.434 | **fail** |

For reference, F7 on the same column: n 2,844, mean +0.96%, two-way t 2.22,
p 0.014 (passes).

The measurement is working: the move between the last close before the filing
and the first tradable open (PRE, already gone by entry) goes the expected way
and is large in all three: late filings -1.17% (t -4.0 by date), 13Ds +1.05%
(t 9.4), restatements -1.55% (t -2.8). What the filing tells the market is
priced by the next open. What follows over the next 20 sessions is not
distinguishable from zero for any family.

## Method

As pre-registered; the one change is below under "Deviation".

- **Events** (filing dates 2015-01-01 to 2026-06-30), EDGAR full-index
  `master.gz` 2015 QTR1 to 2026 QTR4:
  - late filing: form type exactly NT 10-K or NT 10-Q (amendments, NT 20-F,
    NT 11-K out); issuer = filing CIK.
  - 13D: form type exactly SC 13D or SCHEDULE 13D (amendments out), filer not
    the issuer. The subject company comes from the SEC header.
  - 4.02: 8-K (not 8-K/A) whose EDGAR items include 4.02, found with efts
    full-text search per year for "Item 4.02" and "non-reliance" (union). A
    broader diagnostic query ("4.02") found no additional 4.02 8-Ks, so the
    retrieval is complete as far as efts can tell.
  - De-duplication: one event per issuer per 30 calendar days.
- **Universe** (the F7 gate at the event date): CIK maps to a ticker in SEC
  `company_tickers_exchange.json` (F7's copy of 2026-11-14); listed now on
  Nasdaq, NYSE or Cboe, or, as a survivorship extension F7 did not have, a
  ticker now on OTC or no exchange with a Form 25 / 25-NSE filed after the
  event (listed then, delisted later) and still served by Yahoo; unadjusted
  price > $5 at the last close before day 0; 20-session median dollar volume
  >= $5M; >= 120 estimation days.
- **Timing**: EDGAR acceptance from each filing's index page (all measured
  events had one; none fell back to the filing-date close). Entry = first
  regular-session open after acceptance. Most measured filings were accepted
  outside market hours (at or after 20:00 UTC or before 13:00 UTC): late
  filings 86%, 13Ds 80%, 4.02s 91%.
- **Outcomes**: primary beta x SPY over L = 20 (sum of r - beta r_SPY, beta
  from the SPY market model on sessions [-260, -11]); secondaries L = 5,
  market-model CAR (with alpha), raw minus SPY, matched-control y (F7's
  `controls.ts`: 3-5 same-date controls by SIC, size, beta; screened for their
  own earnings and own events of the same family), PRE, and L = 60.
- **Inference**: `eventStudy`, t clustered by event date (df G - 1) and two-way
  by issuer x calendar month (df min(G) - 1).

### Deviation (made before any outcome was computed)

The pre-registration said a 13D's subject is "the one CIK with a ticker" and
that the SEC header decides only when several CIKs have one. Before measuring,
a check showed that rule picks the filer when the filer is itself listed (an
asset manager such as Franklin Resources) and the true subject no longer has a
ticker. The runner therefore reads the SEC header (`-index-headers.html`) for
every 13D with a ticker-bearing CIK (7,673 headers, about 16 minutes) and uses
its SUBJECT COMPANY. This removed 432 accessions whose header subject has no
ticker today; in every other case the header agreed with the index rule. No
return had been pulled when this was changed.

## Funnel and survivorship

| step | late filing | 13D | 4.02 |
|---|---:|---:|---:|
| filings in sample | 30,259 | 14,598 accessions | 2,603 |
| self-filed / no CIK with a ticker / header subject without ticker | - | 177 / 6,392 / 432 | - |
| duplicates (30 days, same issuer) | 109 | 1,695 | 32 |
| events | 30,150 | 5,902 | 2,571 |
| issuer has no ticker today (**survivorship gap**) | 19,786 (66%) | 10 (+6,824 dropped above with no ticker) | 1,494 (58%) |
| ticker today but not exchange-listed at the event | 5,285 | 540 | 176 |
| listed now / delisted later but priced | 4,495 / 584 | 5,115 / 237 | 830 / 71 |
| no Yahoo / Yahoo does not cover day 0 | 25 / 513 | 19 / 315 | 8 / 49 |
| price <= $5 / dollar volume < $5M | 2,708 / 1,311 | 1,933 / 1,932 | 309 / 333 |
| fewer than 120 estimation days | 21 | 120 | 15 |
| **measured** | **501** (4 delisted-later) | **1,033** (13) | **187** (2) |
| with >= 3 matched controls | 471 | 941 | 166 |

The survivorship gap is large for the two risk families: two thirds of late
filings and well over half of restatements are at issuers with no ticker
today, and the delisted-later extension only added 4 and 2 measured events
(most such names were under $5 or illiquid before the event). Firms that
later failed are the ones a late filing or restatement would hurt most, so
the gap likely biases these estimates toward zero; the true effect over the
liquid population could be more negative than measured. That is a reason the
fail is not proof of no effect, but the bar is applied to what can be measured,
as it was for F7. The small delisted-later groups point the expected way at
L = 60 (late filing -63.7%, n 4; 4.02 -61.9%, n 2), which is anecdote, not
evidence.

## Results (computed 2026-11-15)

### Late filings (F6 `distress_nt`), expected negative

| group (L = 20 unless noted) | n | G | beta x SPY % | t (date) | t (2-way) | market-model CAR % (t date) | raw - SPY % (t) | y (t date) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| all | 501 | 253 | -0.80 | -0.73 | -0.60 | -1.55 (-1.34) | -0.46 (-0.38) | 0.06 (0.98) |
| all, L = 5 | 501 | 253 | -0.92 | -1.47 | -1.57 | -1.11 (-1.73) | | |
| all, L = 60 | 501 | 253 | -2.73 | -2.07 | -1.87 | | | |
| NT 10-K | 263 | 115 | -3.01 | -2.88 | -3.69 | -3.01 (-2.46) | -2.68 (-2.29) | -0.00 (-0.04) |
| NT 10-Q | 238 | 139 | +1.64 | 0.87 | 0.67 | 0.07 (0.04) | 2.00 (0.98) | 0.13 (1.39) |
| development 2015-2021 | 264 | 124 | +0.62 | 0.39 | 0.28 | | | |
| validation 2022-2023 | 102 | 54 | -3.73 | -2.70 | -2.65 | | | |
| holdout 2024-2026H1 | 135 | 75 | -1.36 | -0.58 | -0.76 | | | |
| PRE (close before -> entry open) | 501 | 253 | -1.17 | -4.03 | -4.07 | | | |

### Initial 13D stakes (F8 `activist_stake`), expected positive

| group (L = 20 unless noted) | n | G | beta x SPY % | t (date) | t (2-way) | market-model CAR % (t date) | raw - SPY % (t) | y (t date) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| all | 1,033 | 832 | -0.52 | -0.77 | -0.73 | -1.31 (-1.73) | -0.23 (-0.36) | 0.04 (0.99) |
| all, L = 5 | 1,033 | 832 | -0.24 | -0.61 | -0.65 | -0.44 (-1.07) | | |
| all, L = 60 | 1,033 | 832 | -2.12 | -2.23 | -1.77 | | | |
| SC 13D (to 2024-12) | 843 | 685 | -0.04 | -0.06 | -0.05 | | | |
| SCHEDULE 13D (from 2024-12) | 190 | 148 | -2.66 | -1.41 | -1.27 | | | |
| development 2015-2021 | 603 | 484 | +0.61 | 0.67 | 0.61 | | | |
| validation 2022-2023 | 161 | 135 | -1.27 | -1.00 | -1.17 | | | |
| holdout 2024-2026H1 | 269 | 213 | -2.62 | -1.86 | -1.71 | | | |
| PRE | 1,033 | 832 | +1.05 | 9.39 | 8.60 | | | |

### 4.02 restatements (`restatement_402`), expected negative

| group (L = 20 unless noted) | n | G | beta x SPY % | t (date) | t (2-way) | market-model CAR % (t date) | raw - SPY % (t) | y (t date) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| all | 187 | 156 | -0.28 | -0.17 | -0.10 | -2.04 (-1.11) | -0.66 (-0.38) | 0.02 (0.15) |
| all, L = 5 | 187 | 156 | -0.81 | -1.00 | -0.95 | -1.25 (-1.46) | | |
| all, L = 60 | 187 | 156 | -3.28 | -1.49 | -1.20 | | | |
| excluding SIC 6770 (blank checks) | 182 | 153 | -0.31 | -0.18 | -0.10 | | | |
| development 2015-2021 | 111 | 84 | +1.83 | 0.76 | 0.41 | | | |
| validation 2022-2023 | 32 | 31 | -6.25 | -1.73 | -1.84 | | | |
| holdout 2024-2026H1 | 44 | 41 | -1.27 | -0.48 | -0.44 | | | |
| PRE | 187 | 156 | -1.55 | -2.77 | -2.49 | | | |

Medians: late filing -0.80%, 13D -0.13%, 4.02 -1.49% (the 4.02 mean is pulled
toward zero by a few large positive outliers; the median is more negative, but
the bar is on the mean, as for F7).

## Reading the results

1. **Late filings.** Pooled, the 20-session drift is negative but small and
   noisy. The NT 10-K subgroup is negative and significant (-3.0%, two-way t
   -3.7, n 263) while NT 10-Q is not (+1.6%). That split was not
   pre-registered as the primary, so it cannot document the family now; it is
   the obvious hypothesis for an events-v2 pre-registration (NT 10-K only,
   possibly also the "significant change in results" box), tested on data it
   was not found in. Matched controls show nothing (y about 0), which suggests
   part of the NT 10-K drift is industry or size co-movement. Pre-registered
   on 2026-11-15 as a forward test, `data/preregistration/events-v2-nt10k.json`:
   NT 10-K notices accepted from that day on, logged by the Sightings run in
   the forecast ledger (`covariates.study = "events-v2-nt10k"`) and measured
   by `scripts/forward-study.ts`; NT 10-K cards stay Watch until it is
   decided (n 100 or 2027-12-31).
2. **13D stakes.** The announcement effect is real and immediate (PRE +1.05%,
   t 9.4) and then nothing: the 20-session drift is about zero and the wrong
   sign. Brav et al.'s ~7% is an announcement-window number for hand-picked
   hedge fund activism; Falcon's cards enter after the filing is public, so
   the relevant number is the drift, and it is absent. The study measures all
   third-party initial 13Ds (founders, strategic holders, passive filers
   included); the card detector keeps only Item 4 purposes Haiku labels as
   activist. That narrower set could differ, but measuring it needs the
   filing text and an LLM read for about 6,000 filings (estimated about $1-2
   at Haiku rates), which this study did not spend.
3. **Restatements.** Too few liquid events (187) and too noisy. The
   validation-period mean is large and negative (-6.3%, n 32), the
   development period positive; nothing is stable.

## Caveats

1. Survivorship (above): the two risk families lose most of their events to
   issuers with no ticker today; Yahoo has no delisting returns.
2. Yahoo is an internal stand-in (dividend-adjusted closes, opens scaled by the
   same factor, unadjusted price rebuilt from split events for the $5 gate).
   Current tickers only.
3. The 13D population is broader than the card detector's (see 2 above).
4. The 4.02 sample keeps blank-check companies as the detector does; dropping
   them changes nothing (n 182, -0.31%).
5. One event per issuer per 30 days; L = 60 windows of the same issuer can
   still overlap, which the issuer dimension of the two-way SE covers.
6. Before costs.

## What changed in the product

- The Documented rule no longer requires a positive estimate: it requires the
  estimate's sign to match the family's pre-registered `expectedSign` in
  `data/evidence-registry.json` (F7, F2, F8: +1; F6, F5, F1: -1). A family that
  later passes a pre-registered study with a reliably negative effect can be
  Documented and shows as a "Risk signal" card "Backed by research", with
  "the stock trailed the market by about X%" in its past-performance line.
- Registry entries are matched by event type, so an F6 late-filing estimate
  can never document 4.02 restatement cards (both are family F6).
- No new `ownEstimate`: late filings, 13D stakes and restatements stay Watch.

## Reproduce

```bash
cd packages/engine
node --max-old-space-size=6144 --import tsx scripts/events-study.ts            # all phases, resumable
node --max-old-space-size=6144 --import tsx scripts/events-study.ts measure    # re-measure only (~15 s)
```

Runtime on 2026-11-15: full index 48 quarters about 1 minute; efts 36 queries
about 6 minutes; 7,673 13D headers about 16 minutes; submissions for 160
issuers and Yahoo for 274 symbols about 1 minute; EDGAR acceptance for 2,122
filings about 5 minutes; measurement about 15 seconds. Set `STUDY_ROOT` to
share the F7 cache from another checkout.
