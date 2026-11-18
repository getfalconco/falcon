/**
 * Databento daily prices (Supabase prices_daily, via lib/prices-api) for the
 * Desk tools. Every read returns null when the ticker has no Databento data
 * or the store cannot be read, so callers fall back to Yahoo. `prices` is a
 * mutable seam for tests.
 */

import { getHistory, getLatest, type PriceBar, type PriceLatest, type PriceRange } from "../../prices-api";

export const DATABENTO_LABEL = "Databento EQUS.SUMMARY, end of day";

export const prices = {
  getLatest: (t: string): Promise<PriceLatest> => getLatest(t),
  getHistory: (t: string, r: PriceRange) => getHistory(t, r),
};

export async function databentoLatest(ticker: string): Promise<PriceLatest | null> {
  try {
    const l = await prices.getLatest(ticker);
    return l.date && l.close !== null ? l : null;
  } catch {
    return null;
  }
}

/** All stored bars of a ticker, split-adjusted, oldest first; null when none or unreadable. */
export async function databentoBars(ticker: string, range: PriceRange = "max"): Promise<{ bars: PriceBar[]; from: string; asOf: string } | null> {
  try {
    const h = await prices.getHistory(ticker, range);
    return h.bars.length && h.from && h.asOf ? { bars: h.bars, from: h.from, asOf: h.asOf } : null;
  } catch {
    return null;
  }
}
