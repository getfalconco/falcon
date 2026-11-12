/**
 * Performance metrics on a daily equity curve. Pure.
 *
 * - Returns are simple daily returns of the curve (close to close).
 * - Sharpe = mean / sample standard deviation of daily returns * sqrt(252),
 *   risk-free rate 0. null when there is no variation.
 * - Annualized return is the CAGR over calendar time (365.25-day years).
 * - Max drawdown is the largest peak-to-trough fall, as a positive percent.
 */

export const TRADING_DAYS = 252;

export type CurveMetrics = {
  totalReturnPct: number;
  annualizedReturnPct: number | null;
  sharpe: number | null;
  maxDrawdownPct: number;
  /** Annualized standard deviation of daily returns, percent. */
  volatilityPct: number | null;
  startValue: number;
  endValue: number;
};

export function dailyReturns(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1]!;
    out.push(prev > 0 ? values[i]! / prev - 1 : 0);
  }
  return out;
}

function meanStd(xs: readonly number[]): { mean: number; std: number } | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const varSum = xs.reduce((a, b) => a + (b - mean) ** 2, 0);
  return { mean, std: Math.sqrt(varSum / (xs.length - 1)) };
}

export function sharpeRatio(returns: readonly number[]): number | null {
  const ms = meanStd(returns);
  if (!ms || ms.std < 1e-12) return null;
  return (ms.mean / ms.std) * Math.sqrt(TRADING_DAYS);
}

export function maxDrawdownPct(values: readonly number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.max(worst, 1 - v / peak);
  }
  return worst * 100;
}

export function cagrPct(startValue: number, endValue: number, startDate: string, endDate: string): number | null {
  const years = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / (365.25 * 86_400_000);
  if (!(years > 0) || startValue <= 0) return null;
  if (endValue <= 0) return -100;
  return ((endValue / startValue) ** (1 / years) - 1) * 100;
}

export function curveMetrics(values: readonly number[], dates: readonly string[]): CurveMetrics {
  const startValue = values[0] ?? 0;
  const endValue = values[values.length - 1] ?? 0;
  const rets = dailyReturns(values);
  const ms = meanStd(rets);
  return {
    totalReturnPct: startValue > 0 ? (endValue / startValue - 1) * 100 : 0,
    annualizedReturnPct: dates.length ? cagrPct(startValue, endValue, dates[0]!, dates[dates.length - 1]!) : null,
    sharpe: sharpeRatio(rets),
    maxDrawdownPct: maxDrawdownPct(values),
    volatilityPct: ms ? ms.std * Math.sqrt(TRADING_DAYS) * 100 : null,
    startValue,
    endValue,
  };
}
