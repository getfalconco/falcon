/**
 * Historical earnings events (scripts/earnings-events.ts -> Supabase
 * public.historical_events): the pure parts, so the rules are tested apart
 * from EDGAR, prices and the database.
 *
 *   - Event day: the first NYSE session whose close comes after the EDGAR
 *     acceptance instant. Accepted before the close (16:00 New York, 13:00 on
 *     early-close days) -> that day; at or after the close, or on a weekend or
 *     holiday -> the next session.
 *   - Two-day return over d0 and d1: (1 + r_d0)(1 + r_d1) - 1 with
 *     r_d = close(d) / close(d - 1) - 1, i.e. close(d1) / close(d-1) - 1.
 *   - Abnormal: (1 + r_stock_d0)(1 + r_stock_d1) - (1 + r_etf_d0)(1 + r_etf_d1).
 *   - Single days: abnormal d0 = r_stock_d0 - r_etf_d0, abnormal d1 =
 *     r_stock_d1 - r_etf_d1 (d1 alone: close(d1) / close(d0) - 1). The two-day
 *     abnormal is not their sum: it compounds the stock and ETF legs first.
 *
 * Pure: no fs, no network, no clock.
 */

import { addDays, isNyseSession, sessionCloseMs } from "./abnormal.ts";

/** GICS-like sector (apps/web/scripts/sic-sectors.mjs) -> SPDR sector ETF. */
export const SECTOR_ETF: Record<string, string> = {
  "Information Technology": "XLK",
  Financials: "XLF",
  "Health Care": "XLV",
  "Consumer Discretionary": "XLY",
  "Consumer Staples": "XLP",
  Energy: "XLE",
  Industrials: "XLI",
  Materials: "XLB",
  Utilities: "XLU",
  "Real Estate": "XLRE",
  "Communication Services": "XLC",
};

export const MARKET_ETF = "SPY";

/** The NYSE session on or after a New York date. */
export function sessionOnOrAfter(ymd: string): string {
  let d = ymd;
  while (!isNyseSession(d)) d = addDays(d, 1);
  return d;
}

export function nextSession(ymd: string): string {
  return sessionOnOrAfter(addDays(ymd, 1));
}

export function prevSession(ymd: string): string {
  let d = addDays(ymd, -1);
  while (!isNyseSession(d)) d = addDays(d, -1);
  return d;
}

const NY_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** The New York calendar date of an instant. */
export function nyDate(ms: number): string {
  return NY_DATE.format(new Date(ms));
}

/**
 * Event day d0 for a filing accepted at `acceptedMs`: the acceptance day when
 * it is a session and the acceptance is strictly before that day's close,
 * else the next session.
 */
export function eventDay(acceptedMs: number): string {
  const day = nyDate(acceptedMs);
  if (isNyseSession(day) && acceptedMs < sessionCloseMs(day)) return day;
  return nextSession(day);
}

/** The sessions a two-day reading needs: d-1 (base), d0, d1. */
export function windowSessions(d0: string): { base: string; d0: string; d1: string } {
  return { base: prevSession(d0), d0, d1: nextSession(d0) };
}

/** close(d1) / close(d-1) - 1, the same as (1 + r_d0)(1 + r_d1) - 1. Null when any close is missing or not positive. */
export function twoDayReturn(base: number | null | undefined, c0: number | null | undefined, c1: number | null | undefined): number | null {
  const ok = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
  if (!ok(base) || !ok(c0) || !ok(c1)) return null;
  return (1 + (c0 / base - 1)) * (1 + (c1 / c0 - 1)) - 1;
}

/** The single-day returns of a two-day window and their compound; each null when its closes are missing. */
export type DayReturns = { d0: number | null; d1: number | null; d0d1: number | null };

/**
 * d0 = close(d0) / close(d-1) - 1, d1 = close(d1) / close(d0) - 1 (the next
 * session alone), d0d1 = (1 + d0)(1 + d1) - 1, computed exactly as
 * twoDayReturn so the two agree to the bit.
 */
export function dayReturns(base: number | null | undefined, c0: number | null | undefined, c1: number | null | undefined): DayReturns {
  const ok = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
  const d0 = ok(base) && ok(c0) ? c0 / base - 1 : null;
  const d1 = ok(c0) && ok(c1) ? c1 / c0 - 1 : null;
  return { d0, d1, d0d1: twoDayReturn(base, c0, c1) };
}

/** (1 + stock)(...) - (1 + etf)(...) on compounded two-day returns: stock - etf. Null when either is. */
export function abnormalReturn(stock: number | null, etf: number | null): number | null {
  if (stock === null || etf === null) return null;
  return stock - etf;
}

export const SUSPICIOUS_ABS = 0.5;

export type EventFlag =
  | "missing_price"
  | "etf_fallback_spy"
  | "amended"
  | "multiple_same_day"
  | "suspicious_move"
  | "before_first_price"
  | "cik_mismatch"
  | "price_source_disagree";

/** Accessions of filings that share a ticker and event day with another 2.02 filing. */
export function sameDayAccessions(rows: ReadonlyArray<{ ticker: string; accession: string; eventDate: string }>): Set<string> {
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const k = `${r.ticker}|${r.eventDate}`;
    const g = groups.get(k);
    if (g) g.push(r.accession);
    else groups.set(k, [r.accession]);
  }
  const out = new Set<string>();
  for (const g of groups.values()) if (g.length > 1) for (const a of g) out.add(a);
  return out;
}

/** An 8-K item list ("2.02,9.01") holds item 2.02. */
export function hasItem202(items: string | null | undefined): boolean {
  return (items ?? "").split(",").some((s) => s.trim() === "2.02");
}

/** Forms kept: 8-K and its amendments. */
export function isEarningsForm(form: string | null | undefined): boolean {
  return form === "8-K" || form === "8-K/A";
}

/** EDGAR filing index URL of an accession. */
export function filingIndexUrl(cik: number | string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${accession}-index.htm`;
}

/** Nearest-rank percentile of a sorted array (p in [0, 1]). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}
