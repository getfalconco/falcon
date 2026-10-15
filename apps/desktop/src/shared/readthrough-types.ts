/**
 * Read-through radar: the contract between the renderer and the main process
 * (`readthrough:radar`).
 *
 * A row is one pair: a company a filing links to one of the reader's names
 * (the counterparty, C) and that name (the holding, H). The figures are
 * measured, never guessed: on each of C's past report days, how H closed
 * against the session before, and how much of that was beyond the market.
 * main/readthrough/event-study.ts has the formulas; nothing here is a model's
 * text. A field no source gave stays null and the views print nothing in its
 * place.
 *
 * Pure: no fs, no DOM, no clock.
 */

import { normalizeTicker } from "./calendar-events";
import type { EarningsDateStatus, EarningsTime } from "./earnings-types";

/** What C is to H, as the filing puts it (inverted when it is C's own filing that names H). */
export const READTHROUGH_RELATIONS = ["supplier", "customer", "competitor"] as const;
export type ReadthroughRelation = (typeof READTHROUGH_RELATIONS)[number];

/** The benchmark abnormal moves are taken against. */
export const READTHROUGH_BENCHMARK = "SPY";

/** Fewer measured reports than this and no figure is shown, only the count. */
export const READTHROUGH_MIN_EVENTS = 3;
/** The most recent reports a figure is taken over. */
export const READTHROUGH_MAX_EVENTS = 8;
/** An upcoming report is listed this many calendar days ahead, today included. */
export const READTHROUGH_AHEAD_DAYS = 28;
/** A report is "recent" this many calendar days back. */
export const READTHROUGH_BACK_DAYS = 7;

/** One of C's past reports, measured on H. Moves are signed fractions (0.021 is 2.1 percent). */
export type ReadthroughEvent = {
  /** C's report date, New York. */
  date: string;
  /** The session that first traded it (after the close reads the next session). */
  reactionDay: string;
  /** C's close on that session against the close before. */
  counterpartyMove: number;
  /** The same, less C's beta times the benchmark's move. */
  counterpartyAbnormal: number;
  holdingMove: number;
  /** H's move less H's beta times the benchmark's move. */
  holdingAbnormal: number;
  /** H's abnormal move on the session after; null when that session has not closed. */
  holdingNextAbnormal: number | null;
  /** The benchmark's move on the session. */
  marketMove: number;
  /** C's EPS surprise for that report, in percent, when the provider keeps the quarter. */
  surprisePct: number | null;
  /** H's abnormal move had C's abnormal move's sign; null when either was exactly flat. */
  withIt: boolean | null;
};

export type ReadthroughStats = {
  /** Reports measured (the sample size, always shown). */
  events: number;
  /** Of those, how many H's abnormal move had the sign of C's. */
  withIt: number;
  /** Mean |H move| on the reaction sessions. */
  avgAbsMove: number;
  /** Mean |H abnormal move| on the reaction sessions. */
  avgAbsAbnormal: number;
  /** Mean of H's abnormal move signed by C's: above zero, H tends to go C's way. */
  avgFollow: number;
  /** The same on the session after, over `nextEvents` reports. */
  avgNextFollow: number | null;
  nextEvents: number;
  /** Mean |H abnormal move| on other sessions (the last 120, report sessions left out). */
  normalAbsAbnormal: number | null;
  /** avgAbsAbnormal / normalAbsAbnormal: how many ordinary days' worth H moves on C's report day. */
  sensitivity: number | null;
  /** Reports with C's EPS surprise on record, and how many of those H's abnormal move followed. */
  surpriseEvents: number;
  withSurprise: number;
  /** H's beta to the benchmark over the last 250 sessions, report sessions left out; 1 when too few. */
  beta: number;
  betaFallback: boolean;
  /** The first and last reaction session in the sample. */
  from: string;
  to: string;
};

/** What C reported, for a report in the last week. */
export type ReadthroughReport = {
  epsActual: number | null;
  epsEstimate: number | null;
  surprisePct: number | null;
  /** The session that first traded the report; null when unknown. */
  reactionDay: string | null;
  /** C's move on that session, once closed. */
  counterpartyMove: number | null;
  /** H's move on that session, once closed. */
  holdingOnDay: number | null;
  /** H's last close against its close before the reaction session. */
  holdingSince: number | null;
  /** The close `holdingSince` runs to, YYYY-MM-DD. */
  sinceTo: string | null;
};

/**
 *   upcoming  C reports within the next four weeks
 *   recent    C reported in the last seven days
 *   later     neither (a focused request lists every link)
 */
export type ReadthroughKind = "upcoming" | "recent" | "later";

export type ReadthroughRow = {
  /** "TSM>NVDA". */
  id: string;
  counterparty: string;
  counterpartyName: string | null;
  holding: string;
  held: boolean;
  watchlist: boolean;
  relation: ReadthroughRelation;
  tier: "critical" | "important";
  /** The ticker whose filing names the other. */
  namedBy: string;
  form: "10-K" | "20-F" | null;
  filingDate: string | null;
  /** The filing on SEC.gov. */
  sourceUrl: string | null;
  kind: ReadthroughKind;
  /** C's report date (next or last); null when none is known. */
  date: string | null;
  time: EarningsTime;
  status: EarningsDateStatus | null;
  report: ReadthroughReport | null;
  /** Reports measured, also when fewer than the minimum. */
  sample: number;
  /** Null below READTHROUGH_MIN_EVENTS. */
  stats: ReadthroughStats | null;
  /** The measured reports, newest first. */
  events: ReadthroughEvent[];
  /** Held: 0.5 plus the position's share of the held value; watchlist only: 0.25. */
  weight: number;
  /** sensitivity x weight; 0 when not measured. */
  score: number;
};

export type ReadthroughDegraded = "links" | "dates" | "prices" | "filings";

export type ReadthroughResult =
  | {
      ok: true;
      /** New York's calendar date when the answer was built. */
      today: string;
      builtAt: string;
      rows: ReadthroughRow[];
      /** Filing links between the reader's names and companies with a known ticker. */
      links: number;
      /** Set when the links were more than one answer measures; the closest were kept. */
      truncated: boolean;
      /** The reads that failed this time; the rows stand without them. */
      degraded: ReadthroughDegraded[];
    }
  | { ok: false; error: "invalid_request" | "unavailable" };

export type ReadthroughHolding = { ticker: string; shares?: number };

export type ReadthroughRequest = {
  /** Positions: a ticker, or a ticker with its share count (for the account weight). */
  held?: Array<string | ReadthroughHolding>;
  watchlist?: string[];
  /** One name only (the Stock tab): every filing link of it, measured, whatever the report dates. */
  focus?: string;
};

export type ParsedReadthroughRequest = {
  held: Array<{ ticker: string; shares: number | null }>;
  watchlist: string[];
  focus: string | null;
};

/** Names one request may carry. */
export const READTHROUGH_NAMES_CAP = 80;

/** The request cleaned and capped; null when it is not one. */
export function parseReadthroughRequest(raw: unknown): ParsedReadthroughRequest | null {
  if (raw === undefined || raw === null) return { held: [], watchlist: [], focus: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const held = new Map<string, number | null>();
  if (r.held !== undefined) {
    if (!Array.isArray(r.held) || r.held.length > 500) return null;
    for (const item of r.held) {
      if (typeof item === "string") {
        const t = normalizeTicker(item);
        if (t && !held.has(t)) held.set(t, null);
      } else if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const t = normalizeTicker(o.ticker);
        const shares = typeof o.shares === "number" && Number.isFinite(o.shares) ? Math.abs(o.shares) : null;
        if (t) held.set(t, shares);
      }
    }
  }
  const watch = new Set<string>();
  if (r.watchlist !== undefined) {
    if (!Array.isArray(r.watchlist) || r.watchlist.length > 500) return null;
    for (const item of r.watchlist) {
      const t = normalizeTicker(item);
      if (t) watch.add(t);
    }
  }
  let focus: string | null = null;
  if (r.focus !== undefined && r.focus !== null) {
    focus = normalizeTicker(r.focus);
    if (!focus) return null;
  }
  return {
    held: [...held.entries()].slice(0, READTHROUGH_NAMES_CAP).map(([ticker, shares]) => ({ ticker, shares })),
    watchlist: [...watch].slice(0, READTHROUGH_NAMES_CAP),
    focus,
  };
}
