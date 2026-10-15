/**
 * Options-implied report move against the stock's own report-day history.
 *
 * Method
 * ------
 *   1. Expiry. The first listed expiry on or after the session that first
 *      trades the report (`reactionSession`). With the hour unknown the report
 *      could land after the close, so the expiry must reach the next session.
 *
 *   2. Quotes. Each leg is priced at its mid ((bid + ask) / 2) when both sides
 *      are quoted and the spread is at most MAX_SPREAD of the mid. Without a
 *      usable mid (a weekend, a closed market zeroing the book) the last trade
 *      stands in, but only a trade from the latest session that opened; the
 *      figure then says it is read from last trades.
 *
 *   3. At the money straddle. Call plus put at every strike where both legs
 *      are priced. With strikes on both sides of the share price the straddle
 *      is interpolated linearly between the two nearest; with one side only,
 *      the nearest strike is used when it sits within NEAR_STRIKE of the price.
 *
 *   4. Raw move. Straddle / share price. Under a normal move this is the
 *      expected size of the move to expiry (a straddle is worth about 0.8 sigma,
 *      and so is the mean absolute move), which is what the realized history is
 *      measured in: absolute close to close moves.
 *
 *   5. Event move. The expiry also prices the ordinary sessions between now
 *      and expiry besides the report session. The next expiry carries the same
 *      report plus more ordinary sessions, so the difference between the two
 *      squared moves per added session is the ordinary per-session amount:
 *          w = (m2^2 - m1^2) / (n2 - n1)
 *          event = sqrt(m1^2 - w * (n1 - 1))
 *      n counts sessions from now through expiry, the report session included.
 *      When the next expiry is missing, the term structure is inverted (w <= 0)
 *      or the subtraction leaves nothing, the raw move stands, and only when
 *      the expiry sits at most MAX_UNADJUSTED_EXTRA sessions past the report.
 *
 * History
 * -------
 *   The move of the session that first traded each of the last reports, close
 *   to close (main/stock-tab-data/report-history.ts, release instants from the
 *   EDGAR time helper). Absolute sizes; the count of reports whose move was
 *   larger than the implied one, and the median. Fewer than MIN_COMPARE_REPORTS
 *   moves on record: the sample is shown, no comparison is drawn.
 *
 * Pure: the clock and every quote are parameters.
 */

import type { EarningsTime } from "./earnings-types";
import { isEarningsTime } from "./earnings-types";
import { nextSession, nyYmdOf, reactionSession, sessionOf } from "./earnings-time";

export const MAX_SPREAD = 0.5;
export const NEAR_STRIKE = 0.025;
/** Bracketing strikes further apart than this (share of price) are not interpolated. */
export const MAX_BRACKET = 0.1;
export const MAX_UNADJUSTED_EXTRA = 4;
/** With the event adjustment the first expiry may still sit this many sessions past the report. */
export const MAX_ADJUSTED_EXTRA = 15;
export const MIN_COMPARE_REPORTS = 4;
export const MAX_HISTORY_REPORTS = 12;
/** How long an option snapshot read during the session is reused. */
export const OPEN_SNAPSHOT_TTL_MS = 5 * 60_000;
/** Upcoming reports this many calendar days out or fewer get the options line (two weeks, today included). */
export const IMPLIED_WITHIN_DAYS = 13;
/** Names one implied move request may carry. */
export const IMPLIED_REQUEST_CAP = 40;

export type OptionLeg = {
  strike: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  lastTradeSec: number | null;
};

export type ExpiryQuotes = { expiry: string; calls: readonly OptionLeg[]; puts: readonly OptionLeg[] };

export type QuoteBasis = "mid" | "last";

/** One leg's price and what it was read from; null when it has no usable price. */
export function legPrice(leg: OptionLeg, freshSinceMs: number): { price: number; basis: QuoteBasis } | null {
  const { bid, ask } = leg;
  if (bid !== null && ask !== null && bid > 0 && ask >= bid) {
    const mid = (bid + ask) / 2;
    if (mid > 0 && (ask - bid) / mid <= MAX_SPREAD) return { price: mid, basis: "mid" };
  }
  if (leg.last !== null && leg.last > 0 && leg.lastTradeSec !== null && leg.lastTradeSec * 1000 >= freshSinceMs) {
    return { price: leg.last, basis: "last" };
  }
  return null;
}

export type Straddle = { strike: number; price: number; basis: QuoteBasis };

/** The at the money straddle of one expiry, or null when no strike near the price is quoted on both legs. */
export function atmStraddle(quotes: ExpiryQuotes, spot: number, freshSinceMs: number): Straddle | null {
  if (!(spot > 0)) return null;
  const puts = new Map(quotes.puts.map((p) => [p.strike, p] as const));
  const priced: Straddle[] = [];
  for (const call of quotes.calls) {
    const put = puts.get(call.strike);
    if (!put) continue;
    const c = legPrice(call, freshSinceMs);
    const p = legPrice(put, freshSinceMs);
    if (!c || !p) continue;
    priced.push({ strike: call.strike, price: c.price + p.price, basis: c.basis === "mid" && p.basis === "mid" ? "mid" : "last" });
  }
  if (priced.length === 0) return null;
  priced.sort((a, b) => a.strike - b.strike);
  const exact = priced.find((s) => s.strike === spot);
  if (exact) return exact;
  let lower: Straddle | null = null;
  let upper: Straddle | null = null;
  for (const s of priced) {
    if (s.strike < spot) lower = s;
    else if (!upper) upper = s;
  }
  if (lower && upper && (upper.strike - lower.strike) / spot <= MAX_BRACKET) {
    const w = (spot - lower.strike) / (upper.strike - lower.strike);
    const nearest = w < 0.5 ? lower : upper;
    return {
      strike: nearest.strike,
      price: (1 - w) * lower.price + w * upper.price,
      basis: lower.basis === "mid" && upper.basis === "mid" ? "mid" : "last",
    };
  }
  const near = [lower, upper]
    .filter((s): s is Straddle => s !== null)
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
  return near && Math.abs(near.strike - spot) / spot <= NEAR_STRIKE ? near : null;
}

/**
 * Sessions from `nowMs` through `expiry`, both ends counted: today when its
 * session has not closed, and the expiry day itself.
 */
export function sessionsThrough(nowMs: number, expiry: string): number {
  let day = nyYmdOf(nowMs);
  let n = 0;
  const today = sessionOf(day);
  if (today && nowMs < today.closeMs && day <= expiry) n++;
  for (let guard = 0; guard < 400; guard++) {
    day = nextSession(day);
    if (day > expiry) break;
    n++;
  }
  return n;
}

/** Sessions strictly after `from` up to and including `to`. */
export function sessionsAfter(from: string, to: string): number {
  let day = from;
  let n = 0;
  for (let guard = 0; guard < 400; guard++) {
    day = nextSession(day);
    if (day > to) break;
    n++;
  }
  return n;
}

export type ImpliedFigureInput = {
  spot: number;
  first: ExpiryQuotes;
  next: ExpiryQuotes | null;
  /** Sessions from now through the first expiry, the report session included. */
  sessionsToFirst: number;
  sessionsToNext: number | null;
  /** Sessions between the report session and the first expiry, the expiry day included. */
  extraSessions: number;
  freshSinceMs: number;
};

export type ImpliedFigure = {
  strike: number;
  /** Straddle price in the quote currency. */
  straddle: number;
  /** Straddle / price: the move priced to expiry, as a fraction. */
  raw: number;
  /** The report move: raw with the ordinary sessions taken out when that could be done. */
  move: number;
  adjusted: boolean;
  basis: QuoteBasis;
};

/** The implied report move from one or two expiries; null when the quotes do not support one. */
export function impliedFigure(input: ImpliedFigureInput): ImpliedFigure | null {
  const { spot } = input;
  const first = atmStraddle(input.first, spot, input.freshSinceMs);
  if (!first) return null;
  const m1 = first.price / spot;
  if (!(m1 > 0) || m1 >= 1) return null;
  let move = m1;
  let adjusted = false;
  let basis = first.basis;
  const n1 = input.sessionsToFirst;
  const n2 = input.sessionsToNext;
  if (input.next && n2 !== null && n2 > n1 && n1 > 1) {
    const second = atmStraddle(input.next, spot, input.freshSinceMs);
    if (second) {
      const m2 = second.price / spot;
      const w = (m2 * m2 - m1 * m1) / (n2 - n1);
      const rest = m1 * m1 - w * (n1 - 1);
      if (w > 0 && rest > 0) {
        move = Math.sqrt(rest);
        adjusted = true;
        if (second.basis === "last") basis = "last";
      }
    }
  }
  if (!adjusted && input.extraSessions > MAX_UNADJUSTED_EXTRA) return null;
  if (adjusted && input.extraSessions > MAX_ADJUSTED_EXTRA) return null;
  return { strike: first.strike, straddle: round(first.price, 4), raw: round(m1, 6), move: round(move, 6), adjusted, basis };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// Expiries and the snapshot clock
// ---------------------------------------------------------------------------

/** The session that first trades the report, and the earliest expiry that covers it. */
export function reportCover(date: string, time: EarningsTime): { reactionDay: string; coverFrom: string } {
  const reactionDay = reactionSession(date, time);
  // An unknown hour could be after the close: the expiry has to reach the next session.
  const coverFrom = time === "unknown" && reactionDay === date ? nextSession(date) : reactionDay;
  return { reactionDay, coverFrom };
}

/** The first expiry covering the report and the one after it (within 35 days), from the listed expiries. */
export function pickExpiries(expirations: readonly string[], coverFrom: string, today: string): { first: string; next: string | null } | null {
  const sorted = [...expirations].sort();
  const first = sorted.find((e) => e >= coverFrom && e >= today);
  if (!first) return null;
  const after = sorted.find((e) => e > first) ?? null;
  const next = after && (Date.parse(`${after}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86_400_000 <= 35 ? after : null;
  return { first, next };
}

/**
 * Until when an option snapshot read at `atMs` is reused: a few minutes while
 * the regular session is open, and through to the next open otherwise, so a
 * closed market is asked once.
 */
export function snapshotFreshUntil(atMs: number): number {
  const day = nyYmdOf(atMs);
  const s = sessionOf(day);
  if (s && atMs >= s.openMs && atMs < s.closeMs) return Math.min(atMs + OPEN_SNAPSHOT_TTL_MS, s.closeMs + 60_000);
  if (s && atMs < s.openMs) return s.openMs;
  const next = sessionOf(nextSession(day));
  return next ? next.openMs : atMs + 12 * 3_600_000;
}

/** The open of the latest session that has opened by `nowMs`: last trades older than it are stale. */
export function latestOpenMs(nowMs: number): number {
  let day = nyYmdOf(nowMs);
  for (let guard = 0; guard < 15; guard++) {
    const s = sessionOf(day);
    if (s && s.openMs <= nowMs) return s.openMs;
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    day = d.toISOString().slice(0, 10);
  }
  return nowMs - 4 * 86_400_000;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export type MoveHistory = {
  /** Report moves on record, up to MAX_HISTORY_REPORTS. */
  n: number;
  /** Reports whose absolute move was larger than the implied one; null below MIN_COMPARE_REPORTS. */
  above: number | null;
  /** Median absolute move; null below MIN_COMPARE_REPORTS. */
  median: number | null;
  /** Oldest and newest report date in the sample. */
  from: string | null;
  to: string | null;
};

export type ReportMove = { date: string; move: number };

/** The last reports' moves against the implied move. `moves` in any order; the newest MAX_HISTORY_REPORTS count. */
export function moveHistory(moves: readonly ReportMove[], implied: number): MoveHistory {
  const sample = moves
    .filter((m) => Number.isFinite(m.move) && /^\d{4}-\d{2}-\d{2}$/.test(m.date))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_HISTORY_REPORTS);
  const n = sample.length;
  const sizes = sample.map((m) => Math.abs(m.move));
  const from = n > 0 ? sample[n - 1]!.date : null;
  const to = n > 0 ? sample[0]!.date : null;
  if (n < MIN_COMPARE_REPORTS) return { n, above: null, median: null, from, to };
  return { n, above: sizes.filter((s) => s > implied).length, median: round(median(sizes), 6), from, to };
}

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// The IPC contract
// ---------------------------------------------------------------------------

export type ImpliedMove = {
  ticker: string;
  reportDate: string;
  reactionDay: string;
  spot: number;
  expiry: string;
  /** The expiry the ordinary sessions were read from; null when the raw move stands. */
  nextExpiry: string | null;
  strike: number;
  straddle: number;
  raw: number;
  move: number;
  adjusted: boolean;
  /** Sessions from the read through the first expiry, the report session included. */
  sessions: number;
  basis: QuoteBasis;
  /** When the option snapshot was read, ISO. */
  quotedAt: string;
  history: MoveHistory;
};

export type ImpliedRequestItem = { ticker: string; date: string; time: EarningsTime };

export type ImpliedMovesResult =
  | { ok: true; moves: Record<string, ImpliedMove | null> }
  | { ok: false; error: "invalid_request" | "unavailable" };

const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;

/** The reports of an implied move request, cleaned and capped; null when it is not one. */
export function parseImpliedRequest(raw: unknown): ImpliedRequestItem[] | null {
  if (!Array.isArray(raw) || raw.length > 500) return null;
  const out = new Map<string, ImpliedRequestItem>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const ticker = typeof r.ticker === "string" ? r.ticker.trim().toUpperCase() : "";
    const date = typeof r.date === "string" ? r.date : "";
    if (!TICKER.test(ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.set(ticker, { ticker, date, time: isEarningsTime(r.time) ? r.time : "unknown" });
  }
  return [...out.values()].slice(0, IMPLIED_REQUEST_CAP);
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export type Say = (key: string, params?: Record<string, string | number>) => string;

/** A size of move as a plain percent: "6.1%". `v` is a fraction. */
export function formatImpliedPct(v: number, lang: string): string {
  try {
    return new Intl.NumberFormat(lang, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(v));
  } catch {
    return `${(Math.abs(v) * 100).toFixed(1)}%`;
  }
}

function money(v: number, lang: string): string {
  try {
    return new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  } catch {
    return v.toFixed(2);
  }
}

function ymdText(ymd: string, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${ymd}T12:00:00Z`));
  } catch {
    return ymd;
  }
}

function monthText(ymd: string, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${ymd}T12:00:00Z`));
  } catch {
    return ymd.slice(0, 7);
  }
}

function timeText(iso: string, lang: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    return new Intl.DateTimeFormat(lang, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" }).format(new Date(ms));
  } catch {
    return iso;
  }
}

/** The one line: the implied move, and the stock's own record against it when the sample allows. */
export function impliedLine(v: ImpliedMove, say: Say, lang: string): string {
  const pct = formatImpliedPct(v.move, lang);
  const h = v.history;
  if (h.above !== null && h.median !== null) {
    return say("implied.line.compare", { pct, ticker: v.ticker, count: h.above, n: h.n, median: formatImpliedPct(h.median, lang) });
  }
  if (h.n > 0) return say("implied.line.few", { pct, n: h.n });
  return say("implied.line.alone", { pct });
}

/** The hover text: how the figure was read, line by line. */
export function impliedHint(v: ImpliedMove, say: Say, lang: string): string {
  const lines = [
    say("implied.hint.straddle", {
      expiry: ymdText(v.expiry, lang),
      strike: money(v.strike, lang),
      spot: money(v.spot, lang),
      basis: say(v.basis === "mid" ? "implied.hint.mid" : "implied.hint.last"),
      time: timeText(v.quotedAt, lang),
    }),
  ];
  if (v.adjusted && v.nextExpiry) {
    lines.push(say("implied.hint.adjusted", { raw: formatImpliedPct(v.raw, lang), sessions: Math.max(0, v.sessions - 1), next: ymdText(v.nextExpiry, lang) }));
  }
  if (v.history.n > 0 && v.history.from && v.history.to) {
    lines.push(say("implied.hint.history", { n: v.history.n, from: monthText(v.history.from, lang), to: monthText(v.history.to, lang) }));
  }
  return lines.join("\n");
}
