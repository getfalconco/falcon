# @falcon/engine (Ripple Engine v0)

Today's events in, filing-backed ripple cards out (`@falcon/ripple` contract).
Run: `pnpm --filter @falcon/engine run sightings -- --dry-run` (options at the
top of `src/cli/sightings.ts`). Tests: `pnpm --filter @falcon/engine test`.

Pipeline (`src/pipeline.ts`): events (`src/events.ts`), filing-graph
candidates (`src/graph.ts`), judged direction and mechanism (`src/judge.ts`,
put to a vote by `src/vote.ts`), the measured record of each hit
(`src/history.ts`), then ranking (`src/rank.ts`, below), then the contract
check (`src/validate.ts`).

## Judge votes

The judge (claude-sonnet-5-5) is sampled, so one call can flip a hit's
direction from run to run. Each event is judged by several calls with the
same prompt and schema, counted per candidate (`src/vote.ts`):

1. Three calls at once. Each call's answer for a candidate is one vote and
   must pass the usual checks (`checkAnswer`: closed answer sets, framing, no
   number the event or the quotes do not hold). A vote that fails, is
   missing, or whose call failed is discarded and replaced once by a retry
   call; a retried vote that fails again is dropped.
2. A candidate is kept when more than half of its valid votes include it.
3. Direction: the value at least 2 of the first three agree on. When all
   three differ, two more calls (five votes), then "unclear" only when it is
   itself a majority (3 of 5) or when up and down tie exactly; otherwise the
   larger of up and down. Disagreement alone never makes a hit unclear.
4. Confidence: the most common confidence among the votes for the winning
   direction (a tie: the lower). Mechanism and window: the first of those
   votes (in call order) with that confidence.

Each hit carries its split as `votes: { up, down, unclear, excluded }`; the
run log lists every candidate's split and which needed a second round.
A judge reading answers from a file is asked once (same answers each time).

**Cost guard**: at most `--max-judge-calls` (default 40) calls per run;
when spent, the remaining events go to the vote with what they have, and an
event with no call left gets no card. The prompt is cached
(`cache_control`), so the 2nd to 5th call on an event read it at a tenth of
the price. Expected cost per run (5 events, 15 to 25 calls): about $0.15 to $0.30
(measured 2026-11-12: 16 and 18 calls, $0.16 and $0.21, at $2 / $10 per million
tokens in / out, $0.10 cache read; runs with many discarded votes, before the
number check counted form names, took 19 to 21 calls and $0.26 to $0.30); the
40-call cap bounds a run at about $0.60.
The CLI prints the run's tokens and cost in its summary.

## Ranking

Every judged event gets its hits' history measured first; the record then
caps, filters and orders the hits, and orders the cards. Why: many links fail
and the edge is in the average, so a high rating has to be earned by the
record; the effect is stronger where few analysts look, and Falcon's value is
in non-obvious links (vault: Ripple Engine, Evidence).

### Inputs

**Link strength L**, from the filing quotes on the hit's path:

| Tier | When | L |
| --- | --- | --- |
| disclosed | the quote states a share (`disclosedSharePct`), a sole, single or exclusive source, or a customer above 10% of revenue | 1.0 |
| named | a named supplier, customer, partner or principal competitor, no share | 0.6 |
| list | one name in a list (the extraction's `marginal` tier) | 0.25 |

Degree 1 takes the strongest quote between the two companies; degree 2 the
weaker of its two links.

**Record.** `wins = round(hitRate * sample)`; `lower` = Wilson score lower
bound at 95% (z = 1.96) of `wins` of `sample`. The verdict, checked in order:

| Verdict | When |
| --- | --- |
| none | no history (under 6 events, an unclear hit, a kind with no history) |
| supports | `lower > 0.5` (`SUPPORTS_LOWER_BOUND`): better than a coin flip |
| leans_other_way | `hitRate <= 0.5` and the average moved against the implied way |
| coin_flip | `sample >= 20` and `lower <= 0.5` |
| thin | anything else (too few events to tell) |

Record strength `R = clamp((lower - 0.3) / 0.4, 0, 1)`, halved when the
average moved against the implied way; `R = 0.2` with no record (about what
a 50-event coin flip earns: both say little).

**Event size S** = `(magnitudeFactor - 1) / 3`, 0 to 1: an EPS surprise
`min(|surprise %|, 30) / 30`; a monthly revenue change (no consensus to beat)
counts a third as much per point, `min(|YoY %|, 60) / 180`.

**Coverage** (`src/yahoo.ts`, `yahooCoverage`; `coverageBoost` in
`src/rank.ts`): the analyst count `a` is Yahoo quoteSummary
`financialData.numberOfAnalystOpinions`, read through the same cookie and
crumb session as the EPS figures, at most one request per 400 ms, and kept
on disk for 3 days (`.cache/coverage`; a copy up to 30 days old is used
when Yahoo cannot be read). Without a count, a market value under $10
billion counts as `a = 10`; with neither, no boost (unknown is not low).

```
B = 1 + 0.25 * clamp((20 - a) / (20 - 3), 0, 1)
```

So 3 or fewer analysts x1.25, 8 x1.18, 10 x1.15, 12 x1.12, 20 or more x1.
Why: the effect is strongest where few analysts look (vault: Ripple Engine,
Evidence); the tested semis split at about 20 (large caps 20 to 56, small and
mid-cap equipment names 8 to 12). Each hit carries its count as `analysts`.
A hit is **non-obvious** when it is degree 2 (coverage now raises the hit's
own score, so it no longer lifts the whole card).

Terms: Yahoo's terms forbid automated and commercial use of its data, so
this source is a stand-in for the build-up. Switch to a licensed source
(Finnhub or Financial Modeling Prep, paid) before the first paying user;
only `yahooCoverage` changes.

### Confidence

The judge's confidence is an input; the record is a ceiling. It never raises
the judge's call.

| Verdict | Ceiling |
| --- | --- |
| supports | high |
| none, thin | medium |
| coin_flip, leans_other_way | low |

`confidence = min(judged, ceiling)`. So a coin-flip record (lower bound at or
under 0.5 with 20 or more events) is always "low", and "high" needs a record
better than a coin flip. (The judge already may not say "high" for degree 2
or competitor links.)

### Filtering

- A hit is dropped when its link is a **list mention only** and its record
  **does not beat a coin flip** (verdict coin_flip, leans_other_way or thin,
  i.e. `lower <= 0.5` at any sample). A list mention with no record is kept.
- A card keeps its 5 best hits by score; a card with no hit left is dropped.

### Scores

Hit score, 0 to 100 (`hitScore`):

```
score = min(100, 100 * D * B * (0.25 L + 0.45 R + 0.15 C + 0.15 S))
```

C is the confidence after the cap (low 1/3, medium 2/3, high 1); D is 0.5 for
an "unclear" direction (no implied way, so no record can back it), else 1;
B the coverage boost above.
Hits on a card are ordered by score, then degree, then ticker.

Card score (`cardScoreOf`):

```
card = (h1 + 0.5 h2 + 0.25 h3) * (1.25 if a kept hit is degree 2) * (0.3 if the company is being acquired)
```

h1..h3 are the card's best three hit scores. Cards are ordered by score (a
tie: the later event first) and the feed keeps the best `--max`. Events to
judge are still picked before judging by `eventScore` (size times the
graph's link weights), with 2 spare events so a card that loses every hit
can be replaced.

Each hit carries `score` and `scoreReason`: one plain sentence naming the
link, the record and, for a name with a coverage boost, the analyst count, e.g. "A
filing puts this link above 10% of revenue; went the implied way 27 of 50
times, no better than a coin flip." The run log lists every cap and drop with
its reason (`RunResult.ranking`).

## What reaches the user

Rules every surface applies (`/api/sightings`, the web Workspace, the iPhone
app). The engine writes the flags; the screens read them through the pure
helpers in `@falcon/ripple` (`cardConfidence`, `isWeakSignal`,
`splitWeakSignals`, `recordLabel`, `cardPricedIn`, `opportunityCard`) and
never re-derive them. Tests: `test/trust.test.ts`.

### Card confidence and weak signals

`card.confidence` is the **highest confidence among the card's kept hits
with an implied way** (up or down, after the record's cap). An "unclear"
hit has no implied way, so no record can back it, and it does not lift a
card; a card with no directional hit is "low". A card is a **weak signal**
when its confidence is "low", i.e. every directional hit on it is low (a
coin-flip or contrary record, or the judge's own low call). Weak signals are never on
Today or under Opportunities; in Sightings they are listed last, under a
collapsed "Weak signals" section. Older cards without the field get the same
value from their hits.

### The record as a count

Every hit's record reads "5 of 6 similar events": `round(hitRate * sample)`
moves the implied way, of `sample`. Under 6 events (`MIN_RECORD_SAMPLE`,
same as `HISTORY_MIN_SAMPLE`) the history is null and no record is shown.

### Priced in

For each directional hit, `src/history.ts` measures the market-adjusted move
since the event the same way as the record: the adjusted close of the
session before the event's reaction day to the latest completed close,
minus SPY over the same closes (`hit.sinceEvent`: `movePct`, `fromDate`,
`reactionDate`, `asOf`, `benchmark`). With a record whose average went the
implied way:

```
pricedIn = sign * movePct > 0.5 * sign * history.avgMovePct     (sign: +1 up, -1 down)
```

`sinceEvent.pricedInAtPct` is that half-average threshold (signed). No
record, an average against the implied way, an unclear hit, or a reaction
day that has not closed yet: not priced in. `card.pricedIn` is true when
every hit with an implied way is priced in. A priced-in hit stays on its
card with a "Priced in" label and is never under Opportunities.

### Opportunities

`hit.opportunityEligible` (`opportunityEligible` in `src/rank.ts`) is true
only when the record's Wilson lower bound is above `SUPPORTS_LOWER_BOUND`
(the same bar that allows "high" confidence), the capped confidence is not
"low", the hit has an implied way, and it is not priced in. Opportunities
list the cards that do not touch the portfolio, each with only its eligible
hits (held tickers removed); a card left with none, or a weak signal, is
not listed.
