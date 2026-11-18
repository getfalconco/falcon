/**
 * `history(ticker, range)`: daily (weekly for 10y and max) bars from Yahoo's
 * v8 chart, summarized: first and last close, price and total return, high
 * and low with dates, maximum drawdown, volatility, average volume, plus up to
 * MAX_POINTS closes evenly spread over the range for the model to describe the
 * path. Prices are split-adjusted as Yahoo prints them; total return uses
 * Yahoo's dividend-adjusted close.
 */

import { yahooChart, type ChartResult } from "./yahoo";
import { ToolError, downsample, nyParts, round, type DeskToolContext } from "./util";
import { DATABENTO_LABEL, databentoBars } from "./databento";

export const HISTORY_RANGES = ["1m", "3m", "6m", "ytd", "1y", "2y", "5y", "10y", "max"] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

const YAHOO_RANGE: Record<HistoryRange, { range: string; interval: "1d" | "1wk" }> = {
  "1m": { range: "1mo", interval: "1d" },
  "3m": { range: "3mo", interval: "1d" },
  "6m": { range: "6mo", interval: "1d" },
  ytd: { range: "ytd", interval: "1d" },
  "1y": { range: "1y", interval: "1d" },
  "2y": { range: "2y", interval: "1d" },
  "5y": { range: "5y", interval: "1d" },
  "10y": { range: "10y", interval: "1wk" },
  max: { range: "max", interval: "1wk" },
};

export const MAX_POINTS = 120;

type Bar = { date: string; open: number; high: number; low: number; close: number; adj: number; volume: number };

const good = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Bars from a chart answer, oldest first, one per date. Pure. */
export function barsFromChart(c: ChartResult): Bar[] {
  const ts = c.timestamp ?? [];
  const q = c.indicators?.quote?.[0];
  const adj = c.indicators?.adjclose?.[0]?.adjclose;
  const off = c.meta.gmtoffset ?? -5 * 3600;
  const byDate = new Map<string, Bar>();
  for (let i = 0; i < ts.length; i++) {
    const close = q?.close?.[i];
    if (!good(close)) continue;
    const open = good(q?.open?.[i]) ? q!.open![i]! : close;
    const high = Math.max(good(q?.high?.[i]) ? q!.high![i]! : close, open, close);
    const low = Math.min(good(q?.low?.[i]) ? q!.low![i]! : close, open, close);
    const a = adj?.[i];
    const date = new Date((ts[i]! + off) * 1000).toISOString().slice(0, 10);
    byDate.set(date, { date, open, high, low, close, adj: good(a) ? a : close, volume: q?.volume?.[i] ?? 0 });
  }
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** The summary the tool returns. Pure. */
export function summarizeBars(symbol: string, range: HistoryRange, bars: Bar[], c: ChartResult, nowSec = Date.now() / 1000, databento = false) {
  if (bars.length < 2) throw new ToolError(`Not enough price history for ${symbol} over ${range}.`);
  const interval = databento ? "1d" : YAHOO_RANGE[range].interval;
  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  let hi = first;
  let lo = first;
  let peak = first;
  let dd = { pct: 0, peakDate: first.date, troughDate: first.date };
  let volSum = 0;
  const rets: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.high > hi.high) hi = b;
    if (b.low < lo.low) lo = b;
    if (b.close > peak.close) peak = b;
    const draw = b.close / peak.close - 1;
    if (draw < dd.pct) dd = { pct: draw, peakDate: peak.date, troughDate: b.date };
    volSum += b.volume;
    if (i > 0) rets.push(Math.log(b.adj / bars[i - 1]!.adj));
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const perYear = interval === "1d" ? 252 : 52;
  const regular = c.meta.currentTradingPeriod?.regular;
  const sessionOpen = regular?.start !== undefined && regular?.end !== undefined && nowSec >= regular.start && nowSec < regular.end;
  const lastIsLive = sessionOpen && last.date === nyParts(nowSec * 1000).date;
  const currency = typeof c.meta.currency === "string" ? c.meta.currency : null;
  return {
    ticker: symbol,
    range,
    interval: interval === "1d" ? "daily" : "weekly",
    currency,
    bars: bars.length,
    start: { date: first.date, close: round(first.close, 4) },
    end: { date: last.date, close: round(last.close, 4), ...(lastIsLive ? { note: "today's bar, market still open" } : {}) },
    priceReturnPct: round((last.close / first.close - 1) * 100, 2),
    totalReturnPct: databento ? null : round((last.adj / first.adj - 1) * 100, 2),
    high: { date: hi.date, price: round(hi.high, 4) },
    low: { date: lo.date, price: round(lo.low, 4) },
    maxDrawdown: { pct: round(dd.pct * 100, 2), peakDate: dd.peakDate, troughDate: dd.troughDate },
    volatilityAnnualizedPct: rets.length >= 5 ? round(Math.sqrt(variance * perYear) * 100, 1) : null,
    avgVolume: Math.round(volSum / bars.length),
    closes: downsample(bars, MAX_POINTS).map((b) => [b.date, round(b.close, 2)]),
    notes: [
      databento
        ? "Prices split-adjusted, price return (dividends not included); totalReturnPct is not available from this source."
        : "Prices split-adjusted as Yahoo prints them; totalReturnPct includes dividends (Yahoo adjusted close). Databento history only starts 2024-07-01, so this range comes from Yahoo.",
      bars.length > MAX_POINTS ? `closes: ${MAX_POINTS} of ${bars.length} bars, evenly spaced; the stats use every bar.` : "closes: every bar.",
      "High/low are intraday extremes; max drawdown is close to close.",
    ],
    source: databento ? `${DATABENTO_LABEL}, as of ${last.date}` : "Yahoo Finance chart (v8)",
  };
}

/** First date of a range counted back from the newest bar date. Pure. */
export function rangeStartDate(range: HistoryRange, asOf: string): string | null {
  if (range === "max") return null;
  const [y, m, d] = asOf.split("-").map(Number) as [number, number, number];
  if (range === "ytd") return `${y}-01-01`;
  const months = { "1m": 1, "3m": 3, "6m": 6, "1y": 12, "2y": 24, "5y": 60, "10y": 120 }[range];
  const t = new Date(Date.UTC(y, m - 1 - months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return new Date(t.getTime() + 86_400_000).toISOString().slice(0, 10);
}

export async function historyTool(symbol: string, range: HistoryRange, _ctx: DeskToolContext, signal: AbortSignal) {
  const d = await databentoBars(symbol, "max");
  if (d) {
    const start = rangeStartDate(range, d.asOf);
    // Databento starts 2024-07-01: a longer range comes whole from Yahoo (never mixed).
    if (start !== null && start >= d.from) {
      const bars: Bar[] = d.bars
        .filter((b) => b[0] >= start)
        .map((b) => ({ date: b[0], open: b[1], high: b[2], low: b[3], close: b[4], adj: b[4], volume: b[5] }));
      if (bars.length >= 2) return summarizeBars(symbol, range, bars, { meta: { currency: "USD" } } as ChartResult, Date.now() / 1000, true);
    }
  }
  const { range: yr, interval } = YAHOO_RANGE[range];
  const chart = await yahooChart(symbol, yr, interval, signal);
  if (!chart) throw new ToolError(`No price history found for ${symbol}. Check the ticker (US listings only).`);
  return summarizeBars(symbol, range, barsFromChart(chart), chart);
}
