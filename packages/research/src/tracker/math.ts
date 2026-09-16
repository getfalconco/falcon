/**
 * Tracker pure math (spec §3, §5, §8.1).
 *
 * Every statistic is a pure function over price/volume series. The
 * insufficient-history rule (§3.11) is enforced here: any statistic whose
 * window is not fully covered returns null — never zero, never fabricated.
 * Division-by-zero guards likewise return null ("not computable").
 */

export const MAD_TO_STD = 1.4826;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Robust stddev estimate: 1.4826 × median absolute deviation. */
export function robustStd(xs: number[]): number | null {
  const med = median(xs);
  if (med == null) return null;
  const deviations = xs.map((x) => Math.abs(x - med));
  const mad = median(deviations);
  return mad == null ? null : MAD_TO_STD * mad;
}

/** Simple daily returns c_i / c_{i-1} − 1. Skips non-finite inputs' pairs. */
export function simpleReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev === 0) continue;
    out.push(cur / prev - 1);
  }
  return out;
}

/**
 * Robust daily volatility (§3.3): 1.4826 × median(|r_i − median(r)|) over the
 * trailing `window` returns. Null when history does not cover the window.
 */
export function robustVol(returns: number[], window: number): number | null {
  if (returns.length < window) return null;
  return robustStd(returns.slice(-window));
}

export type OlsResult = {
  beta: number;
  r2: number;
  residuals: number[];
  /** Robust stddev of the regression residuals (for residual_zscore). */
  residualRobustStd: number | null;
};

/**
 * OLS of y on x over the trailing `window` pairs (§3.1–3.2, §3.7).
 * Null when either series does not cover the window or x has zero variance.
 * When y has zero variance, r2 is 0 by convention (nothing to explain).
 */
export function olsBeta(y: number[], x: number[], window: number): OlsResult | null {
  if (y.length < window || x.length < window) return null;
  const ys = y.slice(-window);
  const xs = x.slice(-window);
  const n = window;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - meanX) * (xs[i] - meanX);
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
  }
  // Degenerate-x guard, tolerant of float noise on a constant series.
  if (sxx < Number.EPSILON * n * (meanX * meanX + 1)) return null;
  const beta = sxy / sxx;
  const alpha = meanY - beta * meanX;
  const residuals = ys.map((yi, i) => yi - (alpha + beta * xs[i]));
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += residuals[i] * residuals[i];
    ssTot += (ys[i] - meanY) * (ys[i] - meanY);
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { beta, r2, residuals, residualRobustStd: robustStd(residuals) };
}

/** z = value / scale with a zero/na guard (§3.6, §3.7, §5.1). */
export function zScore(value: number | null, scale: number | null): number | null {
  if (value == null || scale == null || scale === 0 || !Number.isFinite(scale)) return null;
  return value / scale;
}

/** Trailing k-trading-day return (§3.9). Requires k+1 closes. */
export function trailingReturn(closes: number[], k: number): number | null {
  if (closes.length < k + 1) return null;
  const last = closes[closes.length - 1];
  const base = closes[closes.length - 1 - k];
  if (!Number.isFinite(last) || !Number.isFinite(base) || base === 0) return null;
  return last / base - 1;
}

/** Overnight gaps o_i / c_{i-1} − 1 from a bar series. */
export function overnightGaps(bars: Array<{ o: number; c: number }>): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].c;
    const open = bars[i].o;
    if (!Number.isFinite(prevClose) || !Number.isFinite(open) || prevClose === 0) continue;
    out.push(open / prevClose - 1);
  }
  return out;
}

/**
 * gap_vol (§5.1): robust stddev of the last `window` overnight gaps.
 * Null when fewer than `window` gaps exist (§3.11).
 */
export function gapVol(gaps: number[], window: number): number | null {
  if (gaps.length < window) return null;
  return robustStd(gaps.slice(-window));
}

/** % from 52-week high / low over the trailing `window` closes (§3.10). */
export function week52Context(
  closes: number[],
  window: number,
): { pctFromHigh: number; pctFromLow: number } | null {
  if (closes.length < window) return null;
  const slice = closes.slice(-window);
  const last = slice[slice.length - 1];
  const high = Math.max(...slice);
  const low = Math.min(...slice);
  if (high === 0 || low === 0) return null;
  return { pctFromHigh: last / high - 1, pctFromLow: last / low - 1 };
}

/** Mean |1-day earnings move| (§3.8). Requires ≥ 2 observed moves (§3.11). */
export function earningsRhythm(absMoves: number[]): number | null {
  const valid = absMoves.filter((m) => Number.isFinite(m));
  if (valid.length < 2) return null;
  return valid.reduce((a, b) => a + Math.abs(b), 0) / valid.length;
}

/** Median filing lag in calendar days (§5.4). Requires ≥ 4 lags (§3.11). */
export function medianFilingLag(lagDays: number[]): number | null {
  if (lagDays.length < 4) return null;
  return median(lagDays);
}

/** Drift score (§5.6): |momentum_5d| / (daily_vol_30d × √5). */
export function driftScore(momentum5d: number | null, vol30: number | null): number | null {
  if (momentum5d == null || vol30 == null || vol30 === 0) return null;
  return Math.abs(momentum5d) / (vol30 * Math.sqrt(5));
}
