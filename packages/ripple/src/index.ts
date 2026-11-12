/**
 * The contract between the Ripple Engine and every surface that shows its
 * output (web app host, iPhone app). The engine writes these shapes; the
 * screens only read them. Change additively.
 *
 * Framing rule (see vault: Legal and Compliance): everything here is
 * information about what happened and what the record shows. No buy or sell
 * calls, no return promises.
 */

export type Direction = "up" | "down" | "unclear";
export type Confidence = "low" | "medium" | "high";
export type Relation = "customer" | "supplier" | "competitor" | "peer";

/** A source document a fact rests on: a filing, a press release, an article. */
export type Source = {
  title: string;
  url: string;
  publisher: string;
  publishedAt?: string;
};

/** The event that starts a ripple (v0: earnings surprises). */
export type RippleEvent = {
  id: string;
  ticker: string;
  companyName: string;
  kind: "earnings_surprise" | "guidance" | "filing" | "news";
  headline: string;
  /** ISO time the event became public. */
  occurredAt: string;
  /** One or two plain sentences on what happened, numbers included. */
  summary: string;
  source: Source;
  /**
   * Optional (added by the engine): further lines quoted from the source,
   * such as the outlook sentence of an earnings release. Each one is a quote.
   */
  facts?: string[];
  /** Optional (added by the engine): other sources the summary uses (the consensus estimate). */
  sources?: Source[];
};

/** A quote from a filing that proves the link between two companies. */
export type LinkEvidence = {
  quote: string;
  form: string;
  filedAt: string;
  url: string;
};

/**
 * What the record says about past events of this kind on this link, as
 * measured by the engine (packages/engine/src/history.ts), never estimated:
 *
 *   - Past events: the event company's own events of the same kind and the
 *     same sign as the card's event, over the 5 years before it (v0: an 8-K
 *     item 2.02 earnings release with an EPS beat for a beat, a miss for a
 *     miss; a Taiwan monthly revenue 6-K up from a year earlier for one up).
 *   - Reaction day: the first New York session that could trade on the event
 *     (EDGAR's acceptance time: before the 09:30 open or during the session,
 *     that day; after the 16:00 close, the next session).
 *   - Move: the hit company's adjusted close from the session before the
 *     reaction day to `windowDays` sessions later (the reaction day counted),
 *     in percent, minus the benchmark's move over the same closes.
 *
 * Null when fewer than 6 past events can be measured, when the hit's
 * direction is "unclear" (no implied way to test), or when the event kind
 * has no history yet. Survivorship: only companies listed today are measured.
 */
export type RippleHistory = {
  /** Past events measured, at least 6. */
  sample: number;
  /**
   * Mean market-adjusted move of the hit company over the window, percent, in
   * its actual sign: positive means it rose more than the benchmark. Not
   * flipped for a "down" hit (there a negative value is the implied way).
   */
  avgMovePct: number;
  /**
   * Share of past events where the move went the implied way, 0 to 1:
   * adjusted move above 0 for an "up" hit, below 0 for a "down" one.
   * `Math.round(hitRate * sample)` is the count.
   */
  hitRate: number;
  /** Trading days measured, the reaction day included (1 = the reaction day close to close). At most 20. */
  windowDays: number;
  /** Optional (added by the engine): what the move is measured against, e.g. "SPY". */
  benchmark?: string;
  /** Optional (added by the engine): reaction days of the first and last past event measured, YYYY-MM-DD. */
  from?: string;
  to?: string;
};

/** One company the event reaches, and how. */
export type RippleHit = {
  ticker: string;
  companyName: string;
  /** What this company is to the event company (degree 1) or to `via` (degree 2). */
  relation: Relation;
  /** 1 = direct link to the event company, 2 = through one other company. */
  degree: 1 | 2;
  /** For degree 2: the company in between. */
  via?: string;
  direction: Direction;
  confidence: Confidence;
  /** Expected window in plain words, e.g. "1 to 5 trading days". */
  window: string;
  /** Why the event reaches this company, one or two sentences. */
  mechanism: string;
  evidence: LinkEvidence[];
  /** The measured record of past events like this one, or null when there is too little of it (see RippleHistory). */
  history: RippleHistory | null;
  /**
   * Optional (added by the engine): the hit's rank score, 0 to 100, from the
   * filing link's strength, the measured record (Wilson lower bound of the
   * hit rate), the judge's confidence and the event's size. Hits on a card
   * and cards in the feed come ordered by it. Formula:
   * packages/engine/README.md, "Ranking". `confidence` is already capped by
   * the record (a coin-flip record is "low"; "high" needs a record better
   * than a coin flip).
   */
  score?: number;
  /** Optional (added by the engine): one plain sentence on what the score rests on, e.g. "A filing puts this link above 10% of revenue; went the implied way 27 of 50 times, no better than a coin flip." */
  scoreReason?: string;
  /**
   * Optional (added by the engine): the hit company's market-adjusted move
   * since the event, measured like `history` (adjusted close from the session
   * before the event's reaction day to the latest completed close, minus the
   * benchmark's move over the same closes). Null when the reaction day has
   * not closed yet, the prices could not be read, or the hit has no implied
   * way ("unclear").
   */
  sinceEvent?: RippleSinceEvent | null;
  /**
   * Optional (added by the engine): true when `sinceEvent.movePct` already
   * went more than half of the record's average move in the implied way
   * (`|movePct| > |history.avgMovePct| / 2`, same sign as the implied way).
   * False without a record, or when the record's average went the other way.
   */
  pricedIn?: boolean;
  /**
   * Optional (added by the engine): whether the hit may be listed under
   * Opportunities. True only when the Wilson lower bound of its record clears
   * the engine's "better than a coin flip" bound (the one that allows "high"
   * confidence), its confidence is not "low", it has an implied way, and it
   * is not priced in. Screens read this flag; they never re-derive it.
   */
  opportunityEligible?: boolean;
};

/** A hit's move since its event (see RippleHit.sinceEvent). */
export type RippleSinceEvent = {
  /** Market-adjusted move, percent, in its actual sign (positive: rose more than the benchmark). */
  movePct: number;
  /** The close measured from (the session before the reaction day), YYYY-MM-DD. */
  fromDate: string;
  /** The event's reaction day, YYYY-MM-DD. */
  reactionDate: string;
  /** The latest completed close measured to, YYYY-MM-DD. */
  asOf: string;
  /** What the move is measured against, e.g. "SPY". */
  benchmark: string;
  /** Half the record's average move in the implied way, percent, signed like movePct; null without a record that moved the implied way on average. */
  pricedInAtPct: number | null;
};

/** One Sightings card. */
export type RippleCard = {
  id: string;
  event: RippleEvent;
  hits: RippleHit[];
  sector: string;
  generatedAt: string;
  /**
   * Optional (added by the engine): the card's confidence, the highest
   * confidence among its hits (after the record's cap). A "low" card is a
   * weak signal: never on Today or under Opportunities, and listed last in
   * Sightings under "Weak signals". `cardConfidence` reads it, or derives it
   * the same way for older cards.
   */
  confidence?: Confidence;
  /** Optional (added by the engine): true when every hit with an implied way is priced in (see RippleHit.pricedIn). */
  pricedIn?: boolean;
};

export type SightingsFeed = {
  generatedAt: string;
  cards: RippleCard[];
  /** Optional (added by the engine): how the feed was made. */
  meta?: {
    engine: string;
    /** Who judged direction and mechanism, e.g. "claude-sonnet-5-5". */
    judge: string;
    sector: string;
    /** The window events were read from, ISO instants. */
    since: string;
    until: string;
  };
};

/**
 * The Today screen's top block. The hero metric is still open (vault:
 * Exposure Score); v0 uses Net direction (-100 to 100) until the backtest exists.
 */
export type TodaySummary = {
  date: string;
  metric: { kind: "net_direction"; value: number | null; label: string };
  /** One line: "3 events are hitting your portfolio. NVDA is the most exposed." */
  why: string;
  portfolio: RippleCard[];
  opportunities: RippleCard[];
};

// ---------------------------------------------------------------------------
// Shared reading rules. Pure, no imports: the engine, the website and the
// iPhone app all apply the same ones.

const CONFIDENCE_ORDER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** A record shorter than this is not shown (the engine already writes null below it). */
export const MIN_RECORD_SAMPLE = 6;

/** The highest confidence among hits; "low" with none. */
export function topConfidence(hits: readonly Pick<RippleHit, "confidence">[]): Confidence {
  let best: Confidence = "low";
  for (const h of hits) if ((CONFIDENCE_ORDER[h.confidence] ?? 0) > CONFIDENCE_ORDER[best]) best = h.confidence;
  return best;
}

/** The card's confidence: the engine's, else the highest among its hits. */
export function cardConfidence(card: Pick<RippleCard, "confidence" | "hits">): Confidence {
  return card.confidence && card.confidence in CONFIDENCE_ORDER ? card.confidence : topConfidence(card.hits);
}

/** A weak signal: a card whose confidence is "low" (a coin flip at best). */
export function isWeakSignal(card: Pick<RippleCard, "confidence" | "hits">): boolean {
  return cardConfidence(card) === "low";
}

/** Splits cards into the ones to list and the weak signals, each keeping its order. */
export function splitWeakSignals<T extends Pick<RippleCard, "confidence" | "hits">>(cards: readonly T[]): { strong: T[]; weak: T[] } {
  const strong: T[] = [];
  const weak: T[] = [];
  for (const c of cards) (isWeakSignal(c) ? weak : strong).push(c);
  return { strong, weak };
}

/** Whether every hit with an implied way is priced in: the engine's flag, else derived from the hits' flags. */
export function cardPricedIn(card: Pick<RippleCard, "pricedIn" | "hits">): boolean {
  if (typeof card.pricedIn === "boolean") return card.pricedIn;
  const directional = card.hits.filter((h) => h.direction !== "unclear");
  return directional.length > 0 && directional.every((h) => h.pricedIn === true);
}

/** The count behind a record: moves the implied way, of the sample. Null with no record or a sample under 6. */
export function recordCount(history: RippleHistory | null | undefined): { wins: number; sample: number } | null {
  if (!history || !Number.isFinite(history.sample) || history.sample < MIN_RECORD_SAMPLE) return null;
  return { wins: Math.round(history.hitRate * history.sample), sample: history.sample };
}

/** "5 of 6 similar events", or null when there is no record to show. */
export function recordLabel(history: RippleHistory | null | undefined): string | null {
  const r = recordCount(history);
  return r ? `${r.wins} of ${r.sample} similar events` : null;
}

/**
 * The card as Opportunities shows it: only its hits the engine marked
 * `opportunityEligible`, minus `exclude` (held tickers). Null when the card
 * is a weak signal or no hit is left.
 */
export function opportunityCard<T extends RippleCard>(card: T, exclude?: ReadonlySet<string>): T | null {
  if (isWeakSignal(card)) return null;
  const hits = card.hits.filter((h) => h.opportunityEligible === true && !exclude?.has(h.ticker.toUpperCase()));
  return hits.length ? { ...card, hits } : null;
}
