import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabase-admin";

/**
 * Daily stock prices for the universe (Databento EQUS.SUMMARY: the
 * consolidated official daily open, high, low, close and volume across US
 * venues), stored once a trading day by the engine's prices job
 * (packages/engine/src/prices/daily.ts) in Supabase public.prices_daily,
 * from 2024-07-01 (the dataset's first day). Nothing here calls Databento.
 *
 * Server side, the Desk tools call these directly (service role):
 *   getHistory(ticker, range)  -> PriceHistory
 *   getLatest(ticker)          -> PriceLatest
 * In the browser, GET /api/prices?ticker=X&range=1y and ?ticker=X&latest=1
 * answer the same shapes (fetchPriceHistory / fetchPriceLatest below).
 *
 * Adjustment: bars are stored unadjusted. Prices here are split-adjusted
 * with public.prices_splits (splits detected from the bars, or entered by
 * hand): a price before a split is divided by the split's ratio, its volume
 * multiplied by it, so a series reads in today's shares. Dividends are not
 * adjusted (price return, not total return). A ticker that changed symbol
 * has history only under its current symbol, from the change on.
 *
 * Server only (reads with the service role); the types and pure helpers are
 * safe anywhere.
 */

export const PRICE_RANGES = ["1m", "3m", "6m", "1y", "5y", "max"] as const;
export type PriceRange = (typeof PRICE_RANGES)[number];

export const PRICES_SOURCE = "EQUS.SUMMARY via Databento" as const;

/** [date YYYY-MM-DD, open, high, low, close, volume], oldest first. */
export type PriceBar = [string, number, number, number, number, number];

export type PriceSplit = { date: string; ratio: number };

export type PriceHistory = {
  ticker: string;
  range: PriceRange;
  /** Date of the newest bar (YYYY-MM-DD), null when the ticker has none. */
  asOf: string | null;
  /** Date of the oldest bar returned (the range start, or the first stored day). */
  from: string | null;
  source: typeof PRICES_SOURCE;
  /** "splits": prices divided (and volumes multiplied) by the ratios of later splits. */
  adjusted: "splits";
  /** Splits applied to this series (ratio = new shares per old share), oldest first. */
  splits: PriceSplit[];
  columns: ["date", "open", "high", "low", "close", "volume"];
  bars: PriceBar[];
  count: number;
};

export type PriceLatest = {
  ticker: string;
  /** Session of the last close (YYYY-MM-DD), null when the ticker has none. */
  date: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  /** The session before, its close split-adjusted to `date`'s shares. */
  prevDate: string | null;
  prevClose: number | null;
  /** close - prevClose, and that in percent. */
  change: number | null;
  changePct: number | null;
  source: typeof PRICES_SOURCE;
};

export type StoredBar = { date: string; open: number; high: number; low: number; close: number; volume: number };

const TICKER = /^[A-Z][A-Z0-9-]{0,9}$/;
const PAGE = 1000;
const MAX_ROWS = 20_000;

/** A ticker in the stored form (upper case, BRK.B -> BRK-B), or null when malformed. Pure. */
export function normalizeTicker(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim().toUpperCase().replace(/\./g, "-");
  return TICKER.test(t) ? t : null;
}

export function isPriceRange(v: string | null | undefined): v is PriceRange {
  return (PRICE_RANGES as readonly string[]).includes(v ?? "");
}

/** The first date a range covers, counted back from the newest bar (null: everything). Pure. */
export function rangeStart(range: PriceRange, asOf: string): string | null {
  if (range === "max") return null;
  const months = { "1m": 1, "3m": 3, "6m": 6, "1y": 12, "5y": 60 }[range];
  const [y, m, d] = asOf.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  // Clamp the day (Mar 31 - 1m = Feb 28/29).
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  // The day after: 1y back from 2026-11-13 starts 2025-11-14.
  return new Date(target.getTime() + 86_400_000).toISOString().slice(0, 10);
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** Product of the ratios of splits after `date` (what a price that day is divided by). Pure. */
export function splitFactor(splits: readonly PriceSplit[], date: string): number {
  let f = 1;
  for (const s of splits) if (s.date > date && s.ratio > 0) f *= s.ratio;
  return f;
}

/** Stored bars (any order) to split-adjusted compact bars, oldest first. Pure. */
export function adjustBars(rows: readonly StoredBar[], splits: readonly PriceSplit[]): PriceBar[] {
  return [...rows]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((r) => {
      const f = splitFactor(splits, r.date);
      return [r.date, r4(r.open / f), r4(r.high / f), r4(r.low / f), r4(r.close / f), Math.round(r.volume * f)];
    });
}

/** The latest-close summary from the newest two stored bars (any order). Pure. */
export function latestOf(ticker: string, rows: readonly StoredBar[], splits: readonly PriceSplit[]): PriceLatest {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const cur = sorted[0];
  if (!cur) return emptyLatest(ticker);
  const prev = sorted[1];
  // The previous close in today's shares: divided by the splits between the two sessions.
  const prevClose = prev ? r4(prev.close / (splitFactor(splits, prev.date) / splitFactor(splits, cur.date))) : null;
  const change = prevClose !== null ? r4(cur.close - prevClose) : null;
  return {
    ticker,
    date: cur.date,
    open: cur.open,
    high: cur.high,
    low: cur.low,
    close: cur.close,
    volume: cur.volume,
    prevDate: prev?.date ?? null,
    prevClose,
    change,
    changePct: prevClose ? Math.round((10_000 * (cur.close - prevClose)) / prevClose) / 100 : null,
    source: PRICES_SOURCE,
  };
}

export function emptyHistory(ticker: string, range: PriceRange): PriceHistory {
  return { ticker, range, asOf: null, from: null, source: PRICES_SOURCE, adjusted: "splits", splits: [], columns: ["date", "open", "high", "low", "close", "volume"], bars: [], count: 0 };
}

export function emptyLatest(ticker: string): PriceLatest {
  return { ticker, date: null, open: null, high: null, low: null, close: null, volume: null, prevDate: null, prevClose: null, change: null, changePct: null, source: PRICES_SOURCE };
}

/** The history payload from stored bars and splits. Pure. */
export function historyOf(ticker: string, range: PriceRange, rows: readonly StoredBar[], splits: readonly PriceSplit[]): PriceHistory {
  const bars = adjustBars(rows, splits);
  if (!bars.length) return emptyHistory(ticker, range);
  const from = bars[0]![0];
  const asOf = bars[bars.length - 1]![0];
  return {
    ...emptyHistory(ticker, range),
    asOf,
    from,
    // Only the splits that changed a returned price.
    splits: splits.filter((s) => s.date > from && s.ratio !== 1).map((s) => ({ date: s.date, ratio: s.ratio })),
    bars,
    count: bars.length,
  };
}

// ---------------------------------------------------------------------------
// Server reads (service role)

type Row = { date: string; open: number; high: number; low: number; close: number; volume: number | string };
const toBar = (r: Row): StoredBar => ({ date: r.date, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) });

async function readSplits(db: SupabaseClient, ticker: string): Promise<PriceSplit[]> {
  const res = await db.from("prices_splits").select("date, ratio").eq("ticker", ticker).order("date");
  if (res.error) throw res.error;
  return ((res.data ?? []) as Array<{ date: string; ratio: number }>).map((s) => ({ date: s.date, ratio: Number(s.ratio) })).filter((s) => s.ratio > 0);
}

/**
 * Split-adjusted daily bars of `ticker` over `range`, counted back from its
 * newest bar. Throws on a database error; an unknown ticker gives the empty
 * shape (asOf null).
 */
export async function getHistory(ticker: string, range: PriceRange = "1y", db: SupabaseClient = getSupabaseAdmin()): Promise<PriceHistory> {
  const t = normalizeTicker(ticker);
  if (!t) return emptyHistory(ticker, range);
  const newest = await db.from("prices_daily").select("date").eq("ticker", t).order("date", { ascending: false }).limit(1);
  if (newest.error) throw newest.error;
  const asOf = (newest.data?.[0] as { date: string } | undefined)?.date;
  if (!asOf) return emptyHistory(t, range);
  const start = rangeStart(range, asOf);
  const rows: StoredBar[] = [];
  // PostgREST answers at most 1000 rows a request: page through.
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    let q = db.from("prices_daily").select("date, open, high, low, close, volume").eq("ticker", t);
    if (start) q = q.gte("date", start);
    const res = await q.order("date").range(from, from + PAGE - 1);
    if (res.error) throw res.error;
    const page = (res.data ?? []) as Row[];
    rows.push(...page.map(toBar));
    if (page.length < PAGE) break;
  }
  return historyOf(t, range, rows, await readSplits(db, t));
}

/** The last close of `ticker`, its change against the session before, volume and date. Throws on a database error. */
export async function getLatest(ticker: string, db: SupabaseClient = getSupabaseAdmin()): Promise<PriceLatest> {
  const t = normalizeTicker(ticker);
  if (!t) return emptyLatest(ticker);
  const res = await db.from("prices_daily").select("date, open, high, low, close, volume").eq("ticker", t).order("date", { ascending: false }).limit(2);
  if (res.error) throw res.error;
  const rows = ((res.data ?? []) as Row[]).map(toBar);
  if (!rows.length) return emptyLatest(t);
  return latestOf(t, rows, await readSplits(db, t));
}

// ---------------------------------------------------------------------------
// Client helpers (browser or server; same-origin by default)

/** Daily bars over a range; the empty shape on any error. */
export async function fetchPriceHistory(ticker: string, range: PriceRange = "1y", init?: RequestInit, base = ""): Promise<PriceHistory> {
  const t = ticker.trim().toUpperCase();
  try {
    const res = await fetch(`${base}/api/prices?ticker=${encodeURIComponent(t)}&range=${range}`, init);
    if (!res.ok) return emptyHistory(t, range);
    const body = (await res.json()) as PriceHistory;
    return body && Array.isArray(body.bars) ? body : emptyHistory(t, range);
  } catch {
    return emptyHistory(t, range);
  }
}

/** The last close and change; the empty shape on any error. */
export async function fetchPriceLatest(ticker: string, init?: RequestInit, base = ""): Promise<PriceLatest> {
  const t = ticker.trim().toUpperCase();
  try {
    const res = await fetch(`${base}/api/prices?ticker=${encodeURIComponent(t)}&latest=1`, init);
    if (!res.ok) return emptyLatest(t);
    const body = (await res.json()) as PriceLatest;
    return body && body.ticker ? body : emptyLatest(t);
  } catch {
    return emptyLatest(t);
  }
}
