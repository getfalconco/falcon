import { yahooChart, type ChartResult } from "./desk/tools/yahoo";
import { TtlCache } from "./desk/tools/util";
import type { EquityRange, PriceSeries } from "./workspace/equity";

/**
 * Price history for the Equity card (server only): Yahoo's v8 chart through
 * the shared polite client (lib/desk/tools/yahoo.ts, 6 at a time), held per
 * symbol and range on this server instance. Symbols come from our own client,
 * so a member's tickers never go from the browser to Yahoo; sizes never leave
 * the browser at all (the curve is built there, lib/workspace/equity.ts).
 * Never invents a point: closes Yahoo did not give are left out.
 */

/** Yahoo's range and bar size for each timeframe: bars that read like a trading chart at that zoom. */
export const RANGE_QUERY: Record<EquityRange, { range: string; interval: string; freshMs: number; days?: number }> = {
  "1D": { range: "1d", interval: "5m", freshMs: 60_000 },
  // Yahoo counts "7d" in trading days for stocks and calendar days for crypto: clipped to the last 7 calendar days for both.
  "1W": { range: "7d", interval: "30m", freshMs: 5 * 60_000, days: 7 },
  "1M": { range: "1mo", interval: "60m", freshMs: 15 * 60_000 },
  "3M": { range: "3mo", interval: "1d", freshMs: 30 * 60_000 },
  YTD: { range: "ytd", interval: "1d", freshMs: 30 * 60_000 },
  "1Y": { range: "1y", interval: "1d", freshMs: 30 * 60_000 },
  "5Y": { range: "5y", interval: "1d", freshMs: 60 * 60_000 },
};

export const MAX_HISTORY_SYMBOLS = 60;
const TIMEOUT_MS = 8_000;
const cache = new TtlCache<{ at: number; series: PriceSeries | null }>(60 * 60_000, 3_000);

export function isEquityRange(v: string | null): v is EquityRange {
  return v !== null && Object.prototype.hasOwnProperty.call(RANGE_QUERY, v);
}

/** Pure: a chart's closes as a series (epoch ms, oldest first), gaps and non-positive closes dropped; from `fromMs` on when given; with the close before the range when Yahoo gives it. */
export function seriesFromChart(chart: ChartResult | null, fromMs = 0): PriceSeries {
  const times = chart?.timestamp ?? [];
  const closes = chart?.indicators?.quote?.[0]?.close ?? [];
  const out: PriceSeries = { t: [], c: [] };
  for (let i = 0; i < times.length; i++) {
    const c = closes[i];
    if (typeof c !== "number" || !Number.isFinite(c) || c <= 0) continue;
    const t = times[i]! * 1000;
    if (t < fromMs) continue;
    if (out.t.length && t <= out.t[out.t.length - 1]!) continue;
    out.t.push(t);
    out.c.push(c);
  }
  const prev = chart?.meta?.chartPreviousClose;
  if (typeof prev === "number" && Number.isFinite(prev) && prev > 0) out.prev = prev;
  return out;
}

/** Series for the quote symbols over a timeframe; a symbol without one is left out. Never throws. */
export function historyFor(symbols: readonly string[], range: EquityRange): Promise<Record<string, PriceSeries>> {
  return historyBars(symbols, RANGE_QUERY[range]);
}

/**
 * Series at any Yahoo range and bar size (the real-history part of a long
 * timeframe uses finer bars than the timeframe: lib/workspace/equity.ts
 * chooseInterval), clipped to the last `days` calendar days when given.
 * Cached per symbol, range and bar size. Never throws.
 */
export async function historyBars(symbols: readonly string[], q: { range: string; interval: string; freshMs: number; days?: number }): Promise<Record<string, PriceSeries>> {
  const out: Record<string, PriceSeries> = {};
  await Promise.all(
    symbols.map(async (s) => {
      const key = `${s}|${q.range}|${q.interval}|${q.days ?? ""}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < q.freshMs) {
        if (hit.series) out[s] = hit.series;
        return;
      }
      try {
        const from = q.days ? Date.now() - q.days * 86_400_000 : 0;
        const series = seriesFromChart(await yahooChart(s, q.range, q.interval, AbortSignal.timeout(TIMEOUT_MS)), from);
        cache.set(key, { at: Date.now(), series: series.t.length ? series : null });
        if (series.t.length) out[s] = series;
      } catch (error) {
        console.error("[portfolio history] Yahoo chart failed", error instanceof Error ? error.name : "unknown");
        if (hit?.series) out[s] = hit.series;
      }
    }),
  );
  return out;
}
