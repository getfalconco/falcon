# @falcon/engine (Ripple Engine v0)

Today's events in, filing-backed ripple cards out (`@falcon/ripple` contract).
Run: `pnpm --filter @falcon/engine run sightings -- --dry-run` (options at the
top of `src/cli/sightings.ts`). Tests: `pnpm --filter @falcon/engine test`.

Pipeline (`src/pipeline.ts`): events (`src/events.ts`), filing-graph
candidates (`src/graph.ts`), judged direction and mechanism (`src/judge.ts`),
the measured record of each hit (`src/history.ts`), then ranking
(`src/rank.ts`, below), then the contract check (`src/validate.ts`).

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
| supports | `lower > 0.5`: better than a coin flip |
| leans_other_way | `hitRate <= 0.5` and the average moved against the implied way |
| coin_flip | `sample >= 20` and `lower <= 0.5` |
| thin | anything else (too few events to tell) |

Record strength `R = clamp((lower - 0.3) / 0.4, 0, 1)`, halved when the
average moved against the implied way; `R = 0.2` with no record (about what
a 50-event coin flip earns: both say little).

**Event size S** = `(magnitudeFactor - 1) / 3`, 0 to 1: an EPS surprise
`min(|surprise %|, 30) / 30`; a monthly revenue change (no consensus to beat)
counts a third as much per point, `min(|YoY %|, 60) / 180`.

**Coverage** (`src/yahoo.ts`, `yahooCoverage`): Yahoo's
`numberOfAnalystOpinions` and market value. Low coverage: 10 analysts or
fewer; without a count, a market value under $10 billion. Unknown is not low.
A hit is **non-obvious** when it is degree 2 or low coverage.

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
score = 100 * D * (0.25 L + 0.45 R + 0.15 C + 0.15 S)
```

C is the confidence after the cap (low 1/3, medium 2/3, high 1); D is 0.5 for
an "unclear" direction (no implied way, so no record can back it), else 1.
Hits on a card are ordered by score, then degree, then ticker.

Card score (`cardScoreOf`):

```
card = (h1 + 0.5 h2 + 0.25 h3) * (1.25 if a kept hit is non-obvious) * (0.3 if the company is being acquired)
```

h1..h3 are the card's best three hit scores. Cards are ordered by score (a
tie: the later event first) and the feed keeps the best `--max`. Events to
judge are still picked before judging by `eventScore` (size times the
graph's link weights), with 2 spare events so a card that loses every hit
can be replaced.

Each hit carries `score` and `scoreReason`: one plain sentence naming the
link, the record and, for a low-coverage name, the analyst count, e.g. "A
filing puts this link above 10% of revenue; went the implied way 27 of 50
times, no better than a coin flip." The run log lists every cap and drop with
its reason (`RunResult.ranking`).
