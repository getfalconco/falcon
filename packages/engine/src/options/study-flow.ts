/**
 * Stock order-flow hypotheses (Obsidian `Falcon/Engine/Options Signals.md`,
 * order flow, H1 and H3), pre-registered in
 * data/preregistration/flow-v1.json. The runner is scripts/flow-study.ts;
 * the write-up docs/flow-study.md.
 *
 *   H1 quiet accumulation: net aggressive buying over 5 sessions while the
 *      price stays flat against its own volatility -> abnormal return over
 *      the next 10 sessions, against same-date universe names without a
 *      signal.
 *   H3 ripple + flow: linked hits of semis events whose signed flow in the
 *      3 sessions from the reaction day goes the implied way, against hits
 *      whose flow does not.
 *
 * Features come from flow.ts unchanged; measurement from study/abnormal.ts;
 * tests from study/stats.ts plus a clustered two-group difference and
 * Benjamini-Hochberg here.
 *
 * Pure: no fs, no network, no clock. Randomness only through a seeded PRNG.
 */

import { measureEvent, sessionCloseMs, type PriceSeries } from "../study/abnormal.ts";
import { clusteredMeanTest, median, seededRandom, tOneSidedP, twoWayMeanTest, type MeanTest } from "../study/stats.ts";
import { quietAccumulation, type FlowDay, type QuietOptions, type QuietRow } from "./flow.ts";

/** The pre-registered universe (flow-v1.json). */
export const FLOW_UNIVERSE = [
  "INTC", "NXPI", "QCOM", "AVGO", "MTSI", "SLAB", "LSCC", "AMKR", "ADI", "GFS", "MCHP", "MRVL", "TXN", "KLAC",
  "LRCX", "ALGM", "CDNS", "CRDO", "CRUS", "MU", "NVMI", "SITM", "AMAT", "ASML", "SWKS", "SMTC", "MXL", "SYNA",
] as const;

export const FLOW_FROM = "2023-06-26";
export const FLOW_TO = "2024-06-28";
export const CALLER = "flow-hypotheses";
export const CALLER_CAP_USD = 35;
/** 10 bp per side, in percent, for one round trip. */
export const ROUND_TRIP_PCT = 0.2;

export const H1_RULES = {
  window: 5,
  volLookback: 60,
  quietZ: 0.5,
  zCap: 1,
  minSignedShare: 0.02,
  /** Name-own percentile of window imbalance for the threshold. */
  thetaQuantile: 0.8,
  /** Sessions between two events of one name (the outcome horizon). */
  gap: 10,
  horizon: 10,
} as const;

export const H3_RULES = { flowSessions: 3, horizon: 10, ownEarningsBefore: 1, ownEarningsAfter: 12 } as const;

// ---------------------------------------------------------------------------
// Small helpers

/** Linear-interpolated quantile (type 7) of finite values; NaN when none. */
export function quantile(xs: readonly number[], q: number): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const h = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
}

/** A flow day with no trades (a session the pull has nothing for): signedShare 0, so it never counts toward a window. */
export function emptyFlowDay(date: string): FlowDay {
  return {
    date,
    trades: 0,
    volume: 0,
    buyVolume: 0,
    sellVolume: 0,
    unknownVolume: 0,
    buyDollar: 0,
    sellDollar: 0,
    unknownDollar: 0,
    auctionVolume: 0,
    netSignedDollar: 0,
    imbalance: null,
    dollarImbalance: null,
    signedShare: 0,
    vwap: null,
  };
}

/** One flow day per session (missing sessions filled with empty days), in session order. */
export function fillSessions(days: readonly FlowDay[], sessions: readonly string[]): FlowDay[] {
  const by = new Map(days.map((d) => [d.date, d]));
  return sessions.map((s) => by.get(s) ?? emptyFlowDay(s));
}

/**
 * Indices kept when events of one name must be at least `gap` sessions
 * apart: the first, then the next at index >= previous kept + gap. Input
 * sorted ascending. Pure.
 */
export function deOverlap(indices: readonly number[], gap: number): number[] {
  const out: number[] = [];
  for (const i of indices) if (!out.length || i - out[out.length - 1]! >= gap) out.push(i);
  return out;
}

/**
 * Benjamini-Hochberg: which hypotheses are rejected at false discovery rate
 * q (step-up: the largest k with p_(k) <= k q / m, and all smaller). Pure.
 */
export function benjaminiHochberg(ps: readonly number[], q = 0.05): boolean[] {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  let k = -1;
  order.forEach(([p], r) => {
    if (p <= ((r + 1) * q) / m) k = r;
  });
  const out = new Array<boolean>(m).fill(false);
  for (let r = 0; r <= k; r++) out[order[r]![1]] = true;
  return out;
}

export type DiffTest = {
  /** Mean of group 1 minus mean of group 0. */
  diff: number;
  se: number;
  t: number;
  df: number;
  /** One-sided p for diff > 0. */
  pOneSided: number;
  n1: number;
  n0: number;
  mean1: number;
  mean0: number;
  clusters: number;
};

/**
 * Difference of two group means as OLS of y on [1, g], with a CR1 cluster
 * robust SE (factor G/(G-1) (N-1)/(N-2)), t on G-1 df. Pure.
 */
export function clusteredDiffTest(ys: readonly number[], groups: readonly boolean[], keys: readonly string[]): DiffTest {
  const n = ys.length;
  let n1 = 0;
  let s1 = 0;
  let s0 = 0;
  for (let i = 0; i < n; i++) {
    if (groups[i]) {
      n1++;
      s1 += ys[i]!;
    } else s0 += ys[i]!;
  }
  const n0 = n - n1;
  const mean1 = n1 ? s1 / n1 : NaN;
  const mean0 = n0 ? s0 / n0 : NaN;
  const diff = mean1 - mean0;
  // X = [1, g]; (X'X)^-1 for a dummy regression; scores per cluster.
  const a = n;
  const b = n1;
  const det = a * b - b * b;
  const per = new Map<string, [number, number]>();
  for (let i = 0; i < n; i++) {
    const g = groups[i] ? 1 : 0;
    const u = ys[i]! - (g ? mean1 : mean0);
    const cur = per.get(keys[i]!) ?? [0, 0];
    cur[0] += u;
    cur[1] += g * u;
    per.set(keys[i]!, cur);
  }
  const G = per.size;
  let m00 = 0;
  let m01 = 0;
  let m11 = 0;
  for (const [s0c, s1c] of per.values()) {
    m00 += s0c * s0c;
    m01 += s0c * s1c;
    m11 += s1c * s1c;
  }
  // Var(beta_g) = row 2 of (X'X)^-1 M (X'X)^-1, entry [1][1]; (X'X)^-1 = [[b, -b], [-b, a]] / det.
  const i10 = -b / det;
  const i11 = a / det;
  let v = i10 * i10 * m00 + 2 * i10 * i11 * m01 + i11 * i11 * m11;
  const k = G > 1 && n > 2 ? (G / (G - 1)) * ((n - 1) / (n - 2)) : NaN;
  v *= k;
  const se = Math.sqrt(v);
  const t = diff / se;
  const df = G - 1;
  return { diff, se, t, df, pOneSided: Number.isFinite(t) && df > 0 ? tOneSidedP(t, df) : 1, n1, n0, mean1, mean0, clusters: G };
}

export type Summary = {
  n: number;
  /** Independent dates (clusters). */
  g: number;
  mean: number;
  median: number;
  t: number;
  /** One-sided p for mean > 0 (date-clustered). */
  p: number;
  /** Share above zero. */
  hitRate: number;
};

/** Date-clustered one-sample summary; values in the caller's units. Null when empty. */
export function summarize(values: readonly number[], dates: readonly string[]): Summary | null {
  const ok = values.map((v, i) => [v, dates[i]!] as const).filter(([v]) => Number.isFinite(v));
  if (!ok.length) return null;
  const ys = ok.map((x) => x[0]);
  const ks = ok.map((x) => x[1]);
  const test: MeanTest & { clusters: number } = clusteredMeanTest(ys, ks);
  return {
    n: ys.length,
    g: test.clusters,
    mean: test.mean,
    median: median(ys),
    t: test.t,
    p: Number.isFinite(test.t) && test.df > 0 ? tOneSidedP(test.t, test.df) : 1,
    hitRate: ys.filter((y) => y > 0).length / ys.length,
  };
}

/** Earlier and later halves by date (median split: the first floor(n/2) by date are "early"). */
export function splitHalves<T extends { date: string }>(xs: readonly T[]): { early: T[]; late: T[] } {
  const s = [...xs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const h = Math.floor(s.length / 2);
  return { early: s.slice(0, h), late: s.slice(h) };
}

// ---------------------------------------------------------------------------
// Outcomes

export type Outcome = { car5: number; car10: number };

/**
 * Market-model CARs (fractions) for an entry at the open after session index
 * `t` (the public instant is 1 s after t's close). NaN where not measurable.
 */
export function outcomeAfter(sessions: readonly string[], stock: PriceSeries, market: PriceSeries, t: number): Outcome {
  const m = measureEvent({ sessions, stock, market, publicMs: sessionCloseMs(sessions[t]!) + 1000, windows: [5, 10] });
  if (!m.ok) return { car5: NaN, car10: NaN };
  return { car5: m.drift[5]?.car ?? NaN, car10: m.drift[10]?.car ?? NaN };
}

// ---------------------------------------------------------------------------
// H1

export type NamePanel = {
  ticker: string;
  /** Quiet rows, one per window-end session of the flow calendar (index aligned to `flowSessions` from window - 1 on). */
  rows: QuietRow[];
};

export type H1Signal = { ticker: string; date: string; row: QuietRow };

export type H1Options = { window: number; theta: "own80" | number; side: "buy" | "sell" };

/** Name-own threshold: max(0, q-quantile of full-window imbalances); for side "sell" min(0, (1-q)-quantile). Pure. */
export function thetaOf(rows: readonly QuietRow[], window: number, q: number, side: "buy" | "sell"): number {
  const xs = rows.filter((r) => r.windowDays === window && r.imbalance !== null).map((r) => r.imbalance!);
  if (side === "buy") return Math.max(0, quantile(xs, q));
  return Math.min(0, quantile(xs, 1 - q));
}

/** Whether a row passes the flow part of the rule (direction and threshold). Pure. */
export function flowPass(r: QuietRow, window: number, theta: number, side: "buy" | "sell"): boolean {
  if (r.windowDays !== window || r.imbalance === null) return false;
  return side === "buy" ? r.netSignedDollar > 0 && r.imbalance >= theta : r.netSignedDollar < 0 && r.imbalance <= theta;
}

/** Whether a row is quiet (|move| small against the name's own volatility). Pure. */
export function quietPass(r: QuietRow, quietZ: number = H1_RULES.quietZ): boolean {
  return r.zMove !== null && r.zMove <= quietZ;
}

/** Quiet rows for a name from session-filled flow and closes. Pure. */
export function quietRows(flow: readonly FlowDay[], closes: ReadonlyArray<{ date: string; close: number }>, window: number): QuietRow[] {
  const o: Partial<QuietOptions> = { window, volLookback: H1_RULES.volLookback, quietZ: H1_RULES.quietZ, zCap: H1_RULES.zCap, minSignedShare: H1_RULES.minSignedShare };
  return quietAccumulation(flow, closes, o);
}

export type H1Event = { ticker: string; date: string; index: number; car10: number; car5: number; control10: number; control5: number; sameName10: number };

export type H1Input = {
  /** Full session calendar the price series are aligned to. */
  sessions: readonly string[];
  /** ticker -> date -> outcome for an entry at the next open. */
  outcomes: ReadonlyMap<string, ReadonlyMap<string, Outcome>>;
  /** ticker -> raw signal dates (before de-overlap). */
  signals: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every date a name is in the test (has a full window), ticker -> dates. */
  eligible: ReadonlyMap<string, readonly string[]>;
  gap: number;
};

/**
 * Events (de-overlapped signals) with their same-date control (mean outcome
 * of eligible names with no raw signal that date) and the same name's mean
 * outcome over its non-signal dates. Pure.
 */
export function h1Events(input: H1Input): H1Event[] {
  const idx = new Map(input.sessions.map((d, i) => [d, i]));
  // Same-date controls.
  const ctrl = new Map<string, { s10: number; n10: number; s5: number; n5: number }>();
  const nameMean = new Map<string, number>();
  for (const [t, dates] of input.eligible) {
    const sig = input.signals.get(t) ?? new Set<string>();
    const out = input.outcomes.get(t);
    let s = 0;
    let n = 0;
    for (const d of dates) {
      if (sig.has(d)) continue;
      const o = out?.get(d);
      if (!o) continue;
      const c = ctrl.get(d) ?? { s10: 0, n10: 0, s5: 0, n5: 0 };
      if (Number.isFinite(o.car10)) {
        c.s10 += o.car10;
        c.n10++;
        s += o.car10;
        n++;
      }
      if (Number.isFinite(o.car5)) {
        c.s5 += o.car5;
        c.n5++;
      }
      ctrl.set(d, c);
    }
    nameMean.set(t, n ? s / n : NaN);
  }
  const events: H1Event[] = [];
  for (const [t, sig] of input.signals) {
    const ii = [...sig].map((d) => idx.get(d)).filter((i): i is number => i !== undefined).sort((a, b) => a - b);
    for (const i of deOverlap(ii, input.gap)) {
      const date = input.sessions[i]!;
      const o = input.outcomes.get(t)?.get(date);
      const c = ctrl.get(date);
      events.push({
        ticker: t,
        date,
        index: i,
        car10: o?.car10 ?? NaN,
        car5: o?.car5 ?? NaN,
        control10: c && c.n10 ? c.s10 / c.n10 : NaN,
        control5: c && c.n5 ? c.s5 / c.n5 : NaN,
        sameName10: nameMean.get(t) ?? NaN,
      });
    }
  }
  return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ticker < b.ticker ? -1 : 1));
}

/** Primary H1 value of an event, percent: CAR10 minus the same-date control. */
export function h1Primary(e: Pick<H1Event, "car10" | "control10">): number {
  return (e.car10 - e.control10) * 100;
}

/**
 * Placebo signal sets: the flow-pass flags shuffled across names within each
 * date (the count per date kept), each name's own quiet flag kept. Pure.
 */
export function shuffledSignals(
  perDate: ReadonlyMap<string, ReadonlyArray<{ ticker: string; flow: boolean; quiet: boolean }>>,
  rnd: () => number,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [date, rows] of perDate) {
    const flags = rows.map((r) => r.flow);
    for (let i = flags.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [flags[i], flags[j]] = [flags[j]!, flags[i]!];
    }
    rows.forEach((r, i) => {
      if (flags[i] && r.quiet) {
        if (!out.has(r.ticker)) out.set(r.ticker, new Set());
        out.get(r.ticker)!.add(date);
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// H3

export type Direction = 1 | -1;

export type RippleEvent = {
  ticker: string;
  kind: "earnings" | "monthly_revenue";
  accession: string;
  /** Session index of day 0 in the calendar. */
  day0: number;
  sign: Direction;
};

export type HitCandidate = { hit: string; day0: number; direction: Direction; event: string; relation: string; supplyChain: boolean };

/**
 * One hit per (ticker, day 0): kept once when every event agrees on the
 * direction, dropped when they disagree; supplyChain true if any of the
 * events links through a supply-chain or partner edge. Pure.
 */
export function dedupHits(cands: readonly HitCandidate[]): HitCandidate[] {
  const by = new Map<string, HitCandidate[]>();
  for (const c of cands) {
    const k = `${c.hit}|${c.day0}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(c);
  }
  const out: HitCandidate[] = [];
  for (const list of by.values()) {
    const dirs = new Set(list.map((c) => c.direction));
    if (dirs.size !== 1) continue;
    const first = list[0]!;
    out.push({ ...first, event: list.map((c) => c.event).join("+"), supplyChain: list.some((c) => c.supplyChain) });
  }
  return out.sort((a, b) => a.day0 - b.day0 || (a.hit < b.hit ? -1 : 1));
}

/** Whether a hit has its own earnings reaction day within [day0 - before, day0 + after]. Pure. */
export function ownEventNear(ownDay0s: readonly number[] | undefined, day0: number, before: number, after: number): boolean {
  return (ownDay0s ?? []).some((d) => d >= day0 - before && d <= day0 + after);
}

export type FlowSum = { net: number; buy: number; sell: number; days: number };

/** Signed dollars over sessions [from, to] of a session-indexed flow array (missing days add nothing). Pure. */
export function flowSum(flow: ReadonlyArray<FlowDay | undefined>, from: number, to: number): FlowSum {
  let buy = 0;
  let sell = 0;
  let days = 0;
  for (let i = from; i <= to; i++) {
    const d = flow[i];
    if (!d || d.buyDollar + d.sellDollar <= 0) continue;
    buy += d.buyDollar;
    sell += d.sellDollar;
    days++;
  }
  return { net: buy - sell, buy, sell, days };
}

/** Whether signed flow goes the implied way; null without signed volume. Pure. */
export function confirms(f: FlowSum, direction: Direction, bias = 0): boolean | null {
  if (f.buy + f.sell <= 0) return null;
  const imb = (f.buy - f.sell) / (f.buy + f.sell) - bias;
  if (imb === 0) return false;
  return Math.sign(imb) === direction;
}

/** Labels permuted within clusters (same key), seeded. Pure. */
export function permuteWithin(labels: readonly boolean[], keys: readonly string[], rnd: () => number): boolean[] {
  const by = new Map<string, number[]>();
  keys.forEach((k, i) => {
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(i);
  });
  const out = [...labels];
  for (const ids of by.values()) {
    const vals = ids.map((i) => labels[i]!);
    for (let i = vals.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [vals[i], vals[j]] = [vals[j]!, vals[i]!];
    }
    ids.forEach((id, k) => (out[id] = vals[k]!));
  }
  return out;
}

/** Permutation p (one-sided, >=) of a statistic over `reps` seeded relabelings. Pure. */
export function permutationP(observed: number, reps: number, seed: number, stat: (rnd: () => number) => number): { p: number; nullMean: number; nullSd: number } {
  const rnd = seededRandom(seed);
  let hits = 0;
  let s = 0;
  let ss = 0;
  let n = 0;
  for (let r = 0; r < reps; r++) {
    const v = stat(rnd);
    if (!Number.isFinite(v)) continue;
    n++;
    s += v;
    ss += v * v;
    if (v >= observed - 1e-12) hits++;
  }
  const m = n ? s / n : NaN;
  return { p: (hits + 1) / (n + 1), nullMean: m, nullSd: n > 1 ? Math.sqrt(Math.max(0, (ss - n * m * m) / (n - 1))) : NaN };
}

/** Two-way (firm x month) clustered one-sided p for mean > 0. Pure. */
export function twoWayP(values: readonly number[], firms: readonly string[], dates: readonly string[]): { t: number; p: number } {
  const tw = twoWayMeanTest(values, firms, dates.map((d) => d.slice(0, 7)));
  return { t: tw.t, p: Number.isFinite(tw.t) && tw.df > 0 ? tOneSidedP(tw.t, tw.df) : 1 };
}
