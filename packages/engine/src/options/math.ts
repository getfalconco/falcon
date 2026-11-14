/**
 * European option math: Black-Scholes-Merton with a continuous dividend
 * yield, Greeks, Brent's root finder and implied volatility.
 *
 * Conventions: S spot, K strike, T years (ACT/365), r and q continuously
 * compounded annual rates, sigma annual volatility. Greeks are per unit:
 * theta per year (divide by 365 for a calendar day), vega per 1.00 of
 * volatility (divide by 100 for one vol point), rho per 1.00 of rate.
 *
 * Pure: no fs, no network, no clock.
 */

export type Right = "C" | "P";

export type OptionInput = { S: number; K: number; T: number; r: number; q: number; sigma: number; right: Right };

// ---------------------------------------------------------------------------
// Normal distribution

const SQRT2PI = Math.sqrt(2 * Math.PI);

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

/**
 * Standard normal CDF, double precision (Hart 1968 as given by West 2005,
 * "Better approximations to cumulative normal functions"; |error| < 1e-14).
 */
export function normCdf(x: number): number {
  const z = Math.abs(x);
  let c: number;
  if (z > 37) c = 0;
  else {
    const e = Math.exp(-z * z / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * n) / d;
    } else {
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

// ---------------------------------------------------------------------------
// Black-Scholes-Merton

function d1d2(S: number, K: number, T: number, r: number, q: number, sigma: number): [number, number] {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / v;
  return [d1, d1 - v];
}

/** BSM price. At T <= 0 or sigma <= 0 it is the discounted intrinsic value of the forward. */
export function bsmPrice(o: OptionInput): number {
  const { S, K, T, r, q, sigma, right } = o;
  const dfq = Math.exp(-q * Math.max(T, 0));
  const dfr = Math.exp(-r * Math.max(T, 0));
  if (T <= 0 || sigma <= 0) {
    const fwd = S * dfq - K * dfr;
    return right === "C" ? Math.max(fwd, 0) : Math.max(-fwd, 0);
  }
  const [d1, d2] = d1d2(S, K, T, r, q, sigma);
  return right === "C" ? S * dfq * normCdf(d1) - K * dfr * normCdf(d2) : K * dfr * normCdf(-d2) - S * dfq * normCdf(-d1);
}

export type Greeks = { price: number; delta: number; gamma: number; theta: number; vega: number; rho: number };

/** Price and Greeks (theta per year, vega and rho per 1.00). NaN Greeks at T <= 0 or sigma <= 0. */
export function bsmGreeks(o: OptionInput): Greeks {
  const { S, K, T, r, q, sigma, right } = o;
  const price = bsmPrice(o);
  if (T <= 0 || sigma <= 0) return { price, delta: NaN, gamma: NaN, theta: NaN, vega: NaN, rho: NaN };
  const [d1, d2] = d1d2(S, K, T, r, q, sigma);
  const dfq = Math.exp(-q * T);
  const dfr = Math.exp(-r * T);
  const sq = Math.sqrt(T);
  const pdf = normPdf(d1);
  const gamma = (dfq * pdf) / (S * sigma * sq);
  const vega = S * dfq * pdf * sq;
  const common = -(S * dfq * pdf * sigma) / (2 * sq);
  if (right === "C") {
    return {
      price,
      delta: dfq * normCdf(d1),
      gamma,
      theta: common - r * K * dfr * normCdf(d2) + q * S * dfq * normCdf(d1),
      vega,
      rho: K * T * dfr * normCdf(d2),
    };
  }
  return {
    price,
    delta: -dfq * normCdf(-d1),
    gamma,
    theta: common + r * K * dfr * normCdf(-d2) - q * S * dfq * normCdf(-d1),
    vega,
    rho: -K * T * dfr * normCdf(-d2),
  };
}

/** Model-free European bounds: [lower, upper]. */
export function europeanBounds(S: number, K: number, T: number, r: number, q: number, right: Right): [number, number] {
  const s = S * Math.exp(-q * T);
  const k = K * Math.exp(-r * T);
  return right === "C" ? [Math.max(s - k, 0), s] : [Math.max(k - s, 0), k];
}

// ---------------------------------------------------------------------------
// Root finding

/**
 * Brent's method (Brent 1973; Numerical Recipes zbrent) for f(x) = 0 on
 * [a, b]. Returns null when f(a) and f(b) have the same sign.
 */
export function brent(f: (x: number) => number, a: number, b: number, tol = 1e-10, maxIter = 200): number | null {
  let fa = f(a);
  let fb = f(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) return null;
  if (fa === 0) return a;
  if (fb === 0) return b;
  if (fa * fb > 0) return null;
  let c = b;
  let fc = fb;
  let d = b - a;
  let e = d;
  for (let i = 0; i < maxIter; i++) {
    if (fb * fc > 0) {
      c = a;
      fc = fa;
      d = b - a;
      e = d;
    }
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b;
      b = c;
      c = a;
      fa = fb;
      fb = fc;
      fc = fa;
    }
    const tol1 = 2 * Number.EPSILON * Math.abs(b) + 0.5 * tol;
    const xm = 0.5 * (c - b);
    if (Math.abs(xm) <= tol1 || fb === 0) return b;
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa;
      let p: number;
      let qq: number;
      if (a === c) {
        p = 2 * xm * s;
        qq = 1 - s;
      } else {
        const q0 = fa / fc;
        const r0 = fb / fc;
        p = s * (2 * xm * q0 * (q0 - r0) - (b - a) * (r0 - 1));
        qq = (q0 - 1) * (r0 - 1) * (s - 1);
      }
      if (p > 0) qq = -qq;
      p = Math.abs(p);
      if (2 * p < Math.min(3 * xm * qq - Math.abs(tol1 * qq), Math.abs(e * qq))) {
        e = d;
        d = p / qq;
      } else {
        d = xm;
        e = d;
      }
    } else {
      d = xm;
      e = d;
    }
    a = b;
    fa = fb;
    b += Math.abs(d) > tol1 ? d : xm > 0 ? tol1 : -tol1;
    fb = f(b);
    if (!Number.isFinite(fb)) return null;
  }
  return b;
}

// ---------------------------------------------------------------------------
// Implied volatility

export const IV_MIN = 1e-4;
export const IV_MAX = 5;

export type PriceFn = (sigma: number) => number;

/**
 * Implied volatility of `price` under `priceAt` (any model, monotone in
 * sigma), searched on [IV_MIN, IV_MAX] with Brent. Null when the price is
 * not strictly inside the model's prices at the two bounds (below the
 * no-arbitrage floor, or implying a volatility above 500%).
 */
export function impliedVolFor(price: number, priceAt: PriceFn, lo = IV_MIN, hi = IV_MAX, tol = 1e-8): number | null {
  if (!(price > 0) || !Number.isFinite(price)) return null;
  const pLo = priceAt(lo);
  const pHi = priceAt(hi);
  if (!(price > pLo + 1e-12) || !(price < pHi)) return null;
  return brent((s) => priceAt(s) - price, lo, hi, tol);
}

/** European (BSM) implied volatility; null outside the no-arbitrage bounds. */
export function impliedVolEuropean(price: number, o: Omit<OptionInput, "sigma">): number | null {
  if (!(o.T > 0) || !(o.S > 0) || !(o.K > 0)) return null;
  const [lower, upper] = europeanBounds(o.S, o.K, o.T, o.r, o.q, o.right);
  if (!(price > lower) || !(price < upper)) return null;
  return impliedVolFor(price, (sigma) => bsmPrice({ ...o, sigma }));
}

export type QuoteCheck = { mid: number | null; relSpread: number | null; ok: boolean; reason: string | null };

/**
 * Quote screen before an implied volatility: bid > 0 (a missing bid counts
 * as 0), ask > bid, and
 * (ask - bid) / mid at most `maxRelSpread`. Pure.
 */
export function checkQuote(bid: number | null, ask: number | null, maxRelSpread = 0.5): QuoteCheck {
  if (ask === null || !Number.isFinite(ask)) return { mid: null, relSpread: null, ok: false, reason: bid === null ? "no_quote" : "no_ask" };
  // An empty bid side (null price) is a zero bid.
  if (bid === null || !Number.isFinite(bid)) bid = 0;
  if (ask <= 0) return { mid: null, relSpread: null, ok: false, reason: "no_ask" };
  if (bid > ask) return { mid: null, relSpread: null, ok: false, reason: "crossed" };
  const mid = (bid + ask) / 2;
  const relSpread = (ask - bid) / mid;
  if (bid <= 0) return { mid, relSpread, ok: false, reason: "zero_bid" };
  if (relSpread > maxRelSpread) return { mid, relSpread, ok: false, reason: "wide" };
  return { mid, relSpread, ok: true, reason: null };
}
