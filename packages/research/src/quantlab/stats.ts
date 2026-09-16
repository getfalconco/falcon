/**
 * Backtest statistics (§7).
 *
 * Pure functions over an array of per-signal returns. Two choices here are
 * deliberate and worth stating:
 *
 *  - Sortino sits beside Sharpe because return distributions are fat-tailed.
 *    Sharpe divides by total variance, so a rule with rare large losses and
 *    many small gains flatters itself; Sortino only counts the downside.
 *  - The bootstrap confidence interval is on the MEDIAN, not the mean, and its
 *    width is reported rather than hidden. A median of +0.4% with a CI spanning
 *    −2% to +3% is not an edge, and the interval is the only thing on the
 *    report that says so out loud.
 *
 * Sampling is seeded, so a report is reproducible: re-running a backtest must
 * not move the confidence interval or the base rate.
 */

/** Deterministic LCG — reports must be reproducible across runs. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Linear-interpolated percentile, p in [0,1]. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return percentile([...xs].sort((a, b) => a - b), 0.5);
}

/** Sample standard deviation (n−1). Null below two observations. */
export function stdDev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const ss = xs.reduce((a, x) => a + (x - m) * (x - m), 0);
  return Math.sqrt(ss / (xs.length - 1));
}

/** Share of returns strictly above zero. */
export function hitRate(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.filter((x) => x > 0).length / xs.length;
}

/** p10…p90 — the distribution, not just the middle. */
export function deciles(xs: number[]): number[] {
  if (xs.length === 0) return [];
  const sorted = [...xs].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i <= 9; i++) out.push(percentile(sorted, i / 10)!);
  return out;
}

export type AnnualisationInput = {
  /** Hold length of each return, in sessions. */
  holdSessions: number;
  sessionsPerYear: number;
  /** Annual risk-free rate. */
  riskFreeRate: number;
};

/** Per-period risk-free rate matching the hold length. */
function periodRiskFree(input: AnnualisationInput): number {
  const periodsPerYear = input.sessionsPerYear / Math.max(1, input.holdSessions);
  return input.riskFreeRate / periodsPerYear;
}

function periodsPerYear(input: AnnualisationInput): number {
  return input.sessionsPerYear / Math.max(1, input.holdSessions);
}

/**
 * Annualised Sharpe from per-signal returns.
 *
 * Treats the signals as independent draws of a `holdSessions`-long return and
 * scales by √(periods per year). Overlapping signals violate that independence
 * and inflate the figure — which is exactly why the base rate is reported
 * beside it and why the ratio alone never decides anything.
 */
export function sharpe(xs: number[], input: AnnualisationInput): number | null {
  const sd = stdDev(xs);
  const m = mean(xs);
  if (sd == null || m == null || sd === 0) return null;
  const excess = m - periodRiskFree(input);
  return (excess / sd) * Math.sqrt(periodsPerYear(input));
}

/**
 * Annualised Sortino — the same numerator over downside deviation only.
 *
 * Downside deviation is the root-mean-square of shortfalls below the target,
 * divided by the FULL sample count (not just the losing count): a rule that
 * rarely loses should be rewarded for that, and dividing by the losers alone
 * would erase the reward.
 */
export function sortino(xs: number[], input: AnnualisationInput): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const target = periodRiskFree(input);
  let sumSq = 0;
  for (const x of xs) {
    const shortfall = Math.min(0, x - target);
    sumSq += shortfall * shortfall;
  }
  const downside = Math.sqrt(sumSq / xs.length);
  if (downside === 0) return null;
  return ((m - target) / downside) * Math.sqrt(periodsPerYear(input));
}

/**
 * Maximum drawdown of the equity curve formed by compounding the returns in
 * the order given. Returned as a negative fraction (−0.25 = a 25% fall from a
 * peak); 0 when the curve never falls.
 */
export function maxDrawdown(xs: number[]): number | null {
  if (xs.length === 0) return null;
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const x of xs) {
    equity *= 1 + x;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = equity / peak - 1;
      if (dd < worst) worst = dd;
    }
  }
  return worst;
}

export type ConfidenceInterval = { low: number; high: number };

/**
 * Bootstrap 95% CI on the median: resample with replacement, take the 2.5th and
 * 97.5th percentiles of the resampled medians.
 */
export function bootstrapMedianCI(
  xs: number[],
  iterations: number,
  rand: () => number,
): ConfidenceInterval | null {
  if (xs.length < 2) return null;
  const medians: number[] = [];
  const sample = new Array<number>(xs.length);
  for (let b = 0; b < iterations; b++) {
    for (let i = 0; i < xs.length; i++) sample[i] = xs[(rand() * xs.length) | 0];
    medians.push(median(sample)!);
  }
  medians.sort((a, b) => a - b);
  return { low: percentile(medians, 0.025)!, high: percentile(medians, 0.975)! };
}

/**
 * Compound growth of a sequence of returns, for the equity curve the drawdown
 * is measured on.
 */
export function equityCurve(xs: number[]): number[] {
  const out: number[] = [];
  let equity = 1;
  for (const x of xs) {
    equity *= 1 + x;
    out.push(equity);
  }
  return out;
}
