/**
 * The daily-bar engine. Pure: strategy + config + market data in, result out.
 *
 * Timing, the one rule everything follows:
 *   - Conditions are read on the close of day t, with data up to and including
 *     day t (and any release published on day t, after-hours included).
 *   - Orders from those signals fill at the open of day t+1. Exits first, then
 *     rebalancing, then entries in universe order while position slots last.
 *   - Stop loss and take profit are resting orders: they fill during the day
 *     at the stop/target level, or at the open when the price gaps through it.
 *     When one bar touches both, the stop is assumed to fill first.
 *   - Positions still open on the last day are closed at that day's close.
 *
 * Prices are split- and dividend-adjusted, so dividends count as reinvested.
 * Shares are fractional. Slippage moves every fill against the trade; the
 * commission is a share of each fill's notional.
 */

import type { Bar, EarningsEvent, MarketData, RippleSignal } from "./data/types";
import { ema, gapPct, nDayReturn, priorExtreme, rsi, sma } from "./indicators";
import { cagrPct, curveMetrics, type CurveMetrics } from "./metrics";
import { BENCHMARK, type Condition, type RunConfig, type Strategy } from "./schema";

export type ExitReason = "signal" | "stop_loss" | "take_profit" | "max_holding" | "end";

export type Trade = {
  ticker: string;
  entryDate: string;
  /** Average fill price paid on entry, after slippage. */
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  /** Shares held when the position was closed. */
  shares: number;
  /** Cash put in (entry and rebalancing buys, commissions included). */
  cost: number;
  /** Cash taken out (sells, commissions deducted). */
  proceeds: number;
  pnl: number;
  returnPct: number;
  sessionsHeld: number;
  exitReason: ExitReason;
};

export type EquityPoint = {
  date: string;
  strategy: number;
  benchmark: number;
  /** Share of equity in positions at the close, 0 to 1. */
  invested: number;
};

export type StrategyMetrics = CurveMetrics & {
  tradeCount: number;
  winRatePct: number | null;
  avgTradeReturnPct: number | null;
  avgSessionsHeld: number | null;
  /** Share of sessions with at least one position open at the close, percent. */
  exposurePct: number;
  /** Entry signals not taken because every position slot was full or cash ran out. */
  skippedEntries: number;
};

export type BacktestResult = {
  strategy: Strategy;
  config: RunConfig;
  /** First and last trading day actually simulated (the calendar is SPY's). */
  period: { start: string; end: string; sessions: number };
  equity: EquityPoint[];
  trades: Trade[];
  metrics: {
    strategy: StrategyMetrics;
    benchmark: CurveMetrics;
    vsBenchmark: { excessTotalReturnPct: number; excessAnnualizedReturnPct: number | null };
  };
  benchmark: { ticker: string; method: string };
  sources: MarketData["sources"];
  warnings: string[];
  assumptions: string[];
  caveats: string[];
};

export const ASSUMPTIONS = [
  "Signals are read on each day's close; orders fill at the next day's open.",
  "Stop loss and take profit fill during the day at their level, or at the open if the price gaps past it. If one day touches both, the stop is assumed first.",
  "Prices are adjusted for splits and dividends, so dividends are treated as reinvested.",
  "Shares are fractional. Slippage and commission apply to every fill.",
  "Sharpe uses daily returns and a 0% risk-free rate.",
  "The SPY benchmark is held from the first day's close to the last day's close, with the same costs.",
  "Earnings releases and Sightings count as known at the end of the day they are published, so the earliest entry is the next open.",
];

export const CAVEATS = [
  "Survivorship bias: the price source only lists companies that trade today. Delisted, merged and bankrupt names are missing, which tends to flatter results for lists of stocks picked today.",
  "Past results describe what a rule set would have done on historical data. They are not a forecast.",
  "Earnings history: Yahoo's archive of past releases can miss quarters, mainly in the most recent year.",
];

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

type Series = {
  bars: Bar[];
  dates: string[];
  index: Map<string, number>;
  opens: number[];
  closes: number[];
  cache: Map<string, number[]>;
};

function makeSeries(bars: Bar[]): Series {
  return {
    bars,
    dates: bars.map((b) => b.date),
    index: new Map(bars.map((b, i) => [b.date, i])),
    opens: bars.map((b) => b.open),
    closes: bars.map((b) => b.close),
    cache: new Map(),
  };
}

function cached(s: Series, key: string, make: () => number[]): number[] {
  let v = s.cache.get(key);
  if (!v) {
    v = make();
    s.cache.set(key, v);
  }
  return v;
}

function maSeries(s: Series, kind: "sma" | "ema", period: number): number[] {
  return cached(s, `${kind}:${period}`, () => (kind === "sma" ? sma(s.closes, period) : ema(s.closes, period)));
}

function compare(op: "above" | "below" | "crosses_above" | "crosses_below", v: number[], r: number[] | number, j: number): boolean {
  const ref = (k: number) => (typeof r === "number" ? r : r[k]!);
  const now = v[j]!;
  const refNow = ref(j);
  if (Number.isNaN(now) || Number.isNaN(refNow)) return false;
  if (op === "above") return now > refNow;
  if (op === "below") return now < refNow;
  if (j < 1) return false;
  const prev = v[j - 1]!;
  const refPrev = ref(j - 1);
  if (Number.isNaN(prev) || Number.isNaN(refPrev)) return false;
  return op === "crosses_above" ? prev <= refPrev && now > refNow : prev >= refPrev && now < refNow;
}

/** First index with dates[i] >= day. */
function lowerBound(dates: readonly string[], day: string): number {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The session dates on which an event-window condition is true for one ticker:
 * the session `daysAfter - 1` sessions after the first session on or after the
 * publication date. Signal on that close, fill on the next open, so
 * daysAfter = 1 buys at the first open after the news.
 */
export function eventFireDates(dates: readonly string[], eventDates: readonly string[], daysAfter: number): Set<string> {
  const out = new Set<string>();
  for (const day of eventDates) {
    const k = lowerBound(dates, day);
    const fire = k + daysAfter - 1;
    if (fire < dates.length) out.add(dates[fire]!);
  }
  return out;
}

function surpriseMatches(e: EarningsEvent, op: "above" | "below", pct: number): boolean {
  if (e.surprisePct === null || !Number.isFinite(e.surprisePct)) return false;
  return op === "above" ? e.surprisePct > pct : e.surprisePct < pct;
}

function rippleMatches(r: RippleSignal, c: Extract<Condition, { type: "ripple_event" }>): boolean {
  if (c.relation && r.relation !== c.relation) return false;
  if (c.direction && r.direction !== c.direction) return false;
  if (c.minConfidence && CONFIDENCE_RANK[r.confidence] < CONFIDENCE_RANK[c.minConfidence]) return false;
  if (c.maxDegree && r.degree > c.maxDegree) return false;
  return true;
}

class Evaluator {
  private eventCache = new Map<Condition, Map<string, Set<string>>>();

  constructor(
    private series: Map<string, Series>,
    private data: MarketData,
  ) {}

  private eventDates(c: Condition, ticker: string): Set<string> {
    let perTicker = this.eventCache.get(c);
    if (!perTicker) {
      perTicker = new Map();
      this.eventCache.set(c, perTicker);
    }
    let set = perTicker.get(ticker);
    if (set) return set;
    const s = this.series.get(ticker);
    if (!s) set = new Set();
    else if (c.type === "earnings_surprise") {
      // Another company's releases (c.ticker) or the traded ticker's own.
      const days = (this.data.earnings[c.ticker ?? ticker] ?? []).filter((e) => surpriseMatches(e, c.op, c.pct)).map((e) => e.date);
      set = eventFireDates(s.dates, days, c.daysAfter);
    } else if (c.type === "ripple_event") {
      const days = this.data.ripple.filter((r) => r.ticker === ticker && rippleMatches(r, c)).map((r) => r.date);
      set = eventFireDates(s.dates, days, c.daysAfter);
    } else set = new Set();
    perTicker.set(ticker, set);
    return set;
  }

  /** Is `c` true on the close of `date`, for a position in `ticker`? */
  test(c: Condition, ticker: string, date: string): boolean {
    if (c.type === "earnings_surprise" || c.type === "ripple_event") return this.eventDates(c, ticker).has(date);
    const s = this.series.get(c.ticker ?? ticker);
    if (!s) return false;
    const j = s.index.get(date);
    if (j === undefined) return false;
    switch (c.type) {
      case "price_vs_ma":
        return compare(c.op, s.closes, maSeries(s, c.ma, c.period), j);
      case "ma_cross":
        return compare(c.op, maSeries(s, c.fastMa, c.fastPeriod), maSeries(s, c.slowMa, c.slowPeriod), j);
      case "rsi":
        return compare(c.op, cached(s, `rsi:${c.period}`, () => rsi(s.closes, c.period)), c.value, j);
      case "n_day_return": {
        const v = cached(s, `ret:${c.days}`, () => nDayReturn(s.closes, c.days))[j]!;
        return Number.isFinite(v) && (c.op === "above" ? v > c.pct : v < c.pct);
      }
      case "gap": {
        const v = cached(s, "gap", () => gapPct(s.opens, s.closes))[j]!;
        return Number.isFinite(v) && (c.op === "above" ? v > c.pct : v < c.pct);
      }
      case "breakout": {
        const kind = c.op === "new_high" ? "max" : "min";
        const ext = cached(s, `ext:${kind}:${c.days}`, () => priorExtreme(s.closes, c.days, kind))[j]!;
        if (!Number.isFinite(ext)) return false;
        return c.op === "new_high" ? s.closes[j]! > ext : s.closes[j]! < ext;
      }
    }
  }
}

type Position = {
  ticker: string;
  shares: number;
  entryIdx: number;
  entryDate: string;
  entryPrice: number;
  cost: number;
  proceeds: number;
  lastPrice: number;
};

function periodKey(date: string, rebalance: "weekly" | "monthly"): string {
  if (rebalance === "monthly") return date.slice(0, 7);
  // ISO-ish week bucket: days since a Monday epoch, floor-divided by 7.
  const days = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000) + 3; // 1970-01-01 was a Thursday
  return String(Math.floor(days / 7));
}

export function runBacktest(strategy: Strategy, config: RunConfig, data: MarketData): BacktestResult {
  const warnings = [...data.warnings];
  const calendar = data.benchmark.filter((b) => b.date >= config.start && b.date <= config.end);
  if (calendar.length < 2) throw new Error(`No ${BENCHMARK} trading days between ${config.start} and ${config.end}.`);
  const dates = calendar.map((b) => b.date);
  const n = dates.length;

  const series = new Map<string, Series>();
  for (const [t, bars] of Object.entries(data.bars)) if (bars.length) series.set(t, makeSeries(bars));
  if (!series.has(BENCHMARK)) series.set(BENCHMARK, makeSeries(data.benchmark));
  const universe = strategy.universe.filter((t) => {
    const s = series.get(t);
    const inWindow = s ? s.dates.some((d) => d >= config.start && d <= config.end) : false;
    if (!inWindow) warnings.push(`${t}: no price data in the test window, left out.`);
    return inWindow;
  });

  for (const c of [...strategy.entry.conditions, ...strategy.exit.conditions]) {
    if ("ticker" in c && c.ticker && !series.has(c.ticker) && !warnings.some((w) => w.startsWith(`${c.ticker}:`))) {
      warnings.push(`${c.ticker}: no price data, so conditions read on it are never true.`);
    }
  }

  const ev = new Evaluator(series, data);
  const slip = config.slippageBps / 10_000;
  const comm = config.commissionBps / 10_000;
  const weight = strategy.sizing.positionPct !== null ? strategy.sizing.positionPct / 100 : 1 / strategy.sizing.maxPositions;
  const { stopLossPct, takeProfitPct, maxHoldingDays } = strategy.exit;

  const barAt = (t: string, date: string): Bar | undefined => {
    const s = series.get(t);
    const j = s?.index.get(date);
    return j === undefined ? undefined : s!.bars[j];
  };

  let cash = config.initialCapital;
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  let pendingExits = new Map<string, ExitReason>();
  let pendingEntries: string[] = [];
  let pendingRebalance = false;
  let skippedEntries = 0;
  let sessionsInvested = 0;

  const buy = (pos: Position, alloc: number, rawPrice: number) => {
    const px = rawPrice * (1 + slip);
    const notional = alloc / (1 + comm);
    const shares = notional / px;
    const before = pos.shares;
    pos.entryPrice = before > 0 ? (pos.entryPrice * before + px * shares) / (before + shares) : px;
    pos.shares += shares;
    pos.cost += alloc;
    cash -= alloc;
  };
  const sell = (pos: Position, shares: number, rawPrice: number): number => {
    const px = rawPrice * (1 - slip);
    const net = shares * px * (1 - comm);
    pos.shares -= shares;
    pos.proceeds += net;
    cash += net;
    return px;
  };
  const close = (pos: Position, rawPrice: number, i: number, reason: ExitReason, sessionsHeld: number) => {
    const shares = pos.shares;
    const px = sell(pos, shares, rawPrice);
    const pnl = pos.proceeds - pos.cost;
    trades.push({
      ticker: pos.ticker,
      entryDate: pos.entryDate,
      entryPrice: pos.entryPrice,
      exitDate: dates[i]!,
      exitPrice: px,
      shares,
      cost: pos.cost,
      proceeds: pos.proceeds,
      pnl,
      returnPct: pos.cost > 0 ? (pnl / pos.cost) * 100 : 0,
      sessionsHeld,
      exitReason: reason,
    });
    positions.delete(pos.ticker);
  };
  const equityAtOpen = (date: string) => {
    let v = cash;
    positions.forEach((p) => {
      v += p.shares * (barAt(p.ticker, date)?.open ?? p.lastPrice);
    });
    return v;
  };

  for (let i = 0; i < n; i++) {
    const date = dates[i]!;

    // 1. The open: fill yesterday's orders.
    if (i > 0) {
      const stillPending = new Map<string, ExitReason>();
      pendingExits.forEach((reason, t) => {
        const pos = positions.get(t);
        if (!pos) return;
        const bar = barAt(t, date);
        if (!bar) {
          stillPending.set(t, reason); // no session for this ticker today: try the next one
          return;
        }
        close(pos, bar.open, i, reason, i - pos.entryIdx);
      });
      pendingExits = stillPending;

      if (pendingRebalance && positions.size) {
        const eq = equityAtOpen(date);
        const target = weight * eq;
        const moves: { pos: Position; diff: number; open: number }[] = [];
        positions.forEach((pos) => {
          const bar = barAt(pos.ticker, date);
          if (!bar || pendingExits.has(pos.ticker)) return;
          const diff = target - pos.shares * bar.open;
          if (Math.abs(diff) > eq * 0.0025) moves.push({ pos, diff, open: bar.open });
        });
        for (const m of moves) if (m.diff < 0) sell(m.pos, Math.min(m.pos.shares, -m.diff / m.open), m.open);
        for (const m of moves) if (m.diff > 0 && cash > 0) buy(m.pos, Math.min(m.diff, cash), m.open);
      }
      pendingRebalance = false;

      if (pendingEntries.length) {
        const eq = equityAtOpen(date);
        for (const t of pendingEntries) {
          const bar = barAt(t, date);
          if (!bar || positions.has(t)) continue;
          const alloc = Math.min(weight * eq, cash);
          if (positions.size >= strategy.sizing.maxPositions || alloc < eq * 0.001) {
            skippedEntries++;
            continue;
          }
          const pos: Position = {
            ticker: t,
            shares: 0,
            entryIdx: i,
            entryDate: date,
            entryPrice: 0,
            cost: 0,
            proceeds: 0,
            lastPrice: bar.open,
          };
          positions.set(t, pos);
          buy(pos, alloc, bar.open);
        }
      }
      pendingEntries = [];
    }

    // 2. During the day: resting stop loss and take profit orders.
    if (stopLossPct !== null || takeProfitPct !== null) {
      positions.forEach((pos) => {
        const bar = barAt(pos.ticker, date);
        if (!bar) return;
        const stop = stopLossPct !== null ? pos.entryPrice * (1 - stopLossPct / 100) : null;
        const target = takeProfitPct !== null ? pos.entryPrice * (1 + takeProfitPct / 100) : null;
        const enteredToday = pos.entryIdx === i;
        // A position bought at today's open cannot be filled by today's opening print a second time.
        if (!enteredToday && stop !== null && bar.open <= stop) return close(pos, bar.open, i, "stop_loss", i - pos.entryIdx + 1);
        if (!enteredToday && target !== null && bar.open >= target) return close(pos, bar.open, i, "take_profit", i - pos.entryIdx + 1);
        if (stop !== null && bar.low <= stop) return close(pos, stop, i, "stop_loss", i - pos.entryIdx + 1);
        if (target !== null && bar.high >= target) return close(pos, target, i, "take_profit", i - pos.entryIdx + 1);
      });
    }

    // 3. The close: mark to market.
    let invested = 0;
    positions.forEach((pos) => {
      const bar = barAt(pos.ticker, date);
      if (bar) pos.lastPrice = bar.close;
      invested += pos.shares * pos.lastPrice;
    });

    if (i === n - 1) {
      positions.forEach((pos) => close(pos, pos.lastPrice, i, "end", i - pos.entryIdx + 1));
      equity.push({ date, strategy: cash, benchmark: 0, invested: 0 });
      if (invested > 0) sessionsInvested++;
      break;
    }

    const value = cash + invested;
    equity.push({ date, strategy: value, benchmark: 0, invested: value > 0 ? invested / value : 0 });
    if (invested > 0) sessionsInvested++;

    // 4. Signals on the close, for tomorrow's open.
    positions.forEach((pos) => {
      if (maxHoldingDays !== null && i - pos.entryIdx + 1 >= maxHoldingDays) pendingExits.set(pos.ticker, "max_holding");
      else if (strategy.exit.conditions.some((c) => ev.test(c, pos.ticker, date))) pendingExits.set(pos.ticker, "signal");
    });
    const { mode, conditions } = strategy.entry;
    for (const t of universe) {
      if (positions.has(t)) continue;
      const hit = mode === "all" ? conditions.every((c) => ev.test(c, t, date)) : conditions.some((c) => ev.test(c, t, date));
      if (hit) pendingEntries.push(t);
    }
    if (strategy.rebalance !== "none" && positions.size) {
      pendingRebalance = periodKey(date, strategy.rebalance) !== periodKey(dates[i + 1]!, strategy.rebalance);
    }
  }

  // SPY buy-and-hold on the same calendar and the same costs.
  const first = calendar[0]!;
  const spyShares = (config.initialCapital / (1 + comm)) / (first.close * (1 + slip));
  for (let i = 0; i < n; i++) {
    const c = calendar[i]!.close;
    equity[i]!.benchmark = i === n - 1 ? spyShares * c * (1 - slip) * (1 - comm) : spyShares * c;
  }

  const sValues = equity.map((p) => p.strategy);
  const bValues = equity.map((p) => p.benchmark);
  const sCurve = curveMetrics(sValues, dates);
  const bCurve = curveMetrics(bValues, dates);
  // Both curves are measured from the capital put in, so entry costs count.
  for (const c of [sCurve, bCurve]) {
    c.startValue = config.initialCapital;
    c.totalReturnPct = (c.endValue / config.initialCapital - 1) * 100;
    c.annualizedReturnPct = cagrPct(config.initialCapital, c.endValue, dates[0]!, dates[n - 1]!);
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const metrics: StrategyMetrics = {
    ...sCurve,
    tradeCount: trades.length,
    winRatePct: trades.length ? (wins / trades.length) * 100 : null,
    avgTradeReturnPct: trades.length ? trades.reduce((a, t) => a + t.returnPct, 0) / trades.length : null,
    avgSessionsHeld: trades.length ? trades.reduce((a, t) => a + t.sessionsHeld, 0) / trades.length : null,
    exposurePct: (sessionsInvested / n) * 100,
    skippedEntries,
  };

  const usesEarnings = [...strategy.entry.conditions, ...strategy.exit.conditions].some((c) => c.type === "earnings_surprise");
  const usesRipple = [...strategy.entry.conditions, ...strategy.exit.conditions].some((c) => c.type === "ripple_event");
  if (usesRipple && data.ripple.length === 0) {
    warnings.push("No Sightings history is connected yet, so Sighting conditions never fire in this run.");
  }
  if (usesEarnings && trades.length === 0) warnings.push("No earnings releases matched the rules in this window.");
  if (skippedEntries > 0) {
    warnings.push(`${skippedEntries} entry signals were not taken because every position slot was in use or cash ran out.`);
  }

  return {
    strategy,
    config,
    period: { start: dates[0]!, end: dates[n - 1]!, sessions: n },
    equity,
    trades,
    metrics: {
      strategy: metrics,
      benchmark: bCurve,
      vsBenchmark: {
        excessTotalReturnPct: metrics.totalReturnPct - bCurve.totalReturnPct,
        excessAnnualizedReturnPct:
          metrics.annualizedReturnPct !== null && bCurve.annualizedReturnPct !== null
            ? metrics.annualizedReturnPct - bCurve.annualizedReturnPct
            : null,
      },
    },
    benchmark: { ticker: BENCHMARK, method: "buy and hold, adjusted closes" },
    sources: data.sources,
    warnings,
    assumptions: ASSUMPTIONS,
    caveats: CAVEATS,
  };
}
