/**
 * Series views (spec §10.1) — pure functions turning Tracker's persisted
 * daily bars into what the patterns read: per-session volume ratios and
 * residual z-scores, plus the scan-session statistics (β, r², vol, regime,
 * momentum, range, 52w context). Built with Tracker's own math so the numbers
 * agree with the Tracker/Gauge panels; nothing here is fetched or stored.
 *
 * No-lookahead rule: `completedBars` drops every bar dated after the scan
 * session, so an intraday/partial bar the provider may return for today never
 * enters a pattern window.
 */

import { median, olsBeta, robustVol, simpleReturns, trailingReturn, week52Context } from "../tracker/math.js";
import { alignBars } from "../tracker/quant.js";
import type { DailyBar } from "../tracker/types.js";
import type { ScreenWindows } from "./config.js";
import type { ScreenSeriesView, ScreenSessionView } from "./types.js";

/** Sorted, de-duplicated bars up to and including the scan session (the no-lookahead cut). */
export function completedBars(bars: DailyBar[], session: string): DailyBar[] {
  const byDay = new Map<string, DailyBar>();
  for (const bar of bars) {
    if (!bar || typeof bar.d !== "string" || bar.d > session) continue;
    if (!Number.isFinite(bar.c) || !Number.isFinite(bar.v)) continue;
    byDay.set(bar.d, bar);
  }
  return [...byDay.values()].sort((a, b) => a.d.localeCompare(b.d));
}

/**
 * Volume baseline for the bar at `index`: median of the `window` prior
 * sessions' volumes (no self-inclusion — the session is measured against the
 * tape before it). Null when fewer than `window` prior sessions exist or any
 * of them has no volume.
 */
export function priorVolumeBaseline(bars: DailyBar[], index: number, window: number): number | null {
  if (index < window) return null;
  const volumes = bars.slice(index - window, index).map((b) => b.v);
  if (volumes.some((v) => !(v > 0))) return null;
  return median(volumes);
}

/**
 * Residual move + z for the aligned session at `index` (Tracker's definition:
 * move − β·bench_move, scaled by the robust std of the regression residuals,
 * with β from the `window` returns ending at that session).
 */
export function residualAt(
  tickerReturns: number[],
  benchReturns: number[],
  returnIndex: number,
  window: number,
): { residual_move: number; residual_z: number | null; beta: number; r2: number } | null {
  if (returnIndex < 0 || returnIndex >= tickerReturns.length || returnIndex >= benchReturns.length) return null;
  const y = tickerReturns.slice(0, returnIndex + 1);
  const x = benchReturns.slice(0, returnIndex + 1);
  const reg = olsBeta(y, x, window);
  if (!reg) return null;
  const residual = tickerReturns[returnIndex] - reg.beta * benchReturns[returnIndex];
  const scale = reg.residualRobustStd;
  const z = scale != null && scale > 0 && Number.isFinite(scale) ? residual / scale : null;
  return { residual_move: residual, residual_z: z, beta: reg.beta, r2: reg.r2 };
}

export type SeriesViewInput = {
  ticker: string;
  bars: DailyBar[];
  benchBars: DailyBar[];
  /** Completed trading session the scan describes (bars after it are dropped). */
  session: string;
  windows: ScreenWindows;
};

/** Build the full view for one ticker as of the scan session. */
export function buildSeriesView(input: SeriesViewInput): ScreenSeriesView {
  const w = input.windows;
  const own = completedBars(input.bars, input.session);
  const bench = completedBars(input.benchBars, input.session);
  const aligned = alignBars(own, bench);
  const bars = aligned.ticker;
  const benchAligned = aligned.bench;
  const n = bars.length;

  const empty: ScreenSeriesView = {
    ticker: input.ticker,
    as_of: own.length > 0 ? own[own.length - 1].d : null,
    history_sessions: n,
    sessions: [],
    beta: null,
    r2: null,
    daily_vol: null,
    vol_regime: null,
    momentum_5d: null,
    momentum_20d: null,
    range_10s: null,
    pct_from_52w_high: null,
    pct_from_52w_low: null,
  };
  if (n === 0) return empty;

  const closes = bars.map((b) => b.c);
  const benchCloses = benchAligned.map((b) => b.c);
  const returns = simpleReturns(closes);
  const benchReturns = simpleReturns(benchCloses);
  // simpleReturns skips degenerate pairs; the indices only line up when none were skipped.
  const returnsAligned = returns.length === n - 1 && benchReturns.length === n - 1;

  const sessions: ScreenSessionView[] = [];
  const first = Math.max(0, n - w.sessions);
  for (let i = first; i < n; i++) {
    const bar = bars[i];
    const ret = returnsAligned && i >= 1 ? returns[i - 1] : null;
    const benchRet = returnsAligned && i >= 1 ? benchReturns[i - 1] : null;
    const baseline = priorVolumeBaseline(bars, i, w.volumeBaselineSessions);
    const volumeRatio = baseline != null && baseline > 0 && bar.v > 0 ? bar.v / baseline : null;
    const res = returnsAligned && i >= 1 ? residualAt(returns, benchReturns, i - 1, w.betaSessions) : null;
    sessions.push({
      d: bar.d,
      close: bar.c,
      volume: bar.v,
      ret,
      bench_ret: benchRet,
      volume_ratio: volumeRatio,
      residual_move: res?.residual_move ?? null,
      residual_z: res?.residual_z ?? null,
    });
  }

  const reg = returnsAligned ? olsBeta(returns, benchReturns, w.betaSessions) : null;
  const vol30 = robustVol(returns, w.volShortSessions);
  const vol90 = robustVol(returns, w.volLongSessions);
  const volRegime = vol30 != null && vol90 != null && vol90 > 0 ? vol30 / vol90 : null;

  let range: number | null = null;
  if (n >= w.compressionRangeSessions) {
    const slice = bars.slice(-w.compressionRangeSessions);
    const hi = Math.max(...slice.map((b) => b.h));
    const lo = Math.min(...slice.map((b) => b.l));
    const last = closes[n - 1];
    range = Number.isFinite(hi) && Number.isFinite(lo) && last > 0 ? (hi - lo) / last : null;
  }

  const w52 = week52Context(closes, w.week52Sessions);

  return {
    ...empty,
    as_of: bars[n - 1].d,
    sessions,
    beta: reg?.beta ?? null,
    r2: reg?.r2 ?? null,
    daily_vol: vol30,
    vol_regime: volRegime,
    momentum_5d: trailingReturn(closes, w.momentumShort),
    momentum_20d: trailingReturn(closes, w.momentumLong),
    range_10s: range,
    pct_from_52w_high: w52?.pctFromHigh ?? null,
    pct_from_52w_low: w52?.pctFromLow ?? null,
  };
}
