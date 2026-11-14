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
/**
 * What a hit company is to the event company. "self" (v1): the event is
 * about the hit company itself (an insider purchase cluster, a late filing);
 * the card's single hit is the company itself. Screens must render an
 * unknown relation with a neutral fallback label.
 */
export type Relation = "customer" | "supplier" | "competitor" | "peer" | "self";

/**
 * Card and hit tiers (design ripple-engine-v1, 7.1), written by the engine;
 * screens read them and never re-derive them.
 *   measured:   the hit's family passed Falcon's own statistical test.
 *   documented: published research documents this trigger and Falcon's own
 *               post-2015 estimate is positive; Falcon's live record is building.
 *   watch:      everything else; shown collapsed, never in main sections.
 */
export type Tier = "measured" | "documented" | "watch";

/** How directly the filings tie the hit to the event (the judge's read; display only, gates nothing). */
export type LinkClarity = "direct" | "inferred" | "weak";

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
  /**
   * Optional (v1): the event type, the key of the engine's event registry,
   * e.g. "insider_cluster", "earnings_read_through", "monthly_revenue".
   * `kind` stays the coarse bucket. Screens show `eventLabel`, never this key.
   */
  eventType?: string;
  /** Optional (v1): a plain label for the event type, e.g. "Insider purchase cluster". */
  eventLabel?: string;
  /** Optional (v1): EDGAR acceptance time (ISO), when the event is a filing. */
  acceptedAt?: string;
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
  /**
   * Optional (v1): the past events behind the record, oldest first, so
   * "Backtest this" can show the same numbers. `movePct` is the hit
   * company's own move over the window, `benchmarkPct` the benchmark's over
   * the same closes (the record's adjusted move is their difference), both
   * percent. `eventDate` is the past event's New York date, `reactionDate`
   * its first tradable session.
   */
  events?: Array<{ accession: string; eventDate: string; reactionDate: string; movePct: number; benchmarkPct: number }>;
};

/** Published research behind a Documented hit (design 7.1; the engine's evidence registry). */
export type DocumentedBy = {
  citation: string;
  url: string;
  /** The effect as the paper states it, e.g. "opportunistic insider purchases earned about 82 bp/month value-weighted". */
  effect: string;
  /** The paper's sample period, e.g. "1986-2007". */
  period: string;
  /** "exact": the paper studies this trigger; "analogous": a related one. */
  match: "exact" | "analogous";
};

/** How much attention the hit company gets (display only). */
export type Attention = { analysts: number | null; sameSic: boolean | null; daysToEarnings: number | null };

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
   * Opportunities. v1: true only for a Measured hit, or (interim rule,
   * OPPORTUNITIES_INTERIM_DOCUMENTED) a Documented own-firm hit with exact
   * evidence; never for an unclear or priced-in hit. v0 cards (no tier): the
   * record's Wilson lower bound cleared the "better than a coin flip" bound.
   * Screens read this flag through `opportunityHit`; they never re-derive it.
   */
  opportunityEligible?: boolean;
  /**
   * Optional (added by the engine): how many analysts give an opinion on the
   * hit company (Yahoo's numberOfAnalystOpinions at the run), null when
   * unknown. Fewer analysts raise the hit's score (README, "Coverage").
   */
  analysts?: number | null;
  /**
   * Optional (added by the engine): how the judge's votes on this hit split
   * (several calls with the same prompt, README "Judge votes"); `excluded`
   * counts votes that left the company out. Direction and confidence are
   * the vote's result.
   */
  votes?: { up: number; down: number; unclear: number; excluded: number };
  /** Optional (v1): the hit's tier (see Tier). Older cards have none. */
  tier?: Tier;
  /** Optional (v1): the pre-registered family, e.g. "F7". */
  family?: string;
  /** Optional (v1): the deterministic channel, e.g. "own_firm" or "supply_chain". */
  channel?: string;
  /** Optional (v1): how directly the filings tie this hit to the event (display only). */
  linkClarity?: LinkClarity;
  /** Optional (v1): attention on the hit company (display only). */
  attention?: Attention;
  /** Optional (v1): the published research behind a Documented hit. */
  documentedBy?: DocumentedBy;
  /** Optional (v1): what would invalidate the reading, one templated sentence. */
  invalidatedBy?: string;
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
   * confidence among its hits with an implied way (up or down; after the
   * record's cap). An "unclear" hit has no implied way, so no record can
   * back it, and it does not lift a card. "low" with no such hit. A "low"
   * card is a weak signal: never on Today or under Opportunities, and listed
   * last in Sightings under "Weak signals". `cardConfidence` reads it, or
   * derives it the same way for older cards.
   */
  confidence?: Confidence;
  /** Optional (added by the engine): true when every hit with an implied way is priced in (see RippleHit.pricedIn). */
  pricedIn?: boolean;
  /** Optional (v1): the card's tier, the best of its hits' tiers. */
  tier?: Tier;
  /**
   * Optional (v1): when the card stops being served (ISO): publish time plus
   * its longest hit window (trading sessions counted as calendar days x1.5).
   * Cards without it are served for 7 days after their event.
   */
  expiresAt?: string;
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

/** A card's confidence from its hits: the highest among those with an implied way; "low" with none. */
export function cardConfidenceOf(hits: readonly Pick<RippleHit, "confidence" | "direction">[]): Confidence {
  return topConfidence(hits.filter((h) => h.direction !== "unclear"));
}

/** The card's confidence: the engine's, else derived from its hits (cardConfidenceOf). */
export function cardConfidence(card: Pick<RippleCard, "confidence" | "hits">): Confidence {
  return card.confidence && card.confidence in CONFIDENCE_ORDER ? card.confidence : cardConfidenceOf(card.hits);
}

// ---------------------------------------------------------------------------
// Tiers (v1). Older cards carry no tier; every helper falls back to the v0 rules.

export const TIERS: readonly Tier[] = ["measured", "documented", "watch"];
const TIER_RANK: Record<Tier, number> = { watch: 0, documented: 1, measured: 2 };

function validTier(t: unknown): t is Tier {
  return typeof t === "string" && t in TIER_RANK;
}

/** The best tier among hits that carry one; null when none does (an older card). */
export function bestTier(hits: readonly Pick<RippleHit, "tier">[]): Tier | null {
  let best: Tier | null = null;
  for (const h of hits) if (validTier(h.tier) && (best === null || TIER_RANK[h.tier] > TIER_RANK[best])) best = h.tier;
  return best;
}

/** The card's tier: the engine's, else the best of its hits'; null for an older card without tiers. */
export function cardTier(card: Pick<RippleCard, "tier" | "hits">): Tier | null {
  return validTier(card.tier) ? card.tier : bestTier(card.hits);
}

/** Whether a hit or a card is Measured (its family passed Falcon's own test). */
export function isMeasured(x: { tier?: Tier }): boolean {
  return x.tier === "measured";
}

/** Whether a hit or a card is Documented (published research, Falcon's own record building). */
export function isDocumented(x: { tier?: Tier }): boolean {
  return x.tier === "documented";
}

/** A card shown as "Context" on Today: Documented, never in the hero metric. */
export function isContext(card: Pick<RippleCard, "tier" | "hits">): boolean {
  return cardTier(card) === "documented";
}

/** The label a Documented card or hit carries. */
export const DOCUMENTED_LABEL = "Documented in published research; Falcon's own record is building.";

/** Short tier badge text. */
export const TIER_LABEL: Record<Tier, string> = { measured: "Measured", documented: "Documented", watch: "Watch" };

/** The badge for a tier, "" for none or an unknown value. */
export function tierLabel(tier: unknown): string {
  return validTier(tier) ? TIER_LABEL[tier] : "";
}

/** The empty state of a main section when no card clears the publishing bar. */
export const NOTHING_CLEARED = "Nothing cleared the bar today";

/** Plain labels for the engine's event types; screens prefer `event.eventLabel`. */
export const EVENT_TYPE_LABEL: Record<string, string> = {
  earnings_read_through: "Earnings read-through",
  monthly_revenue: "Monthly revenue",
  insider_cluster: "Insider purchase cluster",
  distress_nt: "Late filing notice",
  restatement_402: "Restatement notice",
  customer_bankruptcy: "Customer bankruptcy",
  contract_material: "Material contract",
  contract_termination: "Contract termination",
  guidance_down: "Outlook cut",
  guidance_up: "Outlook raise",
  activist_stake: "Activist stake",
};

/** The event's label: the engine's, else the type's, else null (screens then use their kind label or "Event"). */
export function eventTypeLabel(event: Pick<RippleEvent, "eventType" | "eventLabel">): string | null {
  if (typeof event.eventLabel === "string" && event.eventLabel.trim()) return event.eventLabel;
  if (typeof event.eventType === "string" && EVENT_TYPE_LABEL[event.eventType]) return EVENT_TYPE_LABEL[event.eventType]!;
  return null;
}

/**
 * A weak signal: listed last, under a collapsed "Watch list", never on Today
 * or under Opportunities. A card with a tier is weak when it is "watch"; an
 * older card without one when its confidence is "low" (v0 rule).
 */
export function isWeakSignal(card: Pick<RippleCard, "confidence" | "hits"> & { tier?: Tier }): boolean {
  const tier = cardTier({ tier: card.tier, hits: card.hits });
  if (tier !== null) return tier === "watch";
  return cardConfidence(card) === "low";
}

/** Whether any card clears the publishing bar (is not a weak signal). False means "Nothing cleared the bar today". */
export function anyClearsBar(cards: readonly (Pick<RippleCard, "confidence" | "hits"> & { tier?: Tier })[]): boolean {
  return cards.some((c) => !isWeakSignal(c));
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
 * Default of the founder's interim rule (design 7.3): while no hit is
 * Measured, Opportunities shows Documented own-firm hits whose evidence is
 * an `exact` match, labelled DOCUMENTED_LABEL. The engine and the website
 * read the flag OPPORTUNITIES_INTERIM_DOCUMENTED ("0"/"false" turns it off).
 */
export const OPPORTUNITIES_INTERIM_DOCUMENTED = true;

/** A hit the interim rule may list: Documented, own-firm ("self"), exact evidence. */
export function interimDocumentedHit(h: Pick<RippleHit, "tier" | "relation" | "documentedBy">): boolean {
  return h.tier === "documented" && h.relation === "self" && h.documentedBy?.match === "exact";
}

export type OpportunityOptions = {
  /** Whether Documented own-firm hits may be listed (the interim rule; default OPPORTUNITIES_INTERIM_DOCUMENTED). */
  interimDocumented?: boolean;
};

/**
 * Whether a hit may be listed under Opportunities. It must carry the engine's
 * `opportunityEligible` flag; a hit with a tier must also be Measured, or a
 * Documented own-firm exact hit while the interim rule allows it. Older hits
 * without a tier: the flag alone (v0 rule).
 */
export function opportunityHit(h: RippleHit, opts: OpportunityOptions = {}): boolean {
  if (h.opportunityEligible !== true) return false;
  if (!validTier(h.tier)) return true;
  if (h.tier === "measured") return true;
  return (opts.interimDocumented ?? OPPORTUNITIES_INTERIM_DOCUMENTED) && interimDocumentedHit(h);
}

/**
 * The card as Opportunities shows it: only its hits that pass
 * `opportunityHit`, minus `exclude` (held tickers). Null when the card is a
 * weak signal or no hit is left.
 */
export function opportunityCard<T extends RippleCard>(card: T, exclude?: ReadonlySet<string>, opts: OpportunityOptions = {}): T | null {
  if (isWeakSignal(card)) return null;
  const hits = card.hits.filter((h) => opportunityHit(h, opts) && !exclude?.has(h.ticker.toUpperCase()));
  return hits.length ? { ...card, hits } : null;
}

/**
 * Opportunities for a whole feed: the interim rule applies only while no
 * hit on any card is Measured; once one is, only Measured hits are listed.
 */
export function opportunityCards<T extends RippleCard>(cards: readonly T[], exclude?: ReadonlySet<string>, opts: OpportunityOptions = {}): T[] {
  const anyMeasured = cards.some((c) => c.hits.some((h) => h.tier === "measured"));
  const interimDocumented = (opts.interimDocumented ?? OPPORTUNITIES_INTERIM_DOCUMENTED) && !anyMeasured;
  return cards.map((c) => opportunityCard(c, exclude, { interimDocumented })).filter((c): c is T => c !== null);
}

/**
 * When a card stops being served: `expiresAt`, else 7 days after its event
 * (the v0 rule). Epoch milliseconds; NaN when neither can be read.
 */
export const LEGACY_SERVE_DAYS = 7;
export function cardExpiryMs(card: Pick<RippleCard, "expiresAt" | "event">): number {
  const at = typeof card.expiresAt === "string" ? Date.parse(card.expiresAt) : NaN;
  if (Number.isFinite(at)) return at;
  return Date.parse(card.event.occurredAt) + LEGACY_SERVE_DAYS * 86_400_000;
}

/** Whether a card is still served at `nowMs`. */
export function cardLive(card: Pick<RippleCard, "expiresAt" | "event">, nowMs: number = Date.now()): boolean {
  return cardExpiryMs(card) > nowMs;
}

/** The analyst count the engine recorded for a ticker on any of these cards' hits, or null. */
export function analystsFor(cards: readonly Pick<RippleCard, "hits">[], ticker: string): number | null {
  const t = ticker.toUpperCase();
  for (const c of cards) for (const h of c.hits) if (h.ticker.toUpperCase() === t && typeof h.analysts === "number") return h.analysts;
  return null;
}

/** "1 analyst", "8 analysts". */
export function analystsLabel(n: number): string {
  return `${n} analyst${n === 1 ? "" : "s"}`;
}
