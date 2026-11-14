/**
 * American options (US single-stock options are American).
 *
 *   - `bs2002Price`: Bjerksund & Stensland (2002) closed-form approximation
 *     (two-step flat exercise boundary), as written out in Haug, "The
 *     Complete Guide to Option Pricing Formulas" (2nd ed.). Puts through the
 *     put-call transformation P(S, K, T, r, q) = C(K, S, T, q, r). Accurate to
 *     a few tenths of a percent against a fine binomial tree, and fast enough
 *     for implied volatilities of a whole chain.
 *   - `crrPrice`: Cox-Ross-Rubinstein binomial tree (default 200 steps), the
 *     reference used in the tests and available as a slower cross-check.
 *   - `impliedVolAmerican`: Brent on the BS2002 price; null below intrinsic
 *     value or outside the volatility bounds.
 *
 * A call on a stock with q <= 0 is never exercised early: it equals the BSM
 * price exactly. Pure.
 */

import { bsmPrice, europeanBounds, impliedVolFor, normCdf, IV_MAX, IV_MIN, type OptionInput } from "./math.ts";

// ---------------------------------------------------------------------------
// Bivariate normal CDF (Genz 2004, "Numerical computation of rectangular
// bivariate and trivariate normal and t probabilities"; Drezner-Wesolowsky
// with Gauss-Legendre points; accurate to ~1e-15).

const GL: Array<{ w: number[]; x: number[] }> = [
  { w: [0.1713244923791705, 0.3607615730481384, 0.4679139345726904], x: [0.9324695142031522, 0.6612093864662647, 0.238619186083197] },
  {
    w: [0.04717533638651177, 0.1069393259953183, 0.1600783285433464, 0.2031674267230659, 0.2334925365383547, 0.2491470458134029],
    x: [0.9815606342467191, 0.904117256370475, 0.769902674194305, 0.5873179542866171, 0.3678314989981802, 0.1252334085114692],
  },
  {
    w: [
      0.01761400713915212, 0.04060142980038694, 0.06267204833410906, 0.08327674157670475, 0.1019301198172404, 0.1181945319615184, 0.1316886384491766,
      0.1420961093183821, 0.1491729864726037, 0.1527533871307259,
    ],
    x: [
      0.9931285991850949, 0.9639719272779138, 0.9122344282513259, 0.8391169718222188, 0.7463319064601508, 0.636053680726515, 0.5108670019508271,
      0.3737060887154196, 0.2277858511416451, 0.07652652113349733,
    ],
  },
];

/** P(X > dh, Y > dk) for a standard bivariate normal with correlation r. */
function bvnu(dh: number, dk: number, r: number): number {
  if (dh === Infinity || dk === Infinity) return 0;
  if (dh === -Infinity) return dk === -Infinity ? 1 : normCdf(-dk);
  if (dk === -Infinity) return normCdf(-dh);
  const g = Math.abs(r) < 0.3 ? GL[0]! : Math.abs(r) < 0.75 ? GL[1]! : GL[2]!;
  const w = [...g.w, ...g.w];
  const x = [...g.x.map((v) => 1 - v), ...g.x.map((v) => 1 + v)];
  const h = dh;
  let k = dk;
  let hk = h * k;
  let bvn = 0;
  if (Math.abs(r) < 0.925) {
    const hs = (h * h + k * k) / 2;
    const asr = Math.asin(r) / 2;
    for (let i = 0; i < x.length; i++) {
      const sn = Math.sin(asr * x[i]!);
      bvn += w[i]! * Math.exp((sn * hk - hs) / (1 - sn * sn));
    }
    return Math.max(0, Math.min(1, (bvn * asr) / (2 * Math.PI) + normCdf(-h) * normCdf(-k)));
  }
  if (r < 0) {
    k = -k;
    hk = -hk;
  }
  if (Math.abs(r) < 1) {
    const as = 1 - r * r;
    let a = Math.sqrt(as);
    const bs = (h - k) ** 2;
    const c = (4 - hk) / 8;
    const d = (12 - hk) / 80;
    let asr = -(bs / as + hk) / 2;
    if (asr > -100) bvn = a * Math.exp(asr) * (1 - (c * (bs - as) * (1 - d * bs)) / 3 + c * d * as * as);
    if (hk > -100) {
      const b = Math.sqrt(bs);
      const sp = Math.sqrt(2 * Math.PI) * normCdf(-b / a);
      bvn -= Math.exp(-hk / 2) * sp * b * (1 - (c * bs * (1 - d * bs)) / 3);
    }
    a /= 2;
    let sum = 0;
    for (let i = 0; i < x.length; i++) {
      const xs = (a * x[i]!) ** 2;
      asr = -(bs / xs + hk) / 2;
      if (asr <= -100) continue;
      const sp = 1 + c * xs * (1 + 5 * d * xs);
      const rs = Math.sqrt(1 - xs);
      const ep = Math.exp((-(hk / 2) * xs) / (1 + rs) ** 2) / rs;
      sum += w[i]! * Math.exp(asr) * (sp - ep);
    }
    bvn = (a * sum - bvn) / (2 * Math.PI);
  }
  if (r > 0) bvn += normCdf(-Math.max(h, k));
  else if (h >= k) bvn = -bvn;
  else {
    const L = h < 0 ? normCdf(k) - normCdf(h) : normCdf(-h) - normCdf(-k);
    bvn = L - bvn;
  }
  return Math.max(0, Math.min(1, bvn));
}

/** M(a, b; rho) = P(X <= a, Y <= b), standard bivariate normal. */
export function bivariateNormalCdf(a: number, b: number, rho: number): number {
  return bvnu(-a, -b, rho);
}

// ---------------------------------------------------------------------------
// Bjerksund-Stensland 2002

function phi(S: number, T: number, gamma: number, H: number, I: number, r: number, b: number, v: number): number {
  const v2 = v * v;
  const lambda = (-r + gamma * b + 0.5 * gamma * (gamma - 1) * v2) * T;
  const sq = v * Math.sqrt(T);
  const d = -(Math.log(S / H) + (b + (gamma - 0.5) * v2) * T) / sq;
  const kappa = (2 * b) / v2 + 2 * gamma - 1;
  return Math.exp(lambda) * S ** gamma * (normCdf(d) - (I / S) ** kappa * normCdf(d - (2 * Math.log(I / S)) / sq));
}

function ksi(S: number, T2: number, gamma: number, H: number, I2: number, I1: number, t1: number, r: number, b: number, v: number): number {
  const v2 = v * v;
  const m = b + (gamma - 0.5) * v2;
  const s1 = v * Math.sqrt(t1);
  const s2 = v * Math.sqrt(T2);
  const e1 = (Math.log(S / I1) + m * t1) / s1;
  const e2 = (Math.log((I2 * I2) / (S * I1)) + m * t1) / s1;
  const e3 = (Math.log(S / I1) - m * t1) / s1;
  const e4 = (Math.log((I2 * I2) / (S * I1)) - m * t1) / s1;
  const f1 = (Math.log(S / H) + m * T2) / s2;
  const f2 = (Math.log((I2 * I2) / (S * H)) + m * T2) / s2;
  const f3 = (Math.log((I1 * I1) / (S * H)) + m * T2) / s2;
  const f4 = (Math.log((S * I1 * I1) / (H * I2 * I2)) + m * T2) / s2;
  const rho = Math.sqrt(t1 / T2);
  const lambda = -r + gamma * b + 0.5 * gamma * (gamma - 1) * v2;
  const kappa = (2 * b) / v2 + (2 * gamma - 1);
  return (
    Math.exp(lambda * T2) *
    S ** gamma *
    (bivariateNormalCdf(-e1, -f1, rho) -
      (I2 / S) ** kappa * bivariateNormalCdf(-e2, -f2, rho) -
      (I1 / S) ** kappa * bivariateNormalCdf(-e3, -f3, -rho) +
      (I1 / I2) ** kappa * bivariateNormalCdf(-e4, -f4, -rho))
  );
}

/** BS2002 American call with cost of carry b = r - q. */
function bs2002Call(S: number, X: number, T: number, r: number, b: number, v: number): number {
  const euro = bsmPrice({ S, K: X, T, r, q: r - b, sigma: v, right: "C" });
  if (b >= r) return euro;
  const v2 = v * v;
  const t1 = 0.5 * (Math.sqrt(5) - 1) * T;
  const beta = 0.5 - b / v2 + Math.sqrt((b / v2 - 0.5) ** 2 + (2 * r) / v2);
  const bInf = (beta / (beta - 1)) * X;
  const b0 = Math.max(X, (r / (r - b)) * X);
  const ht1 = (-(b * t1 + 2 * v * Math.sqrt(t1)) * X * X) / ((bInf - b0) * b0);
  const ht2 = (-(b * T + 2 * v * Math.sqrt(T)) * X * X) / ((bInf - b0) * b0);
  const I1 = b0 + (bInf - b0) * (1 - Math.exp(ht1));
  const I2 = b0 + (bInf - b0) * (1 - Math.exp(ht2));
  if (S >= I2) return S - X;
  const a1 = (I1 - X) * I1 ** -beta;
  const a2 = (I2 - X) * I2 ** -beta;
  const p =
    a2 * S ** beta -
    a2 * phi(S, t1, beta, I2, I2, r, b, v) +
    phi(S, t1, 1, I2, I2, r, b, v) -
    phi(S, t1, 1, I1, I2, r, b, v) -
    X * phi(S, t1, 0, I2, I2, r, b, v) +
    X * phi(S, t1, 0, I1, I2, r, b, v) +
    a1 * phi(S, t1, beta, I1, I2, r, b, v) -
    a1 * ksi(S, T, beta, I1, I2, I1, t1, r, b, v) +
    ksi(S, T, 1, I1, I2, I1, t1, r, b, v) -
    ksi(S, T, 1, X, I2, I1, t1, r, b, v) -
    X * ksi(S, T, 0, I1, I2, I1, t1, r, b, v) +
    X * ksi(S, T, 0, X, I2, I1, t1, r, b, v);
  // Overflow at tiny volatilities (S ** beta) falls back to the European value.
  // The approximation is a lower bound in theory; never report below the European value or intrinsic.
  return Number.isFinite(p) ? Math.max(p, euro, S - X) : Math.max(euro, S - X);
}

/** Bjerksund-Stensland (2002) American option price. */
export function bs2002Price(o: OptionInput): number {
  const { S, K, T, r, q, sigma, right } = o;
  const intrinsic = right === "C" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (T <= 0) return intrinsic;
  if (sigma <= 0) return Math.max(intrinsic, bsmPrice(o));
  const b = r - q;
  if (right === "C") return bs2002Call(S, K, T, r, b, sigma);
  // Put-call transformation: P(S, K, T, r, b) = C(K, S, T, r - b, -b).
  return Math.max(bs2002Call(K, S, T, r - b, -b, sigma), intrinsic);
}

// ---------------------------------------------------------------------------
// CRR binomial

/** Cox-Ross-Rubinstein tree with a continuous dividend yield. `american` false gives the European tree. */
export function crrPrice(o: OptionInput, steps = 200, american = true): number {
  const { S, K, T, r, q, sigma, right } = o;
  if (T <= 0 || sigma <= 0) return american ? Math.max(right === "C" ? S - K : K - S, 0, bsmPrice(o)) : bsmPrice(o);
  const dt = T / steps;
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const disc = Math.exp(-r * dt);
  const p = (Math.exp((r - q) * dt) - d) / (u - d);
  const sign = right === "C" ? 1 : -1;
  const v = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) v[i] = Math.max(sign * (S * u ** (steps - 2 * i) - K), 0);
  for (let n = steps - 1; n >= 0; n--) {
    for (let i = 0; i <= n; i++) {
      const cont = disc * (p * v[i]! + (1 - p) * v[i + 1]!);
      v[i] = american ? Math.max(cont, sign * (S * u ** (n - 2 * i) - K)) : cont;
    }
  }
  return v[0]!;
}

// ---------------------------------------------------------------------------
// Implied volatility

/**
 * American implied volatility from an option price (BS2002). Null when the
 * price is at or below intrinsic value or the European lower bound (no time
 * value to invert: deep in-the-money), above the upper bound, or would need
 * a volatility outside [IV_MIN, IV_MAX].
 */
export function impliedVolAmerican(price: number, o: Omit<OptionInput, "sigma">): number | null {
  if (!(o.T > 0) || !(o.S > 0) || !(o.K > 0) || !(price > 0)) return null;
  const intrinsic = o.right === "C" ? Math.max(o.S - o.K, 0) : Math.max(o.K - o.S, 0);
  const [lowerEu] = europeanBounds(o.S, o.K, o.T, o.r, o.q, o.right);
  const upper = o.right === "C" ? o.S : o.K;
  if (!(price > Math.max(intrinsic, lowerEu)) || !(price < upper)) return null;
  return impliedVolFor(price, (sigma) => bs2002Price({ ...o, sigma }), IV_MIN, IV_MAX);
}
