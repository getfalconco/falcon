# Detectors

Event detectors for Ripple Engine v1 (design: `docs/design/ripple-engine-v1.md`
3.1, 3.2, 5.1 S0-S1). Each turns EDGAR filings accepted in `[since, until)`
into `DetectorEvent`s (contract: `types.ts`). The pipeline calls
`detectAll(ctx)` (`index.ts`, events sorted by acceptance) and builds cards: `propagates: "own"` gives one
hit (the company itself), `"linked"` walks the graph and judges.

Dry run (prints JSON, writes nothing but the HTTP cache):

```bash
pnpm --filter @falcon/engine exec node --import tsx scripts/detect.ts --days 7 --types insider_cluster,distress_nt
pnpm --filter @falcon/engine exec node --import tsx scripts/detect.ts --days 7 --summary --budget 1
```

## Classes

| Type | Fam | Source and route (S0, code) | S1 | Universe | propagates | sign | magnitude |
|---|---|---|---|---|---|---|---|
| `insider_cluster` | F7 | Form 4 `ownershipDocument`, code P | none | all US-listed issuers | own | +1 | purchase $ / market value, % |
| `distress_nt` | F6 | NT 10-K / 10-Q / 20-F, Part III and IV(3) | none | all US-listed | own | -1 | null |
| `restatement_402` | F6 | 8-K item 4.02 | Haiku: revenue or not, periods, reason, quotes | all US-listed | own | -1 | null |
| `customer_bankruptcy` | F5 | 8-K item 1.03 | none | graph customers | linked | -1 | null |
| `contract_material` / `contract_termination` | F3 | 8-K 1.01 / 1.02 without 2.03, 3.02, 3.03 | Haiku: type, counterparty, value, term, exclusivity, quotes | all US-listed | own | +1 / -1 | value / trailing revenue, % |
| `guidance_up` / `guidance_down` | F2 / F1 | 8-K 7.01, 8.01, 2.02 with EX-99 | Haiku: closed labels, quote per label | graph customers | linked | from label | stated % change |
| `activist_stake` | F8 | initial SCHEDULE 13D XML, Item 4 | Haiku: purpose label + quote; activist labels only | all US-listed issuers | own | +1 | null (percent of class in facts) |

"US-listed" = a row in SEC `company_tickers_exchange.json` (cached a day) on
Nasdaq, NYSE, CBOE or TXSE; OTC and unknown are left out. "Graph customers"
= tickers `data/graph.json` names as someone's customer (27 today).

## Intake (`src/feed/`)

- `edgar.ts`: daily form index per weekday of the window (plus one weekday
  before `since`, for after-17:30 acceptances dated the next day), Atom
  `getcurrent` for days whose index is not out yet, SEC header parsing
  (`<ACCEPTANCE-DATETIME>` is New York wall time, converted to UTC), efts
  `search-index` for 8-K item codes in bulk (`-index-headers.html` per filing
  when efts is down). A day with no index older than two days is a holiday.
- `sec-pool.ts`: bulk archive reads with up to 8 requests in flight, starts
  spaced at 6/s, same User-Agent, retries and disk cache as `secGet`.
  `secGet` itself runs one request at a time, so its real rate is one per
  round trip (about 1/s measured), which would put a 7-day Form 4 run at 45+
  minutes. Suggested change to `src/http.ts`: space request starts rather
  than whole requests, with an in-flight cap; then `sec-pool.ts` can go.
  The two together stay under SEC's 10 requests a second.
- `form4.ts`: regex reader for the Form 4 XML schema.
- `companies.ts`: listings, submissions summary (SIC, recent forms),
  companyconcept revenue (`Revenues` or
  `RevenueFromContractWithCustomerExcludingAssessedTax`, latest fiscal year,
  first filed) and cover-page shares outstanding.
- `eightk.ts`: 8-Ks of the window with items; acceptance read only for routed
  filings; main document and EX-99 text.

## insider_cluster rules

1. Purchases: non-derivative, code P, acquired, price above $5, common-type
   security (preferred, notes, warrants, units, rights, options dropped).
2. Dropped: the filing's `aff10b5One` box ticked; a footnote naming a 10b5-1
   plan; a footnote or remark saying offering, private placement, registered
   direct, subscription or securities purchase agreement, DRIP, ESPP or IPO
   (not open-market; not in the design's rule list, added because these
   produce false clusters of offering participants).
3. Routine insiders: `RoutineLookup(ownerCik, issuerCik, "YYYY-MM")`. The
   default reads the owner's EDGAR submissions and calls them routine when a
   Form 4/5 was filed in the same calendar month in each of the 3 prior years
   (any issuer, filing month as a stand-in for trade month). Unknown (list
   cut at 1,000 filings) keeps the insider. The measurement backfill can pass
   an issuer-specific lookup from the SEC Insider Transactions Data Sets:
   `insiderClusterDetector({ routine: myLookup })`, or `routine: null` to skip.
4. Joint filers (a fund and its GP on one Form 4) count as one insider.
5. Cluster: 3+ distinct insiders with trade dates within 5 business days
   (weekends skipped, holidays not). Anchored on the filing that brought the
   third insider; later filings inside the same 5-day span join it. Fires
   when the anchor's acceptance is in the window. Earlier Form 4s of issuers
   with fewer than 3 insiders in the window are read from the issuer's own
   filing list (9 days back).
6. Single: one officer or director buying $100k+ in one filing, at a company
   with market value under $2B. Market value: Yahoo market cap
   (`yahooCoverage`), else cover-page shares outstanding x the filed price.
   Unknown market value skips the rule.
7. Title and summary: insider names as filed, roles, shares, dollars, dates.
   `quotes` are transcriptions of the filed XML values (name, role, security,
   date, code, shares, price), not prose substrings: Form 4 has no prose.

## LLM (S1)

`llm.ts`: `claude-haiku-5-5` (4 filings at once per detector), `thinking: {type: "disabled"}`, effort low,
`output_config.format` JSON schema, no citations. The system prompt says the
filing is untrusted data. Spend is measured from `usage` at $0.10 / $0.50 per
M tokens and capped by `ctx.llmBudgetUsd` for the whole process; when spent
(or without `ANTHROPIC_API_KEY`) calls return null (with 4 calls in flight
the cap can be passed by at most the calls already started, under a cent), the detector counts the
backlog in its log line and moves on (4.02 events still go out, at Watch).

Checks on every answer: each quote must be in the filing word for word
(`quoteInDocument`); facts that carry numbers must hold only numbers the
filing has (`inventedNumbers`); a contract value must sit inside its quote.
A fact that fails is dropped, never repaired.

## Contracts

- Route: 1.01 or 1.02, none of 2.03 / 3.02 / 3.03. Haiku's type decides
  "commercial" (supply, customer sales, license, collaboration, distribution,
  services, government); loans without 2.03, M&A, one-off asset sales
  (vouchers, royalties, property), leases, employment and settlements are
  dropped after the call (about two thirds of the routed filings in a week).
- `contract_termination` when the items are 1.02 alone, or 1.01 + 1.02 and
  the model says the main agreement is ending.
- Title value: only the dollar expression of the filed value text
  ("approximately $121.9 million"); magnitude = value / trailing annual
  revenue in %.
- Watch-only reasons: going-concern language in the 8-K or EX-99, an S-1,
  S-3 or 424B5 in the last 30 days, SIC 6770, a counterparty that is not a
  listed SEC filer (loose name match on `company_tickers_exchange`) unless it
  is a government, no verbatim quote, no named counterparty.
- `propagates: "own"` with the filer as the hit; `facts.counterpartyTicker`,
  `facts.smallerParty` ("filer" / "counterparty" by trailing revenue) let the
  pipeline add the F4 share-shift links later.

## Known gaps

- `dei:EntityShellCompany` is a boolean cover fact that companyconcept does
  not serve; shells are caught by SIC 6770 and a cover-text check only.
- Routine insiders are judged by filing month across all issuers, not by
  trade month at this issuer.
- Holidays count as business days in the 5-day cluster span.
- No price or volume floor for NT, 4.02 and contract events (the pipeline's
  S2 step applies it to hits).
- Single-purchase events are per filing: two officers buying the same week at
  one company give two events (not a cluster of 3).
- `activist_stake` reads only XML 13Ds (all since 2024-12); amendments
  (13D/A) are not read.
- Company names are title-cased from EDGAR's all-caps names ("Aaon, Inc.").
