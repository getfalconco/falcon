/**
 * Small-sample statistics for event studies: Student t tail areas, means with
 * standard errors clustered one way or two ways (Cameron, Gelbach & Miller
 * 2011), a wild-cluster bootstrap for few clusters (Cameron, Gelbach & Miller
 * 2008; Rademacher weights, null imposed), and Newey-West for a daily series.
 *
 * Pure: no fs, no network, no clock. Randomness only through a seeded PRNG.
 */

// ---------------------------------------------------------------------------
// Distributions

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const xx = x - 1;
  let a = c[0]!;
  const t = xx + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta (Numerical Recipes betacf). */
function betaCf(a: number, b: number, x: number): number {
  const MAXIT = 300;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betaCf(a, b, x)) / a;
  return 1 - (bt * betaCf(b, a, 1 - x)) / b;
}

/** Two-sided p of a Student t statistic with `df` degrees of freedom (normal when df is not finite). */
export function tTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t)) return Number.isNaN(t) ? 1 : 0;
  if (!Number.isFinite(df)) return 2 * (1 - normalCdf(Math.abs(t)));
  if (df <= 0) return 1;
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/** One-sided p for H1: mean > 0. */
export function tOneSidedP(t: number, df: number): number {
  const two = tTwoSidedP(t, df);
  return t > 0 ? two / 2 : 1 - two / 2;
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 through erf; |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// ---------------------------------------------------------------------------
// Descriptives

export function mean(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function median(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

// ---------------------------------------------------------------------------
// Clustered standard errors of a sample mean (regression on a constant)

/**
 * Variance of the sample mean clustered by `keys`, with Stata's small-sample
 * factor G/(G-1) · (N-1)/(N-K), K = 1. Also returns the number of clusters.
 */
export function clusteredMeanVariance(ys: readonly number[], keys: readonly string[], center?: number): { variance: number; clusters: number } {
  const n = ys.length;
  if (n === 0) return { variance: NaN, clusters: 0 };
  const m = center ?? mean(ys);
  const sums = new Map<string, number>();
  for (let i = 0; i < n; i++) sums.set(keys[i]!, (sums.get(keys[i]!) ?? 0) + (ys[i]! - m));
  const g = sums.size;
  let s = 0;
  for (const v of sums.values()) s += v * v;
  if (g < 2) return { variance: NaN, clusters: g };
  return { variance: ((g / (g - 1)) * s) / (n * n), clusters: g };
}

export type MeanTest = { mean: number; se: number; t: number; df: number; p: number };

/** Mean, SE clustered by `keys`, t and two-sided p on G-1 degrees of freedom. */
export function clusteredMeanTest(ys: readonly number[], keys: readonly string[]): MeanTest & { clusters: number } {
  const m = mean(ys);
  const { variance, clusters } = clusteredMeanVariance(ys, keys);
  const se = Math.sqrt(variance);
  const t = m / se;
  const df = clusters - 1;
  return { mean: m, se, t, df, p: Number.isFinite(t) ? tTwoSidedP(t, df) : 1, clusters };
}

/**
 * Two-way clustered mean test (Cameron, Gelbach & Miller 2011):
 * V = V_a + V_b - V_ab, each with its own small-sample factor. When V is not
 * positive the larger one-way variance is used. df = min(G_a, G_b) - 1.
 */
export function twoWayMeanTest(ys: readonly number[], a: readonly string[], b: readonly string[]): MeanTest & { clustersA: number; clustersB: number } {
  const m = mean(ys);
  const va = clusteredMeanVariance(ys, a, m);
  const vb = clusteredMeanVariance(ys, b, m);
  const ab = a.map((x, i) => `${x}\u0000${b[i]}`);
  const vab = clusteredMeanVariance(ys, ab, m);
  let v = va.variance + vb.variance - (Number.isFinite(vab.variance) ? vab.variance : 0);
  if (!(v > 0)) v = Math.max(va.variance, vb.variance);
  const se = Math.sqrt(v);
  const t = m / se;
  const df = Math.min(va.clusters, vb.clusters) - 1;
  return { mean: m, se, t, df, p: Number.isFinite(t) ? tTwoSidedP(t, df) : 1, clustersA: va.clusters, clustersB: vb.clusters };
}

/** mulberry32: a small seeded PRNG in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Wild-cluster bootstrap p (two-sided) for H0: mean = 0, restricted residuals
 * (y itself under the null), Rademacher weights per cluster, studentized by
 * the clustered SE. Enumerates all 2^G sign vectors when G <= 12, else draws
 * `reps` with a fixed seed.
 */
export function wildClusterBootstrapP(ys: readonly number[], keys: readonly string[], reps = 9999, seed = 20261115): number {
  const ids = new Map<string, number>();
  const gi = keys.map((k) => {
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    return id;
  });
  const g = ids.size;
  if (g < 2) return 1;
  const tObs = Math.abs(clusteredMeanTest(ys, keys).t);
  if (!Number.isFinite(tObs)) return 1;
  // Per-cluster sums and counts make each replicate O(G).
  const sum = new Float64Array(g);
  const cnt = new Float64Array(g);
  for (let i = 0; i < ys.length; i++) {
    sum[gi[i]!]! += ys[i]!;
    cnt[gi[i]!]! += 1;
  }
  const n = ys.length;
  const tStar = (w: (j: number) => number): number => {
    let tot = 0;
    for (let j = 0; j < g; j++) tot += w(j) * sum[j]!;
    const m = tot / n;
    let s = 0;
    for (let j = 0; j < g; j++) {
      const e = w(j) * sum[j]! - m * cnt[j]!;
      s += e * e;
    }
    const se = Math.sqrt(((g / (g - 1)) * s) / (n * n));
    return se > 0 ? Math.abs(m / se) : 0;
  };
  let hits = 0;
  let total = 0;
  if (g <= 12) {
    for (let mask = 0; mask < 1 << g; mask++) {
      if (tStar((j) => ((mask >> j) & 1 ? -1 : 1)) >= tObs - 1e-12) hits++;
      total++;
    }
    return hits / total;
  }
  const rnd = seededRandom(seed);
  const w = new Float64Array(g);
  for (let r = 0; r < reps; r++) {
    for (let j = 0; j < g; j++) w[j] = rnd() < 0.5 ? -1 : 1;
    if (tStar((j) => w[j]!) >= tObs - 1e-12) hits++;
    total++;
  }
  return (hits + 1) / (total + 1);
}

/**
 * Mean of a time series with a Newey-West (Bartlett kernel) SE. Default lag
 * floor(4 (T/100)^(2/9)). df for the p is T - 1.
 */
export function neweyWestMean(xs: readonly number[], lags?: number): MeanTest & { lags: number } {
  const n = xs.length;
  const m = mean(xs);
  const L = lags ?? Math.floor(4 * Math.pow(n / 100, 2 / 9));
  const e = xs.map((x) => x - m);
  let s = 0;
  for (const v of e) s += v * v;
  for (let l = 1; l <= L; l++) {
    let c = 0;
    for (let t = l; t < n; t++) c += e[t]! * e[t - l]!;
    s += 2 * (1 - l / (L + 1)) * c;
  }
  const se = Math.sqrt(s / (n * n));
  const t = m / se;
  return { mean: m, se, t, df: n - 1, p: Number.isFinite(t) ? tTwoSidedP(t, n - 1) : 1, lags: L };
}
