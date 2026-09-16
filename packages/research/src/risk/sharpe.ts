/**
 * §3.6 Sharpe — return per unit of volatility, for the book as it is held now.
 *
 * The other five components describe what the portfolio *is* (how concentrated,
 * how levered to the market, how linked, what is happening to it). This one
 * describes what its volatility has actually bought: the same daily swing is a
 * different posture when it has been paid for and when it has not.
 *
 * How it is computed, and what that does and does not mean:
 *   * Current weights are applied to each held ticker's own history — the
 *     standard "this allocation, run backwards" measure. It is NOT the return
 *     the reader earned (they did not hold these weights for 90 sessions), and
 *     it is not a forecast. It is a property of the allocation, measured on
 *     real closes.
 *   * Only sessions every included ticker traded are used, so one name's gap
 *     cannot invent a move in the portfolio series.
 *   * Plain sample standard deviation, not the Tracker's robust MAD vol: the
 *     Sharpe ratio is defined on the ordinary deviation, and a robust estimator
 *     would quietly discard exactly the outlier days the number is about. §3.3
 *     keeps the robust one, because there it is a tail measure.
 *   * The risk-free rate is a config constant (no rate feed exists here), so it
 *     travels in the payload where it can be seen and argued with.
 */

export type RiskBar = { d: string; c: number };

export type AlignedReturns = {
  /** Session dates the returns are measured over (ascending). */
  dates: string[];
  /** Per-ticker daily simple returns, aligned to `dates`. */
  byTicker: Map<string, number[]>;
  /** Tickers dropped for want of usable history. */
  excluded: string[];
};

/**
 * Daily returns for `tickers`, restricted to the sessions all of them traded,
 * ending at the most recent common session and at most `window` long.
 */
export function alignReturns(bars: Record<string, RiskBar[] | undefined>, tickers: string[], window: number): AlignedReturns {
  const closes = new Map<string, Map<string, number>>();
  const excluded: string[] = [];
  for (const ticker of tickers) {
    const series = bars[ticker];
    if (!Array.isArray(series) || series.length < 2) {
      excluded.push(ticker);
      continue;
    }
    const byDate = new Map<string, number>();
    for (const bar of series) {
      if (!bar || typeof bar.d !== "string" || typeof bar.c !== "number" || !Number.isFinite(bar.c) || bar.c <= 0) continue;
      byDate.set(bar.d, bar.c);
    }
    if (byDate.size < 2) excluded.push(ticker);
    else closes.set(ticker, byDate);
  }
  if (closes.size === 0) return { dates: [], byTicker: new Map(), excluded };

  // Sessions every included ticker traded, oldest first.
  const [first, ...rest] = [...closes.values()];
  let common = [...first.keys()];
  for (const other of rest) common = common.filter((d) => other.has(d));
  common.sort();
  // window returns need window + 1 closes.
  const kept = common.slice(Math.max(0, common.length - (window + 1)));
  if (kept.length < 2) return { dates: [], byTicker: new Map(), excluded: [...excluded, ...closes.keys()] };

  const byTicker = new Map<string, number[]>();
  for (const [ticker, byDate] of closes) {
    const returns: number[] = [];
    for (let i = 1; i < kept.length; i++) {
      const prev = byDate.get(kept[i - 1])!;
      const now = byDate.get(kept[i])!;
      returns.push(now / prev - 1);
    }
    byTicker.set(ticker, returns);
  }
  return { dates: kept.slice(1), byTicker, excluded };
}

export type PortfolioSeries = {
  /** Daily portfolio returns. */
  returns: number[];
  /** Weights actually used, renormalised over the tickers with history. */
  weights: Array<{ ticker: string; weight: number }>;
};

/**
 * The book's daily return series. Weights are renormalised over the tickers
 * that have history, so dropping one name rescales the rest instead of
 * silently pricing the gap as cash. Short positions carry a negative weight.
 */
export function portfolioReturns(
  weights: Array<{ ticker: string; weight: number; side: "long" | "short" }>,
  aligned: AlignedReturns,
): PortfolioSeries {
  const usable = weights.filter((w) => aligned.byTicker.has(w.ticker) && w.weight > 0);
  const total = usable.reduce((s, w) => s + w.weight, 0);
  if (usable.length === 0 || total <= 0) return { returns: [], weights: [] };
  const scaled = usable.map((w) => ({ ticker: w.ticker, weight: (w.weight / total) * (w.side === "short" ? -1 : 1) }));
  const length = aligned.dates.length;
  const returns: number[] = [];
  for (let t = 0; t < length; t++) {
    let r = 0;
    for (const w of scaled) r += w.weight * (aligned.byTicker.get(w.ticker)![t] ?? 0);
    returns.push(r);
  }
  return { returns, weights: scaled };
}

export type SharpeResult = {
  /** Annualised Sharpe ratio; null when the window is too short or flat. */
  sharpe: number | null;
  ann_return: number;
  ann_vol: number;
  mean_daily: number;
  sd_daily: number;
  sessions: number;
};

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Sample standard deviation (n − 1); null below two observations. */
export function sampleStd(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export type SharpeOptions = {
  /** Annual risk-free rate in percent (4 = 4%/yr). */
  riskFreeAnnualPct: number;
  tradingDaysPerYear: number;
  minSessions: number;
};

export function sharpeOf(returns: number[], options: SharpeOptions): SharpeResult {
  const sessions = returns.length;
  const m = mean(returns);
  const sd = sampleStd(returns);
  const scale = Math.sqrt(options.tradingDaysPerYear);
  const base: SharpeResult = {
    sharpe: null,
    ann_return: m * options.tradingDaysPerYear,
    ann_vol: (sd ?? 0) * scale,
    mean_daily: m,
    sd_daily: sd ?? 0,
    sessions,
  };
  if (sd == null || sd <= 0 || sessions < options.minSessions) return base;
  const rfDaily = options.riskFreeAnnualPct / 100 / options.tradingDaysPerYear;
  return { ...base, sharpe: ((m - rfDaily) / sd) * scale };
}
