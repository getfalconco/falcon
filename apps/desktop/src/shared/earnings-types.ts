/**
 * Earnings tab and card: the contract between the renderer and the main
 * process (`earnings:upcoming`).
 *
 * A row is one company's next scheduled report inside the window asked for.
 * Every figure on it is a provider's own (the date, the hour, the consensus,
 * the last quarter's surprise); a field the providers did not give stays
 * null, and the renderer prints nothing in its place rather than a guess.
 *
 * Pure: no fs, no DOM, no clock.
 */

import { CALENDAR_SECTORS, normalizeTicker, type CalendarSector } from "./calendar-events";

/**
 * Whose reports are listed.
 *
 *   foryou   the reader's names, then companies a filing links to them,
 *            companies in the sectors they follow, and the biggest listings
 *            (shared/earnings-foryou.ts); the default
 *   mine     the reader's positions and watchlist
 *   tracked  the names the Tracker covers
 *   all      the market-wide calendar, when it can be read
 */
export const EARNINGS_SCOPES = ["foryou", "mine", "tracked", "all"] as const;
export type EarningsScope = (typeof EARNINGS_SCOPES)[number];

export function isEarningsScope(value: unknown): value is EarningsScope {
  return typeof value === "string" && (EARNINGS_SCOPES as readonly string[]).includes(value);
}

/**
 * When in the day the report comes out, as the providers say it.
 *
 *   bmo      before the open
 *   amc      after the close
 *   dmh      during market hours
 *   unknown  no provider has said
 */
export const EARNINGS_TIMES = ["bmo", "amc", "dmh", "unknown"] as const;
export type EarningsTime = (typeof EARNINGS_TIMES)[number];

export function isEarningsTime(value: unknown): value is EarningsTime {
  return typeof value === "string" && (EARNINGS_TIMES as readonly string[]).includes(value);
}

/**
 * Whether the company has announced the date.
 *
 *   confirmed  the provider marks the date as the company's own
 *   estimated  the provider marks it as its own projection, or gives only a window
 *   unknown    the only source is a calendar that does not say either way
 */
export type EarningsDateStatus = "confirmed" | "estimated" | "unknown";

/** Why a row is in the "For you" list (shared/earnings-foryou.ts). */
export type EarningsReason = "held" | "watchlist" | "linked" | "sector" | "large";

/** The last reported quarter against its consensus, as the provider reports it. EPS only: the providers keep no revenue consensus history. */
export type EarningsSurprise = {
  /** The quarter's end date, YYYY-MM-DD, when given. */
  quarterEnd: string | null;
  epsActual: number | null;
  epsEstimate: number | null;
  /** (actual - estimate) / |estimate|, in percent, as the provider computed it. */
  surprisePct: number | null;
};

/**
 * Where a row stands against the clock.
 *
 *   upcoming  not out yet
 *   pending   past the hour it was due, the figures not yet in from the providers
 *   reported  out: the provider has the actual figures or the release on record
 */
export type EarningsPhase = "upcoming" | "pending" | "reported";

/**
 * How many estimates the consensus EPS is the mean of, and their spread.
 * `thin` marks a mean that says little: fewer than three estimates, or a
 * spread that runs from a loss to a profit. The views then print the range
 * rather than the mean.
 */
export type EarningsConsensus = {
  analysts: number | null;
  low: number | null;
  high: number | null;
  thin: boolean;
};

/** One past quarter, as the provider has it on record. */
export type EarningsQuarter = {
  /** The quarter's end date, YYYY-MM-DD. */
  periodEnd: string | null;
  /** The provider's "3Q2026" style label. */
  fiscalQuarter: string | null;
  /** When the release came out, ISO; null when not on record. */
  reportedAt: string | null;
  epsActual: number | null;
  epsEstimate: number | null;
  /** Reported revenue, in `revenueCurrency` of the row. No consensus is kept for past quarters. */
  revenueActual: number | null;
};

/** A dated rate from the reporting currency to US dollars. */
export type EarningsFx = { currency: string; rate: number; asOf: string };

/**
 * A company the reader holds or watches that a filing links to the reporting
 * company: one of the two names the other in its 10-K or 20-F. Only links a
 * filing carries (with its quote and accession number) are kept.
 */
export type EarningsLink = {
  ticker: string;
  held: boolean;
  watchlist: boolean;
  /** supplier, customer, partner, competitor, dependency: as the filing puts the named company. */
  category: string;
  tier: "critical" | "important";
  /** The ticker whose filing names the other one. */
  namedBy: string;
  /** The ticker the filing names. */
  named: string;
  form: "10-K" | "20-F" | null;
  filingDate: string | null;
  sourceUrl: string | null;
};

export type EarningsRow = {
  ticker: string;
  company: string | null;
  /** New York calendar date of the report, YYYY-MM-DD. */
  date: string;
  /** Set when the provider only knows a window: its last day. */
  windowEnd: string | null;
  time: EarningsTime;
  status: EarningsDateStatus;
  phase: EarningsPhase;
  /** The release instant on the provider's record, ISO. Only known once out: upcoming hours are buckets. */
  releasedAt: string | null;
  /** "Q3 2026" style fiscal period, when the provider names it. */
  fiscalPeriod: string | null;
  /** Consensus EPS for this report, in `epsCurrency`. For a reported row, the consensus as it stood before the release. */
  epsEstimate: number | null;
  epsActual: number | null;
  epsCurrency: string | null;
  consensus: EarningsConsensus | null;
  /** Consensus revenue for this report, in `revenueCurrency`. */
  revenueEstimate: number | null;
  revenueActual: number | null;
  revenueCurrency: string | null;
  /** The two revenue figures in US dollars at `fx`, when the currency is not USD. */
  revenueEstimateUsd: number | null;
  revenueActualUsd: number | null;
  fx: EarningsFx | null;
  /** Which provider the figures on the row come from. */
  source: "yahoo" | "finnhub";
  lastSurprise: EarningsSurprise | null;
  sector: CalendarSector | null;
  held: boolean;
  watchlist: boolean;
  tracked: boolean;
  /** The reader's names a filing links to this company, closest first, at most three. */
  readsThrough: EarningsLink[];
  /** Why the row is listed: set in the "For you" list, null elsewhere. */
  reason: EarningsReason | null;
  /** Market value in dollars, when it was looked up (the "For you" list). */
  marketCap: number | null;
};

export type EarningsRequest = {
  scope: EarningsScope;
  /** How many calendar days ahead, today included. */
  days?: number;
  held?: string[];
  watchlist?: string[];
  /** The sectors the reader follows (calendar sector names), for "For you". */
  sectors?: string[];
};

export type EarningsScopes = {
  /** The Tracker's universe could be read (now or earlier). */
  tracked: boolean;
  /** A market-wide calendar is configured. */
  all: boolean;
};

export type EarningsResult =
  | {
      ok: true;
      scope: EarningsScope;
      /** The window, both ends included: Monday of this week to the last day asked for. */
      from: string;
      to: string;
      /** New York's calendar date when the answer was built. */
      today: string;
      rows: EarningsRow[];
      /** When this answer was put together, ISO. */
      builtAt: string;
      scopes: EarningsScopes;
      /** Names whose details could not be read this time; their rows (if any) carry fewer fields. */
      unavailable: string[];
      /** Whether the market-wide calendar fed this answer: read now, an older copy, or not at all. */
      marketCalendar: "fresh" | "stale" | "missing";
      /**
       * The secondary reads that failed or ran out of time on this answer; the
       * rows stand without what they would have added. Absent from a main
       * process older than this field.
       */
      degraded?: EarningsDegradedSource[];
      /**
       * For each source in `degraded`, how many rows or names went without it
       * (a read that fails as a whole, such as the listing directory, counts
       * once). Lets the view keep quiet about one missing sector. Absent from
       * a main process older than this field.
       */
      degradedCounts?: Partial<Record<EarningsDegradedSource, number>>;
    }
  | { ok: false; error: "invalid_request" | "scope_unavailable" | "unavailable" };

/**
 * A read an answer can do without:
 *
 *   names    the listing directory (company names; the market view is not narrowed to listed stock)
 *   links    the filing graph ("reads through to", and "For you"'s linked companies)
 *   caps     market values ("For you"'s sector fits and large caps)
 *   sectors  sector labels and "For you"'s sector fits
 *   fx       revenue in US dollars for a company reporting in another currency
 *   foryou   the "For you" selection itself: only the reader's own names are listed
 */
export type EarningsDegradedSource = "names" | "links" | "caps" | "sectors" | "fx" | "foryou";

/** How a stock has moved on its reports, from its daily closes. Moves are signed fractions (0.031 is 3.1 percent). */
export type EarningsReaction = {
  /** Mean |move| over the last four reports; null with fewer than two on record. */
  usualMove: number | null;
  moves: Array<{ date: string; reactionDay: string; releasedAt: string | null; move: number }>;
  /** Mean |1-day move| over the last 60 sessions, report sessions left out. */
  normalDailyMove: number | null;
  /** The last close the figures use, YYYY-MM-DD. */
  asOf: string | null;
};

export type EarningsReactionsResult =
  | { ok: true; reactions: Record<string, EarningsReaction | null> }
  | { ok: false; error: "invalid_request" | "unavailable" };

/** The drawer's extra reads for one name. */
export type EarningsDetail = {
  ticker: string;
  quarters: EarningsQuarter[];
  revenueCurrency: string | null;
  epsCurrency: string | null;
  reaction: EarningsReaction | null;
};

export type EarningsDetailResult = { ok: true; detail: EarningsDetail } | { ok: false; error: "invalid_request" | "unavailable" };

/** Names one reactions request may carry. */
export const EARNINGS_REACTIONS_CAP = 120;

/** The tickers of a reactions request, cleaned and capped; null when it is not one. */
export function parseReactionTickers(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 500) return null;
  const seen = new Set<string>();
  for (const item of raw) {
    const t = normalizeTicker(item);
    if (t) seen.add(t);
  }
  return [...seen].slice(0, EARNINGS_REACTIONS_CAP);
}

export const EARNINGS_DEFAULT_DAYS = 28;
export const EARNINGS_MAX_DAYS = 42;
/** Held and watchlist names one request may carry. */
export const EARNINGS_NAMES_CAP = 80;

export type ParsedEarningsRequest = {
  scope: EarningsScope;
  days: number;
  held: string[];
  watchlist: string[];
  sectors: CalendarSector[];
};

function tickers(list: unknown): string[] | null {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 500) return null;
  const seen = new Set<string>();
  for (const item of list) {
    const ticker = normalizeTicker(item);
    if (ticker) seen.add(ticker);
  }
  return [...seen].slice(0, EARNINGS_NAMES_CAP);
}

/** The request cleaned and capped; null when it is not one. */
export function parseEarningsRequest(raw: unknown): ParsedEarningsRequest | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isEarningsScope(r.scope)) return null;
  let days = EARNINGS_DEFAULT_DAYS;
  if (r.days !== undefined) {
    if (typeof r.days !== "number" || !Number.isFinite(r.days)) return null;
    days = Math.min(EARNINGS_MAX_DAYS, Math.max(1, Math.round(r.days)));
  }
  const held = tickers(r.held);
  const watchlist = tickers(r.watchlist);
  if (held === null || watchlist === null) return null;
  let sectors: CalendarSector[] = [];
  if (r.sectors !== undefined) {
    if (!Array.isArray(r.sectors)) return null;
    sectors = [...new Set(r.sectors.filter((x): x is CalendarSector => typeof x === "string" && (CALENDAR_SECTORS as readonly string[]).includes(x)))];
  }
  return { scope: r.scope, days, held, watchlist, sectors };
}
