/**
 * Live quantitative state (§3): recomputed daily after close from adjusted
 * daily bars, refreshed intraday with a fresh quote whenever a message is
 * emitted. Pure functions over already-fetched series — no I/O here.
 */

import { addTradingDays, classifySession, nyYmd } from "./calendar.js";
import type { TrackerConfig } from "./config.js";
import {
  driftScore,
  earningsRhythm,
  gapVol,
  median,
  olsBeta,
  overnightGaps,
  robustVol,
  simpleReturns,
  trailingReturn,
  week52Context,
  zScore,
} from "./math.js";
import type { QuantContext, DailyBar, TickerState } from "./types.js";

export type QuoteLike = {
  price: number;
  asof: string;
  session: QuantContext["session"];
  intradayVolume: number | null;
};

/** Align two bar series on shared trading dates (beta needs paired returns). */
export function alignBars(
  tickerBars: DailyBar[],
  benchBars: DailyBar[],
): { ticker: DailyBar[]; bench: DailyBar[] } {
  const benchByDay = new Map(benchBars.map((b) => [b.d, b]));
  const ticker: DailyBar[] = [];
  const bench: DailyBar[] = [];
  for (const bar of tickerBars) {
    const match = benchByDay.get(bar.d);
    if (!match) continue;
    ticker.push(bar);
    bench.push(match);
  }
  return { ticker, bench };
}

/**
 * Volume baseline = median of the last 20 daily volumes (§5.2).
 *
 * §6 volume-baseline guard: when a split falls in range and the source does
 * not guarantee adjusted volume, pre-split days are on a different share basis
 * and cannot be mixed in, so the baseline is recomputed from post-split days
 * alone. Until 20 of those exist the window is not covered and the result is
 * null (§3.11) — which disables volume_anomaly rather than comparing today
 * against a baseline that straddles the split.
 */
export function volumeBaseline(
  bars: DailyBar[],
  window = 20,
  splitDate?: string | null,
): number | null {
  const usable = splitDate ? bars.filter((b) => b.d >= splitDate) : bars;
  if (usable.length < window) return null;
  const volumes = usable.slice(-window).map((b) => b.v).filter((v) => v > 0);
  if (volumes.length < window) return null;
  return median(volumes);
}

/**
 * True when the latest bar already covers the day the live price is in — i.e.
 * the bar and the quote describe the same session, so the previous close is
 * the bar before it. Also true when there is no quote at all: the latest bar
 * is then itself "today".
 */
function coversSameDay(quoteDay: string | null, lastBar: DailyBar | null): boolean {
  if (!lastBar) return false;
  if (quoteDay == null) return true;
  return quoteDay === lastBar.d;
}

export type QuantInputs = {
  state: TickerState;
  benchBars: DailyBar[];
  config: TrackerConfig;
  now: Date;
  quote?: QuoteLike | null;
  benchQuote?: QuoteLike | null;
  splitDate?: string | null;
  /**
   * True when the inputs describe a session that has already closed (the
   * close-run). The volume then comes from a finished daily bar, so it is a
   * full-day figure and must not be flagged partial, and the session label
   * describes the measured day rather than the wall clock.
   */
  asOfCompletedSession?: boolean;
};

/**
 * Build the §4 quant_context block. Every statistic whose window is not fully
 * covered is null (§3.11) — the caller must treat null as "not computable".
 */
export function computeQuantContext(inputs: QuantInputs): QuantContext {
  const { state, benchBars, config, now, quote, benchQuote, splitDate } = inputs;
  const completed = inputs.asOfCompletedSession === true;
  const w = config.windows;

  const aligned = alignBars(state.bars, benchBars);
  const tickerCloses = aligned.ticker.map((b) => b.c);
  const benchCloses = aligned.bench.map((b) => b.c);
  const tickerReturns = simpleReturns(tickerCloses);
  const benchReturns = simpleReturns(benchCloses);

  const regression = olsBeta(tickerReturns, benchReturns, w.betaDays);
  const beta90 = regression?.beta ?? null;
  const r2 = regression?.r2 ?? null;

  const vol30 = robustVol(tickerReturns, w.volShortDays);
  const vol90 = robustVol(tickerReturns, w.volLongDays);
  const volRegime = vol30 != null && vol90 != null && vol90 !== 0 ? vol30 / vol90 : null;

  const lastBar = state.bars[state.bars.length - 1] ?? null;
  const prevBar = state.bars[state.bars.length - 2] ?? null;

  // Intraday refresh: quote price against the prior session's close.
  // After close (no fresh quote), today's bar close against yesterday's.
  const session = completed ? "closed" : (quote?.session ?? classifySession(now).session);
  const lastPrice = quote?.price ?? lastBar?.c ?? null;
  const priceAsof = quote?.asof ?? (lastBar ? `${lastBar.d}T20:00:00.000Z` : null);
  const quoteDay = quote ? nyYmd(new Date(quote.asof)) : null;
  // The baseline is the close of the session before the one `lastPrice` is in.
  // With no quote, `lastPrice` is the latest bar's close, so the baseline is
  // the bar before it — comparing the latest bar against itself would report a
  // 0% move and silently disable every close-run detector.
  const prevClose = coversSameDay(quoteDay, lastBar) ? (prevBar?.c ?? null) : (lastBar?.c ?? null);

  const moveToday =
    lastPrice != null && prevClose != null && prevClose !== 0 ? lastPrice / prevClose - 1 : null;

  const benchLast = benchBars[benchBars.length - 1] ?? null;
  const benchPrev = benchBars[benchBars.length - 2] ?? null;
  const benchQuoteDay = benchQuote ? nyYmd(new Date(benchQuote.asof)) : null;
  const benchPrevClose = coversSameDay(benchQuoteDay, benchLast)
    ? (benchPrev?.c ?? null)
    : (benchLast?.c ?? null);
  const benchPrice = benchQuote?.price ?? benchLast?.c ?? null;
  const benchMove =
    benchPrice != null && benchPrevClose != null && benchPrevClose !== 0
      ? benchPrice / benchPrevClose - 1
      : null;

  const residualMove =
    moveToday != null && beta90 != null && benchMove != null
      ? moveToday - beta90 * benchMove
      : null;

  const volumeBase = volumeBaseline(state.bars, 20, splitDate);
  const intradayVolume = quote?.intradayVolume ?? null;
  const todaysVolume =
    intradayVolume != null
      ? intradayVolume
      : lastBar && quoteDay === lastBar.d
        ? lastBar.v
        : (lastBar?.v ?? null);
  const volumeRatio =
    todaysVolume != null && volumeBase != null && volumeBase > 0 ? todaysVolume / volumeBase : null;
  const volumeRatioPartial = completed ? false : session === "regular" || session === "pre";

  const w52 = week52Context(tickerCloses, w.week52Days);

  return {
    beta_90d: beta90,
    r_squared: r2,
    daily_vol_30d: vol30,
    vol_regime: volRegime,
    move_today: moveToday,
    move_zscore: zScore(moveToday, vol30),
    residual_move: residualMove,
    residual_zscore: zScore(residualMove, regression?.residualRobustStd ?? null),
    volume_ratio: volumeRatio,
    volume_ratio_partial: volumeRatioPartial,
    momentum_5d: trailingReturn(tickerCloses, 5),
    momentum_20d: trailingReturn(tickerCloses, 20),
    momentum_60d: trailingReturn(tickerCloses, 60),
    pct_from_52w_high: w52?.pctFromHigh ?? null,
    pct_from_52w_low: w52?.pctFromLow ?? null,
    earnings_rhythm: computeEarningsRhythm(state, config),
    prev_close: prevClose,
    last_price: lastPrice,
    price_asof: priceAsof,
    session,
  };
}

/** §3.8 — mean |1-day move| over the last N earnings dates. */
export function computeEarningsRhythm(state: TickerState, config: TrackerConfig): number | null {
  const byDay = new Map(state.bars.map((b) => [b.d, b]));
  const days = state.bars.map((b) => b.d);
  const moves: number[] = [];
  const recent = state.earnings.slice(-config.windows.earningsHistoryCount);
  for (const earning of recent) {
    // "amc" (after market close) prints move the NEXT session.
    const reactionDay =
      earning.hour === "amc" ? nextAvailableDay(days, earning.date) : nearestDay(days, earning.date);
    if (!reactionDay) continue;
    const idx = days.indexOf(reactionDay);
    if (idx <= 0) continue;
    const bar = byDay.get(reactionDay);
    const prev = byDay.get(days[idx - 1]);
    if (!bar || !prev || prev.c === 0) continue;
    moves.push(Math.abs(bar.c / prev.c - 1));
  }
  return earningsRhythm(moves);
}

function nearestDay(days: string[], target: string): string | null {
  if (days.includes(target)) return target;
  return nextAvailableDay(days, target);
}

function nextAvailableDay(days: string[], target: string): string | null {
  for (const d of days) if (d > target) return d;
  return null;
}

/** §5.1 — gap statistics from the bar series. */
export function computeGapStats(
  bars: DailyBar[],
  config: TrackerConfig,
): { gapPct: number; gapZ: number; prevClose: number; open: number } | null {
  if (bars.length < 2) return null;
  const gaps = overnightGaps(bars);
  const scale = gapVol(gaps, config.windows.gapDays);
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (prev.c === 0) return null;
  const gapPct = last.o / prev.c - 1;
  const z = zScore(gapPct, scale);
  if (z == null) return null;
  return { gapPct, gapZ: z, prevClose: prev.c, open: last.o };
}

/** §5.6 — drift score from the quant context. */
export function computeDriftZ(quant: QuantContext): number | null {
  return driftScore(quant.momentum_5d, quant.daily_vol_30d);
}

/** §4 — context_flags: within ±1 trading day of an earnings date. */
export function computeContextFlags(state: TickerState, todayYmd: string): Array<"earnings_window"> {
  const window = new Set<string>();
  const dates = [
    ...state.earnings.map((e) => e.date),
    ...state.scheduledEarnings.map((e) => e.dueAt.slice(0, 10)),
  ];
  for (const date of dates) {
    if (!date) continue;
    window.add(date);
    try {
      window.add(addTradingDays(date, 1));
      window.add(addTradingDays(date, -1));
    } catch {
      /* malformed date — skip */
    }
  }
  return window.has(todayYmd) ? ["earnings_window"] : [];
}
