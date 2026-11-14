/**
 * The FSL evaluator: walks a checked AST over Float64Array panels. No eval,
 * no Function. Every operator reads only index t and earlier, so a decision
 * at t never changes when later data is added (the prefix property test and
 * the per-run sampled cut check this).
 *
 * Layout: a series is column-major over the context's tickers, value (u, t)
 * at u * T + t. A market value is one Float64Array of length T. Conditions
 * are 0/1 (NaN compares as false, as in the v1 engine).
 *
 * Clocks: on the close clock a formula at session t reads bars up to close t.
 * On the preopen clock (decided at 09:15 New York time on t) every price
 * operator reads session t - 1; events are already placed on the right
 * session by the caller (see `placeEvents` in ../prepare.ts).
 */

import { ema as emaArr, rsi as rsiArr } from "../indicators";
import { isMonthEnd, isQuarterEnd, isoToDay, tdom, weekday } from "../calendar";
import { ALIASES, SELF } from "./check";
import { parse, type Node } from "./parse";

export type Panel = {
  /** Sessions, oldest first, warm-up included. */
  dates: string[];
  tickers: string[];
  col: Map<string, number>;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  /** Unadjusted close (Yahoo: split-adjusted close times later splits). */
  raw: Float64Array;
  volume: Float64Array;
  /** Close times volume, both split-adjusted, so the product is the dollars that traded. */
  dv: Float64Array;
  /** 1 where the ticker has a real bar that session (prices are carried forward over gaps). */
  has: Uint8Array;
};

export type EarningsRow = { session: number; surprise: number | null };
export type ReactionRow = { session: number; value: number };
export type RippleRow = {
  session: number;
  relation: string;
  degree: number;
  eventKind: string;
  eventSign: number;
  impliedDir: number;
  edgeTier: string;
  coverage: string;
};

export type EventInputs = {
  earnings: Map<string, EarningsRow[]>;
  reactions: Map<string, ReactionRow[]>;
  ripple: Map<string, RippleRow[]>;
};

export type EvalEnv = {
  panel: Panel;
  /** The tickers the strategy trades: the columns of a series. */
  universe: string[];
  /** Resolved values ($pct already divided by 100). */
  params: Record<string, number>;
  defs: Record<string, string>;
  /** Daily T-bill return applied to each session (known before it starts). */
  tbill: Float64Array;
  clock: "close" | "preopen";
  events: EventInputs;
  /** Weights mode: weights already computed, for w(). */
  weights?: Map<string, Float64Array>;
  /** Evaluate only up to this session (inclusive); later values are NaN. Used by the prefix check. */
  lastIndex?: number;
};

type Val =
  | { s: "c"; v: number }
  | { s: "str"; v: string }
  | { s: "m"; v: Float64Array }
  | { s: "x"; v: Float64Array; cols: number };

type Ctx = { cols: number[]; tickers: string[]; key: string; single: boolean };

export type Evaluated =
  | { shape: "const"; value: number }
  | { shape: "market"; value: Float64Array }
  | { shape: "series"; value: Float64Array; tickers: string[] };

const LABELS = new Map<string, number>();
/** Labels (ripple.relation, ...) become numeric codes; a quoted label compares by code. */
export function labelCode(s: string): number {
  const k = s.trim().toLowerCase();
  let c = LABELS.get(k);
  if (c === undefined) {
    c = LABELS.size + 1;
    LABELS.set(k, c);
  }
  return c;
}

export class Evaluator {
  private T: number;
  private memo = new Map<string, Val>();
  private dayNums: number[];
  private calCache = new Map<string, Float64Array>();

  constructor(private env: EvalEnv) {
    this.T = env.panel.dates.length;
    this.dayNums = env.panel.dates.map(isoToDay);
  }

  private universeCtx(): Ctx {
    const cols = this.env.universe.map((t) => {
      const c = this.env.panel.col.get(t);
      if (c === undefined) throw new Error(`No data column for ${t}.`);
      return c;
    });
    return { cols, tickers: this.env.universe, key: this.env.universe.join(","), single: false };
  }

  /** Evaluates a formula in the universe context (or with no ticker context for weights). */
  run(src: string): Evaluated {
    const node = parse(src);
    const v = this.ev(node, this.universeCtx());
    return this.out(v, this.env.universe);
  }

  private out(v: Val, tickers: string[]): Evaluated {
    if (v.s === "c") return { shape: "const", value: v.v };
    if (v.s === "m") return { shape: "market", value: this.cut(v.v) };
    if (v.s === "x") return { shape: "series", value: this.cutSeries(v.v, v.cols), tickers };
    throw new Error("A label is not a value.");
  }

  private cut(a: Float64Array): Float64Array {
    const last = this.env.lastIndex;
    if (last === undefined || last >= this.T - 1) return a;
    const b = a.slice();
    b.fill(NaN, last + 1);
    return b;
  }

  private cutSeries(a: Float64Array, cols: number): Float64Array {
    const last = this.env.lastIndex;
    if (last === undefined || last >= this.T - 1) return a;
    const b = a.slice();
    for (let u = 0; u < cols; u++) b.fill(NaN, u * this.T + last + 1, (u + 1) * this.T);
    return b;
  }

  // ---------------------------------------------------------------- helpers

  private num(v: Val): number {
    if (v.s !== "c") throw new Error("Expected a constant.");
    return v.v;
  }

  /** Window or count argument: a literal or a $param (already resolved to a number). */
  private win(n: Node): number {
    if (n.k === "num") return n.v;
    if (n.k === "param") return Math.round(this.param(n.name));
    throw new Error("Window must be a number or a parameter.");
  }

  private param(name: string): number {
    const v = this.env.params[name];
    if (v === undefined || !Number.isFinite(v)) throw new Error(`Parameter $${name} has no value.`);
    return v;
  }

  /** Applies f to each column of a market or series value (as one column for a market). */
  private perCol(v: Val, f: (x: Float64Array, u: number) => Float64Array): Val {
    const T = this.T;
    if (v.s === "c") {
      const a = new Float64Array(T).fill(v.v);
      return { s: "m", v: f(a, 0) };
    }
    if (v.s === "m") return { s: "m", v: f(v.v, 0) };
    if (v.s === "x") {
      const out = new Float64Array(v.v.length);
      for (let u = 0; u < v.cols; u++) out.set(f(v.v.subarray(u * T, (u + 1) * T), u), u * T);
      return { s: "x", v: out, cols: v.cols };
    }
    throw new Error("A label cannot be used here.");
  }

  /** Elementwise over broadcast shapes. */
  private zip(vals: Val[], f: (...xs: number[]) => number): Val {
    const T = this.T;
    let cols = 0;
    let market = false;
    for (const v of vals) {
      if (v.s === "x") cols = Math.max(cols, v.cols);
      else if (v.s === "m") market = true;
      else if (v.s === "str") throw new Error("A label cannot be used here.");
    }
    const get = (v: Val, u: number, t: number): number => (v.s === "c" ? v.v : v.s === "m" ? v.v[t]! : (v as { v: Float64Array }).v[u * T + t]!);
    if (cols > 0) {
      const out = new Float64Array(cols * T);
      const xs = new Array<number>(vals.length);
      for (let u = 0; u < cols; u++) {
        for (let t = 0; t < T; t++) {
          for (let k = 0; k < vals.length; k++) xs[k] = get(vals[k]!, u, t);
          out[u * T + t] = f(...xs);
        }
      }
      return { s: "x", v: out, cols };
    }
    if (market) {
      const out = new Float64Array(T);
      const xs = new Array<number>(vals.length);
      for (let t = 0; t < T; t++) {
        for (let k = 0; k < vals.length; k++) xs[k] = get(vals[k]!, 0, t);
        out[t] = f(...xs);
      }
      return { s: "m", v: out };
    }
    return { s: "c", v: f(...vals.map((v) => (v as { v: number }).v)) };
  }

  private priceSeries(field: "open" | "high" | "low" | "close" | "raw" | "volume" | "dv", ctx: Ctx): Val {
    const T = this.T;
    const src = this.env.panel[field];
    const out = new Float64Array(ctx.cols.length * T);
    const lag = this.env.clock === "preopen" ? 1 : 0;
    ctx.cols.forEach((c, u) => {
      for (let t = 0; t < T; t++) out[u * T + t] = t - lag >= 0 ? src[c * T + t - lag]! : NaN;
    });
    return this.wrap(out, ctx);
  }

  private wrap(series: Float64Array, ctx: Ctx): Val {
    return ctx.single ? { s: "m", v: series.slice(0, this.T) } : { s: "x", v: series, cols: ctx.cols.length };
  }

  private calendar(name: string): Float64Array {
    let a = this.calCache.get(name);
    if (a) return a;
    a = new Float64Array(this.T);
    for (let t = 0; t < this.T; t++) {
      const d = this.dayNums[t]!;
      switch (name) {
        case "dow":
          a[t] = weekday(d);
          break;
        case "month":
          a[t] = new Date(d * 86_400_000).getUTCMonth() + 1;
          break;
        case "tdom": {
          // Positive from the month start; a rule tdom == -1 reads the end count (see tdomEnd).
          a[t] = tdom(d).fromStart;
          break;
        }
        case "tdom_end":
          a[t] = tdom(d).fromEnd;
          break;
        case "is_month_end":
          a[t] = isMonthEnd(d) ? 1 : 0;
          break;
        case "is_quarter_end":
          a[t] = isQuarterEnd(d) ? 1 : 0;
          break;
      }
    }
    this.calCache.set(name, a);
    return a;
  }

  private eventSeries(name: string, ctx: Ctx): Val {
    const T = this.T;
    const out = new Float64Array(ctx.cols.length * T).fill(NaN);
    const isBool = name === "earnings.event" || name === "ripple.event";
    ctx.tickers.forEach((ticker, u) => {
      const base = u * T;
      if (isBool) out.fill(0, base, base + T);
      if (name.startsWith("earnings.")) {
        if (name === "earnings.reaction_abn") {
          for (const r of this.env.events.reactions.get(ticker) ?? []) if (r.session >= 0 && r.session < T) out[base + r.session] = r.value;
          return;
        }
        const rows = this.env.events.earnings.get(ticker) ?? [];
        if (name === "earnings.event") for (const r of rows) if (r.session >= 0 && r.session < T) out[base + r.session] = 1;
        if (name === "earnings.surprise") {
          for (const r of rows) if (r.session >= 0 && r.session < T && r.surprise !== null) out[base + r.session] = r.surprise;
        }
        if (name === "earnings.days_since") fillDaysSince(out, base, T, rows.map((r) => r.session));
        return;
      }
      const rows = this.env.events.ripple.get(ticker) ?? [];
      if (name === "ripple.days_since") return fillDaysSince(out, base, T, rows.map((r) => r.session));
      for (const r of rows) {
        if (r.session < 0 || r.session >= T) continue;
        const i = base + r.session;
        switch (name) {
          case "ripple.event":
            out[i] = 1;
            break;
          case "ripple.relation":
            out[i] = labelCode(r.relation);
            break;
          case "ripple.degree":
            out[i] = r.degree;
            break;
          case "ripple.event_kind":
            out[i] = labelCode(r.eventKind);
            break;
          case "ripple.event_sign":
            out[i] = r.eventSign;
            break;
          case "ripple.implied_dir":
            out[i] = r.impliedDir;
            break;
          case "ripple.edge_tier":
            out[i] = labelCode(r.edgeTier);
            break;
          case "ripple.coverage":
            out[i] = labelCode(r.coverage);
            break;
        }
      }
    });
    return this.wrap(out, ctx);
  }

  // ---------------------------------------------------------------- the walk

  ev(n: Node, ctx: Ctx): Val {
    switch (n.k) {
      case "num":
        return { s: "c", v: n.v };
      case "bool":
        return { s: "c", v: n.v ? 1 : 0 };
      case "str":
        return { s: "str", v: n.v };
      case "param":
        return { s: "c", v: this.param(n.name) };
      case "ident":
        return this.ident(n.name, ctx);
      case "un": {
        const a = this.ev(n.a, ctx);
        return n.op === "not" ? this.zip([a], (x) => (x > 0 ? 0 : 1)) : this.zip([a], (x) => -x);
      }
      case "bin":
        return this.bin(n, ctx);
      case "call":
        return this.call(n, ctx);
    }
  }

  private ident(name: string, ctx: Ctx): Val {
    switch (name) {
      case "open":
      case "high":
      case "low":
      case "close":
        return this.priceSeries(name, ctx);
      case "raw_close":
        return this.priceSeries("raw", ctx);
      case "volume":
        return this.priceSeries("volume", ctx);
      case "dollar_volume":
        return this.priceSeries("dv", ctx);
      case "dow":
      case "month":
      case "tdom":
      case "is_month_end":
      case "is_quarter_end":
        return { s: "m", v: this.calendar(name) };
    }
    if (name.startsWith("earnings.") || name.startsWith("ripple.")) return this.eventSeries(name, ctx);
    const def = this.env.defs[name];
    if (def !== undefined) {
      const key = `def:${name}|${ctx.key}|${ctx.single}`;
      let v = this.memo.get(key);
      if (!v) {
        v = this.ev(parse(def), ctx);
        this.memo.set(key, v);
      }
      return v;
    }
    throw new Error(`Unknown name ${name}.`);
  }

  private bin(n: Extract<Node, { k: "bin" }>, ctx: Ctx): Val {
    // tdom == -k reads the count from the month end.
    if ((n.op === "==" || n.op === "!=") && isTdomEnd(n)) {
      const k = (n.a.k === "num" ? n.a.v : (n.b as { v: number }).v) as number;
      const end = this.calendar("tdom_end");
      const eq = n.op === "==";
      return this.zip([{ s: "m", v: end }], (x) => ((x === k) === eq ? 1 : 0));
    }
    const a = this.ev(n.a, ctx);
    const b = this.ev(n.b, ctx);
    if (a.s === "str" || b.s === "str") {
      const code = labelCode(a.s === "str" ? a.v : (b as { v: string }).v);
      const other = a.s === "str" ? b : a;
      const eq = n.op === "==";
      return this.zip([other], (x) => (Number.isNaN(x) ? 0 : (x === code) === eq ? 1 : 0));
    }
    switch (n.op) {
      case "+":
        return this.zip([a, b], (x, y) => x + y);
      case "-":
        return this.zip([a, b], (x, y) => x - y);
      case "*":
        return this.zip([a, b], (x, y) => x * y);
      case "/":
        return this.zip([a, b], (x, y) => (y === 0 ? NaN : x / y));
      case "<":
        return this.zip([a, b], (x, y) => (x < y ? 1 : 0));
      case "<=":
        return this.zip([a, b], (x, y) => (x <= y ? 1 : 0));
      case ">":
        return this.zip([a, b], (x, y) => (x > y ? 1 : 0));
      case ">=":
        return this.zip([a, b], (x, y) => (x >= y ? 1 : 0));
      case "==":
        return this.zip([a, b], (x, y) => (x === y ? 1 : 0));
      case "!=":
        return this.zip([a, b], (x, y) => (!Number.isNaN(x) && !Number.isNaN(y) && x !== y ? 1 : 0));
      case "and":
        return this.zip([a, b], (x, y) => (x > 0 && y > 0 ? 1 : 0));
      case "or":
        return this.zip([a, b], (x, y) => (x > 0 || y > 0 ? 1 : 0));
    }
  }

  private call(n: Extract<Node, { k: "call" }>, ctx: Ctx): Val {
    const fn = ALIASES[n.fn] ?? n.fn;
    const A = n.args;
    const x = () => this.ev(A[0]!, ctx);
    const T = this.T;
    switch (fn) {
      case "delay": {
        const k = this.win(A[1]!);
        return this.perCol(x(), (a) => shift(a, k));
      }
      case "delta": {
        const k = A[1] ? this.win(A[1]) : 1;
        return this.perCol(x(), (a) => {
          const o = new Float64Array(a.length).fill(NaN);
          for (let t = k; t < a.length; t++) o[t] = a[t]! - a[t - k]!;
          return o;
        });
      }
      case "ret":
      case "logret": {
        const k = A[1] ? this.win(A[1]) : 1;
        return this.perCol(x(), (a) => {
          const o = new Float64Array(a.length).fill(NaN);
          for (let t = k; t < a.length; t++) {
            const b = a[t - k]!;
            if (b > 0 && a[t]! > 0) o[t] = fn === "ret" ? a[t]! / b - 1 : Math.log(a[t]! / b);
          }
          return o;
        });
      }
      case "ts_mean":
        return this.perCol(x(), (a) => rolling(a, this.win(A[1]!), "mean"));
      case "ts_sum":
        return this.perCol(x(), (a) => rolling(a, this.win(A[1]!), "sum"));
      case "ts_std":
        return this.perCol(x(), (a) => rolling(a, this.win(A[1]!), "std"));
      case "ts_max":
        return this.perCol(x(), (a) => rollingExt(a, this.win(A[1]!), "max"));
      case "ts_min":
        return this.perCol(x(), (a) => rollingExt(a, this.win(A[1]!), "min"));
      case "ts_zscore":
        return this.perCol(x(), (a) => {
          const n2 = this.win(A[1]!);
          const m = rolling(a, n2, "mean");
          const s = rolling(a, n2, "std");
          const o = new Float64Array(a.length);
          for (let t = 0; t < a.length; t++) o[t] = s[t]! > 0 ? (a[t]! - m[t]!) / s[t]! : NaN;
          return o;
        });
      case "ts_rank":
        return this.perCol(x(), (a) => tsRank(a, this.win(A[1]!)));
      case "wma":
        return this.perCol(x(), (a) => wma(a, this.win(A[1]!)));
      case "ema":
        return this.perCol(x(), (a) => segments(a, (seg) => emaArr(seg, this.win(A[1]!))));
      case "rsi": {
        if (A.length === 1) return this.perCol(this.priceSeries("close", ctx), (a) => segments(a, (seg) => rsiArr(seg, this.win(A[0]!))));
        return this.perCol(x(), (a) => segments(a, (seg) => rsiArr(seg, this.win(A[1]!))));
      }
      case "macd": {
        const f = this.win(A[1]!);
        const s = this.win(A[2]!);
        return this.perCol(x(), (a) => {
          const ef = segments(a, (seg) => emaArr(seg, f));
          const es = segments(a, (seg) => emaArr(seg, s));
          const o = new Float64Array(a.length);
          for (let t = 0; t < a.length; t++) o[t] = ef[t]! - es[t]!;
          return o;
        });
      }
      case "atr": {
        const n2 = this.win(A[0]!);
        const hi = this.priceSeries("high", ctx);
        const lo = this.priceSeries("low", ctx);
        const cl = this.priceSeries("close", ctx);
        const tr = this.zip([hi, lo, this.perCol(cl, (a) => shift(a, 1))], (h, l, pc) =>
          Number.isNaN(pc) ? h - l : Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)),
        );
        return this.perCol(tr, (a) => wilder(a, n2));
      }
      case "vol": {
        const n2 = this.win(A[0]!);
        return this.perCol(this.priceSeries("close", ctx), (a) => {
          const r = new Float64Array(a.length).fill(NaN);
          for (let t = 1; t < a.length; t++) if (a[t]! > 0 && a[t - 1]! > 0) r[t] = Math.log(a[t]! / a[t - 1]!);
          const s = rolling(r, n2, "std");
          for (let t = 0; t < s.length; t++) s[t] = s[t]! * Math.sqrt(252);
          return s;
        });
      }
      case "adv":
        return this.perCol(this.priceSeries("dv", ctx), (a) => rolling(a, this.win(A[0]!), "mean"));
      case "drawdown": {
        const n2 = A[1] ? this.win(A[1]) : 0;
        return this.perCol(x(), (a) => {
          const peak = n2 ? rollingExt(a, n2, "max") : runningMax(a);
          const o = new Float64Array(a.length);
          for (let t = 0; t < a.length; t++) o[t] = peak[t]! > 0 ? a[t]! / peak[t]! - 1 : NaN;
          return o;
        });
      }
      case "count":
        return this.perCol(x(), (a) => rolling(a, this.win(A[1]!), "sum"));
      case "streak":
        return this.perCol(x(), (a) => {
          const o = new Float64Array(a.length);
          let run = 0;
          for (let t = 0; t < a.length; t++) {
            run = a[t]! > 0 ? run + 1 : 0;
            o[t] = run;
          }
          return o;
        });
      case "days_since":
        return this.perCol(x(), (a) => {
          const o = new Float64Array(a.length).fill(NaN);
          let last = -1;
          for (let t = 0; t < a.length; t++) {
            if (a[t]! > 0) last = t;
            if (last >= 0) o[t] = t - last;
          }
          return o;
        });
      case "crosses_above":
      case "crosses_below": {
        const a = x();
        const b = this.ev(A[1]!, ctx);
        const pa = this.perCol(a, (s) => shift(s, 1));
        const pb = this.perCol(b, (s) => shift(s, 1));
        const up = fn === "crosses_above";
        return this.zip([a, b, pa, pb], (now, ref, prev, refPrev) => {
          if ([now, ref, prev, refPrev].some(Number.isNaN)) return 0;
          return up ? (prev <= refPrev && now > ref ? 1 : 0) : prev >= refPrev && now < ref ? 1 : 0;
        });
      }
      case "cs_rank":
      case "cs_zscore":
      case "cs_demean":
      case "top_n":
      case "bottom_n": {
        const v = x();
        const k = fn === "top_n" || fn === "bottom_n" ? this.win(A[1]!) : 0;
        return this.crossSection(v, ctx, fn, k);
      }
      case "at":
      case "of": {
        const t = (A[0] as { v: string }).v.trim().toUpperCase();
        const c = this.env.panel.col.get(t);
        if (c === undefined) {
          // No data for that ticker: every value is missing, so comparisons are false.
          return { s: "m", v: new Float64Array(T).fill(NaN) };
        }
        const inner: Ctx = { cols: [c], tickers: [t], key: t, single: true };
        const v = this.ev(A[1]!, inner);
        if (v.s === "x") return { s: "m", v: v.v.slice(0, T) };
        return v;
      }
      case "w": {
        const t = (A[0] as { v: string }).v.trim().toUpperCase();
        const w = this.env.weights?.get(t);
        if (!w) throw new Error(`w("${t}") is not computed yet.`);
        return { s: "m", v: w };
      }
      case "tbill_ret": {
        const n2 = this.win(A[0]!);
        const r = this.env.tbill;
        const o = new Float64Array(T).fill(NaN);
        let logSum = 0;
        for (let t = 0; t < T; t++) {
          logSum += Math.log1p(r[t] ?? 0);
          if (t >= n2) logSum -= Math.log1p(r[t - n2] ?? 0);
          if (t >= n2 - 1) o[t] = Math.expm1(logSum);
        }
        return { s: "m", v: o };
      }
      case "min":
        return this.zip([x(), this.ev(A[1]!, ctx)], (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.min(a, b)));
      case "max":
        return this.zip([x(), this.ev(A[1]!, ctx)], (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.max(a, b)));
      case "abs":
        return this.zip([x()], Math.abs);
      case "log":
        return this.zip([x()], (a) => (a > 0 ? Math.log(a) : NaN));
      case "sign":
        return this.zip([x()], (a) => (Number.isNaN(a) ? NaN : Math.sign(a)));
      case "clip":
        return this.zip([x(), this.ev(A[1]!, ctx), this.ev(A[2]!, ctx)], (a, lo, hi) => Math.min(hi, Math.max(lo, a)));
      case "if":
        return this.zip([x(), this.ev(A[1]!, ctx), this.ev(A[2]!, ctx)], (c, a, b) => (c > 0 ? a : b));
    }
    throw new Error(`Unknown function ${n.fn}.`);
  }

  private crossSection(v: Val, ctx: Ctx, fn: string, k: number): Val {
    if (v.s !== "x") {
      // A market or constant score is the same for every ticker.
      const cols = ctx.cols.length;
      const T = this.T;
      const out = new Float64Array(cols * T);
      for (let u = 0; u < cols; u++) {
        for (let t = 0; t < T; t++) {
          const val = v.s === "c" ? v.v : v.s === "m" ? v.v[t]! : NaN;
          out[u * T + t] = Number.isNaN(val) ? (fn === "top_n" || fn === "bottom_n" ? 0 : NaN) : fn === "cs_rank" ? 0.5 : fn === "top_n" || fn === "bottom_n" ? (cols <= k ? 1 : 0) : 0;
        }
      }
      return { s: "x", v: out, cols };
    }
    const T = this.T;
    const cols = v.cols;
    const out = new Float64Array(cols * T);
    const names = ctx.tickers;
    const idx: number[] = [];
    for (let t = 0; t < T; t++) {
      idx.length = 0;
      for (let u = 0; u < cols; u++) if (!Number.isNaN(v.v[u * T + t]!)) idx.push(u);
      const m = idx.length;
      if (fn === "top_n" || fn === "bottom_n") {
        for (let u = 0; u < cols; u++) out[u * T + t] = 0;
        const desc = fn === "top_n";
        idx.sort((a, b) => {
          const d = v.v[a * T + t]! - v.v[b * T + t]!;
          if (d !== 0) return desc ? -d : d;
          return names[a]! < names[b]! ? -1 : 1;
        });
        for (let r = 0; r < Math.min(k, m); r++) out[idx[r]! * T + t] = 1;
        continue;
      }
      for (let u = 0; u < cols; u++) out[u * T + t] = NaN;
      if (!m) continue;
      if (fn === "cs_rank") {
        // Percentile in [0, 1]; ties share their average position; one name gets 0.5.
        idx.sort((a, b) => v.v[a * T + t]! - v.v[b * T + t]!);
        let r = 0;
        while (r < m) {
          let e = r;
          while (e + 1 < m && v.v[idx[e + 1]! * T + t] === v.v[idx[r]! * T + t]) e++;
          const pct = m === 1 ? 0.5 : ((r + e) / 2) / (m - 1);
          for (let q = r; q <= e; q++) out[idx[q]! * T + t] = pct;
          r = e + 1;
        }
        continue;
      }
      let sum = 0;
      for (const u of idx) sum += v.v[u * T + t]!;
      const mean = sum / m;
      if (fn === "cs_demean") {
        for (const u of idx) out[u * T + t] = v.v[u * T + t]! - mean;
        continue;
      }
      let ss = 0;
      for (const u of idx) ss += (v.v[u * T + t]! - mean) ** 2;
      const sd = m > 1 ? Math.sqrt(ss / (m - 1)) : 0;
      for (const u of idx) out[u * T + t] = sd > 0 ? (v.v[u * T + t]! - mean) / sd : 0;
    }
    return { s: "x", v: out, cols };
  }
}

function isTdomEnd(n: Extract<Node, { k: "bin" }>): boolean {
  const lit = (x: Node) => x.k === "num" && x.v < 0;
  return (n.a.k === "ident" && n.a.name === "tdom" && lit(n.b)) || (n.b.k === "ident" && n.b.name === "tdom" && lit(n.a));
}

function fillDaysSince(out: Float64Array, base: number, T: number, sessions: number[]): void {
  const hits = new Uint8Array(T);
  for (const s of sessions) if (s >= 0 && s < T) hits[s] = 1;
  let last = -1;
  for (let t = 0; t < T; t++) {
    if (hits[t]) last = t;
    out[base + t] = last >= 0 ? t - last : NaN;
  }
}

function shift(a: Float64Array, k: number): Float64Array {
  const o = new Float64Array(a.length).fill(NaN);
  for (let t = k; t < a.length; t++) o[t] = a[t - k]!;
  return o;
}

/**
 * Rolling mean / sum / sample std over [t - n + 1, t]; NaN if any value in the
 * window is NaN. The mean uses the same running sum as indicators.sma, so a
 * v1 rule and its FSL form give bit-identical averages.
 */
export function rolling(a: Float64Array, n: number, kind: "mean" | "sum" | "std"): Float64Array {
  const o = new Float64Array(a.length).fill(NaN);
  let sum = 0;
  let sq = 0;
  let bad = 0;
  for (let t = 0; t < a.length; t++) {
    const v = a[t]!;
    if (Number.isNaN(v)) bad++;
    else {
      sum += v;
      sq += v * v;
    }
    if (t >= n) {
      const old = a[t - n]!;
      if (Number.isNaN(old)) bad--;
      else {
        sum -= old;
        sq -= old * old;
      }
    }
    if (t >= n - 1 && bad === 0) {
      if (kind === "sum") o[t] = sum;
      else if (kind === "mean") o[t] = sum / n;
      else if (n > 1) {
        // Recompute exactly to avoid drift in long series.
        let m = 0;
        for (let q = t - n + 1; q <= t; q++) m += a[q]!;
        m /= n;
        let s = 0;
        for (let q = t - n + 1; q <= t; q++) s += (a[q]! - m) ** 2;
        o[t] = Math.sqrt(s / (n - 1));
      }
    }
  }
  return o;
}

function rollingExt(a: Float64Array, n: number, kind: "max" | "min"): Float64Array {
  const o = new Float64Array(a.length).fill(NaN);
  for (let t = n - 1; t < a.length; t++) {
    let best = kind === "max" ? -Infinity : Infinity;
    let ok = true;
    for (let q = t - n + 1; q <= t; q++) {
      const v = a[q]!;
      if (Number.isNaN(v)) {
        ok = false;
        break;
      }
      if (kind === "max" ? v > best : v < best) best = v;
    }
    if (ok) o[t] = best;
  }
  return o;
}

function runningMax(a: Float64Array): Float64Array {
  const o = new Float64Array(a.length).fill(NaN);
  let m = -Infinity;
  for (let t = 0; t < a.length; t++) {
    if (!Number.isNaN(a[t]!) && a[t]! > m) m = a[t]!;
    if (m > -Infinity) o[t] = m;
  }
  return o;
}

function tsRank(a: Float64Array, n: number): Float64Array {
  const o = new Float64Array(a.length).fill(NaN);
  for (let t = n - 1; t < a.length; t++) {
    const v = a[t]!;
    if (Number.isNaN(v)) continue;
    let below = 0;
    let eq = 0;
    let ok = true;
    for (let q = t - n + 1; q <= t; q++) {
      const x = a[q]!;
      if (Number.isNaN(x)) {
        ok = false;
        break;
      }
      if (x < v) below++;
      else if (x === v) eq++;
    }
    if (ok) o[t] = n > 1 ? (below + (eq - 1) / 2) / (n - 1) : 0.5;
  }
  return o;
}

function wma(a: Float64Array, n: number): Float64Array {
  const o = new Float64Array(a.length).fill(NaN);
  const denom = (n * (n + 1)) / 2;
  for (let t = n - 1; t < a.length; t++) {
    let s = 0;
    let ok = true;
    for (let q = 0; q < n; q++) {
      const v = a[t - n + 1 + q]!;
      if (Number.isNaN(v)) {
        ok = false;
        break;
      }
      s += v * (q + 1);
    }
    if (ok) o[t] = s / denom;
  }
  return o;
}

/** Wilder smoothing (ATR): first value the simple mean of n, then (prev * (n - 1) + x) / n. */
function wilder(a: Float64Array, n: number): Float64Array {
  return segments(a, (seg) => {
    const out = new Array<number>(seg.length).fill(NaN);
    if (seg.length < n) return out;
    let prev = 0;
    for (let i = 0; i < n; i++) prev += seg[i]!;
    prev /= n;
    out[n - 1] = prev;
    for (let i = n; i < seg.length; i++) {
      prev = (prev * (n - 1) + seg[i]!) / n;
      out[i] = prev;
    }
    return out;
  });
}

/** Runs a NaN-unaware indicator over each maximal run of finite values. */
function segments(a: Float64Array, f: (seg: number[]) => number[]): Float64Array {
  const o = new Float64Array(a.length).fill(NaN);
  let t = 0;
  while (t < a.length) {
    while (t < a.length && !Number.isFinite(a[t]!)) t++;
    const start = t;
    while (t < a.length && Number.isFinite(a[t]!)) t++;
    if (t > start) {
      const r = f(Array.from(a.subarray(start, t)));
      for (let i = 0; i < r.length; i++) o[start + i] = r[i]!;
    }
  }
  return o;
}

export { SELF };
