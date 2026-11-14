/**
 * Statistics for the quality report and the event study. Pure.
 */

export function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function std(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export function median(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Share of `null` values at or below `x`, 0..100. */
export function percentileOf(x: number, nulls: readonly number[]): number {
  if (!nulls.length || !Number.isFinite(x)) return NaN;
  return (nulls.filter((v) => v <= x).length / nulls.length) * 100;
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Inverse standard normal CDF (Acklam). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pl) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** Student t CDF with df degrees of freedom (regularized incomplete beta). */
export function tCdf(t: number, df: number): number {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const x = df / (df + t * t);
  const ib = incBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - ib / 2 : ib / 2;
}

function lgamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function incBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const cf = (xx: number, aa: number, bb: number) => {
    let c = 1;
    let d = 1 - ((aa + bb) * xx) / (aa + 1);
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 200; m++) {
      const m2 = 2 * m;
      let aa2 = (m * (bb - m) * xx) / ((aa + m2 - 1) * (aa + m2));
      d = 1 + aa2 * d;
      if (Math.abs(d) < 1e-30) d = 1e-30;
      c = 1 + aa2 / c;
      if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d;
      h *= d * c;
      aa2 = (-(aa + m) * (aa + bb + m) * xx) / ((aa + m2) * (aa + m2 + 1));
      d = 1 + aa2 * d;
      if (Math.abs(d) < 1e-30) d = 1e-30;
      c = 1 + aa2 / c;
      if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 3e-12) break;
    }
    return h;
  };
  return x < (a + 1) / (a + b + 2) ? (bt * cf(x, a, b)) / a : 1 - (bt * cf(1 - x, b, a)) / b;
}

/** Newey-West HAC t statistic of the mean of `xs` (Bartlett kernel, lag floor(4 (T/100)^(2/9))). */
export function hacT(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 10) return NaN;
  const m = mean(xs);
  const e = xs.map((x) => x - m);
  const L = Math.floor(4 * (n / 100) ** (2 / 9));
  let s = e.reduce((a, x) => a + x * x, 0) / n;
  for (let l = 1; l <= L; l++) {
    let g = 0;
    for (let t = l; t < n; t++) g += e[t]! * e[t - l]!;
    s += 2 * (1 - l / (L + 1)) * (g / n);
  }
  const se = Math.sqrt(s / n);
  return se > 0 ? m / se : NaN;
}

/** Moving-block bootstrap of the annualized mean (x252) of daily values. Returns the resampled annual means. */
export function blockBootstrap(xs: readonly number[], rand: () => number, blocks = 20, resamples = 1000): number[] {
  const n = xs.length;
  if (n < blocks * 2) return [];
  const out: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    let k = 0;
    while (k < n) {
      const start = Math.floor(rand() * (n - blocks + 1));
      for (let j = 0; j < blocks && k < n; j++, k++) sum += xs[start + j]!;
    }
    out.push((sum / n) * 252);
  }
  return out;
}

/** Wilson score interval for k successes of n at ~90% (z = 1.645). */
export function wilson(k: number, n: number, z = 1.645): [number, number] {
  if (n <= 0) return [NaN, NaN];
  const p = k / n;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Skewness and kurtosis (not excess) of a sample. */
export function moments(xs: readonly number[]): { skew: number; kurt: number } {
  const n = xs.length;
  const m = mean(xs);
  const s = std(xs);
  if (!(s > 0)) return { skew: 0, kurt: 3 };
  let m3 = 0;
  let m4 = 0;
  for (const x of xs) {
    m3 += ((x - m) / s) ** 3;
    m4 += ((x - m) / s) ** 4;
  }
  return { skew: m3 / n, kurt: m4 / n };
}

/**
 * Deflated Sharpe ratio (Bailey & Lopez de Prado 2014) of per-period returns:
 * the probability that the true Sharpe exceeds the maximum expected from
 * `trials` independent tries. With one trial it is the probabilistic Sharpe
 * ratio against 0. `srVariance`: the variance of Sharpe across trials; when
 * unknown, the sampling variance of the estimate (1 + SR^2 / 2) / T is used.
 */
export function deflatedSharpe(xs: readonly number[], trials: number, srVariance?: number): number {
  const T = xs.length;
  if (T < 30) return NaN;
  const sd = std(xs);
  if (!(sd > 0)) return NaN;
  const sr = mean(xs) / sd;
  const { skew, kurt } = moments(xs);
  const v = srVariance ?? (1 + (sr * sr) / 2) / T;
  const n = Math.max(1, trials);
  const gamma = 0.5772156649;
  const sr0 = n === 1 ? 0 : Math.sqrt(v) * ((1 - gamma) * normInv(1 - 1 / n) + gamma * normInv(1 - 1 / (n * Math.E)));
  const den = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return normCdf(((sr - sr0) * Math.sqrt(T - 1)) / den);
}

/** Ordinary least squares y = a + b x. */
export function ols(x: readonly number[], y: readonly number[]): { a: number; b: number } {
  const n = x.length;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/**
 * Clustered t of a mean over groups (independent event dates): the group
 * means' t statistic with G - 1 degrees of freedom, and its two-sided p.
 */
export function clusteredT(groups: readonly number[][]): { t: number; df: number; p: number } {
  const gm = groups.filter((g) => g.length).map((g) => mean(g));
  const G = gm.length;
  if (G < 3) return { t: NaN, df: G - 1, p: NaN };
  const se = std(gm) / Math.sqrt(G);
  const t = se > 0 ? mean(gm) / se : NaN;
  const p = Number.isFinite(t) ? 2 * (1 - tCdf(Math.abs(t), G - 1)) : NaN;
  return { t, df: G - 1, p };
}

/** Wild cluster bootstrap p-value (Rademacher weights on demeaned group means), for G < 30. */
export function wildClusterP(groups: readonly number[][], rand: () => number, reps = 999): number {
  const gm = groups.filter((g) => g.length).map((g) => mean(g));
  const G = gm.length;
  if (G < 3) return NaN;
  const t0 = Math.abs(mean(gm) / (std(gm) / Math.sqrt(G)));
  const m = mean(gm);
  const e = gm.map((x) => x - m);
  let hits = 0;
  for (let r = 0; r < reps; r++) {
    const s = e.map((x) => (rand() < 0.5 ? -x : x));
    const sd = std(s);
    const tb = sd > 0 ? Math.abs(mean(s) / (sd / Math.sqrt(G))) : 0;
    if (tb >= t0) hits++;
  }
  return (hits + 1) / (reps + 1);
}
