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

/** What the record says about past events of this kind on this link. */
export type RippleHistory = {
  sample: number;
  avgMovePct: number;
  /** Share of past events where the move went the implied way, 0 to 1. */
  hitRate: number;
  windowDays: number;
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
  /** Null until the backtest exists. Never shown as a number before that. */
  history: RippleHistory | null;
};

/** One Sightings card. */
export type RippleCard = {
  id: string;
  event: RippleEvent;
  hits: RippleHit[];
  sector: string;
  generatedAt: string;
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
