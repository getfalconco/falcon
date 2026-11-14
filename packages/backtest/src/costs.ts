/**
 * Trading costs (design 4.5). The "auto" half-spread is a floor tiered by
 * 20-session average dollar volume (ADV) and the unadjusted price, read from
 * sessions before the fill (known at the open):
 *
 *   ADV > $1B                     0.5 bp
 *   ADV $50M to $1B               2 bp
 *   ADV $5M to $50M               max(5 bp, Corwin-Schultz)
 *   ADV < $5M or price < $5       max(25 bp, Corwin-Schultz)
 *
 * Corwin-Schultz (2012) estimates the spread from daily highs and lows; it is
 * shown as information and overstates spreads for very liquid, volatile names
 * (Abdi & Ranaldo 2017), so it only raises the illiquid tiers. A fixed spread
 * a user types can raise costs but never go below the floor. Commission
 * defaults to 1 bp of each fill's notional.
 */

import type { Panel } from "./fsl/eval";

export const TIERS = [
  { minAdv: 1e9, bps: 0.5, label: "ADV above $1B" },
  { minAdv: 5e7, bps: 2, label: "ADV $50M to $1B" },
  { minAdv: 5e6, bps: 5, label: "ADV $5M to $50M", cs: true },
  { minAdv: 0, bps: 25, label: "ADV below $5M or price below $5", cs: true },
] as const;

/** The floor in bps for one fill, from ADV (dollars) and the unadjusted price. */
export function floorBps(adv: number, rawPrice: number, csBps: number): number {
  if (!(adv > 0) || !(rawPrice >= 5)) return Math.max(25, Number.isFinite(csBps) ? csBps : 0);
  for (const t of TIERS) {
    if (adv > t.minAdv) return "cs" in t && t.cs ? Math.max(t.bps, Number.isFinite(csBps) ? csBps : 0) : t.bps;
  }
  return Math.max(25, Number.isFinite(csBps) ? csBps : 0);
}

/**
 * Corwin-Schultz half-spread estimate in bps from two consecutive bars
 * (negative estimates set to 0).
 */
export function corwinSchultzBps(h0: number, l0: number, h1: number, l1: number): number {
  if (!(h0 > 0 && l0 > 0 && h1 > 0 && l1 > 0)) return NaN;
  const beta = Math.log(h0 / l0) ** 2 + Math.log(h1 / l1) ** 2;
  const gamma = Math.log(Math.max(h0, h1) / Math.min(l0, l1)) ** 2;
  const k = 3 - 2 * Math.SQRT2;
  const alpha = (Math.sqrt(2 * beta) - Math.sqrt(beta)) / k - Math.sqrt(gamma / k);
  const spread = (2 * (Math.exp(alpha) - 1)) / (1 + Math.exp(alpha));
  return Math.max(0, spread) * 10_000 / 2;
}

export type CostModel = {
  /** Half-spread as a fraction for a fill of column c at session t. */
  halfSpread(c: number, t: number): number;
  commission: number;
  /** 20-session ADV in dollars known at the open of t (NaN when unknown). */
  adv(c: number, t: number): number;
  /** Bps the floor alone would charge (for the report). */
  floor(c: number, t: number): number;
  csBps(c: number, t: number): number;
};

/**
 * Builds the cost model for a run. `fixed`: a number of bps (raised to the
 * floor unless `noFloor`, the v1 legacy mode) or "auto". `multiplier` scales
 * every cost (the costs x2 check).
 */
export function costModel(panel: Panel, opts: { spread: "auto" | number; commissionBps: number; noFloor?: boolean; multiplier?: number }): CostModel {
  const T = panel.dates.length;
  const N = panel.tickers.length;
  const mult = opts.multiplier ?? 1;
  const adv = new Float64Array(N * T).fill(NaN);
  const cs = new Float64Array(N * T).fill(NaN);
  for (let c = 0; c < N; c++) {
    let sum = 0;
    let n = 0;
    let csSum = 0;
    let csN = 0;
    const csDaily = new Float64Array(T).fill(NaN);
    for (let t = 1; t < T; t++) {
      const i = c * T + t;
      if (panel.has[i] && panel.has[i - 1]) csDaily[t] = corwinSchultzBps(panel.high[i - 1]!, panel.low[i - 1]!, panel.high[i]!, panel.low[i]!);
    }
    for (let t = 0; t < T; t++) {
      // Known at the open of t: sessions t-20 .. t-1.
      if (n >= 1) adv[c * T + t] = sum / n;
      if (csN >= 5) cs[c * T + t] = csSum / csN;
      const i = c * T + t;
      const dv = panel.has[i] ? panel.dv[i]! : NaN;
      if (Number.isFinite(dv)) {
        sum += dv;
        n++;
      }
      if (Number.isFinite(csDaily[t]!)) {
        csSum += csDaily[t]!;
        csN++;
      }
      if (t >= 20) {
        const j = c * T + t - 20;
        const old = panel.has[j] ? panel.dv[j]! : NaN;
        if (Number.isFinite(old)) {
          sum -= old;
          n--;
        }
        if (Number.isFinite(csDaily[t - 20]!)) {
          csSum -= csDaily[t - 20]!;
          csN--;
        }
      }
    }
  }
  const floorAt = (c: number, t: number) => {
    const raw = t > 0 ? panel.raw[c * T + t - 1]! : panel.raw[c * T]!;
    return floorBps(adv[c * T + t]!, raw, cs[c * T + t]!);
  };
  return {
    commission: (opts.commissionBps / 10_000) * mult,
    adv: (c, t) => adv[c * T + t]!,
    csBps: (c, t) => cs[c * T + t]!,
    floor: floorAt,
    halfSpread(c, t) {
      if (opts.noFloor) return (typeof opts.spread === "number" ? opts.spread : 0) / 10_000 * mult;
      const f = floorAt(c, t);
      const bps = opts.spread === "auto" ? f : Math.max(opts.spread, f);
      return (bps / 10_000) * mult;
    },
  };
}
