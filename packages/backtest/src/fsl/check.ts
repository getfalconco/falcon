/**
 * The FSL type checker. It is where look-ahead and level comparisons become
 * compile errors instead of silent bugs (design 2.4, 4.2):
 *
 *   - No future operator exists. delay(x, k) needs k >= 1; every window is
 *     [t - n + 1, t] with n a literal or an integer $param in 1..1260.
 *   - Adjusted prices (open/high/low/close) have type AdjPrice<ticker>. They
 *     combine with AdjPrice of the same ticker, scale by numbers, and become
 *     plain numbers through ret(), ratios or ts_zscore. Comparing one with a
 *     constant, a $param or another ticker's price is an error whose hint is
 *     raw_close. Comparing with 0 (a sign test) is allowed: it does not change
 *     when the series is rescaled.
 *   - Bare rank() is rejected: cs_rank (a percentile, higher x is higher),
 *     top_n and bottom_n say which way they go.
 *   - Identifiers ($params, defs) match ^[a-z][a-z0-9_]{0,23}$; defs and w()
 *     references must form a DAG.
 *   - ripple.judged_dir (an LLM judgment) is not backtestable (check 21).
 *
 * Shapes: const (one number), market (one value per date), series (per ticker
 * per date). Market broadcasts over tickers.
 */

import { FslError, parse, walk, type Node, type Pos } from "./parse";

export type Shape = "const" | "market" | "series";
export type Kind = "num" | "bool" | "adj" | "cat" | "str";
export type Ty = { shape: Shape; kind: Kind; ticker: string | null };

export const IDENT_RE = /^[a-z][a-z0-9_]{0,23}$/;
export const TICKER_RE = /^\^?[A-Z0-9][A-Z0-9.\-]{0,9}$/;
export const MAX_WINDOW = 1260;
export const SELF = "$self";

export type ParamDef = { type: "int" | "number" | "pct"; value: number; min: number; max: number; step: number };

export type Role = "entry" | "exit" | "tiebreak" | "score" | "filter" | "weight" | "event" | "targets" | "universe_filter";
export type Mode = "rules" | "rank" | "weights" | "event_study";

export type CheckEnv = {
  mode: Mode;
  params: Record<string, ParamDef>;
  defs: Record<string, string>;
  /** Weights mode: the tickers that have a weight (w() may name only these). */
  weightTickers?: string[];
};

/** What one checked formula uses, for the loader, describe() and the audit. */
export type Uses = {
  tickers: Set<string>;
  earningsTickers: Set<string>;
  earningsSelf: boolean;
  ripple: boolean;
  params: Set<string>;
  defs: Set<string>;
  wRefs: Set<string>;
  literals: number[];
  /** First operator slot each $param fills: the label describe() shows ("average length"). */
  paramSlots: Map<string, string>;
  maxWindow: number;
};

export function emptyUses(): Uses {
  return {
    tickers: new Set(),
    earningsTickers: new Set(),
    earningsSelf: false,
    ripple: false,
    params: new Set(),
    defs: new Set(),
    wRefs: new Set(),
    literals: [],
    paramSlots: new Map(),
    maxWindow: 0,
  };
}

export const ALIASES: Record<string, string> = { sma: "ts_mean", mean: "ts_mean", stdev: "ts_std", std: "ts_std" };

const PRICE_IDENTS: Record<string, Kind> = { open: "adj", high: "adj", low: "adj", close: "adj", raw_close: "num", volume: "num", dollar_volume: "num" };
const CAL_IDENTS: Record<string, Kind> = { dow: "num", month: "num", tdom: "num", is_month_end: "bool", is_quarter_end: "bool" };
export const EARNINGS_IDENTS: Record<string, Kind> = {
  "earnings.event": "bool",
  "earnings.days_since": "num",
  "earnings.reaction_abn": "num",
  "earnings.surprise": "num",
};
export const RIPPLE_IDENTS: Record<string, Kind> = {
  "ripple.event": "bool",
  "ripple.days_since": "num",
  "ripple.relation": "cat",
  "ripple.degree": "num",
  "ripple.event_kind": "cat",
  "ripple.event_sign": "num",
  "ripple.implied_dir": "num",
  "ripple.edge_tier": "cat",
  "ripple.coverage": "cat",
};

/** Window-style functions: name -> [index of the window argument, default when omitted]. */
const TS1 = ["ts_mean", "ema", "wma", "ts_max", "ts_min", "ts_sum", "ts_std", "ts_zscore", "ts_rank", "ret", "logret", "rsi", "count"];

export const FUNCTIONS = [
  "delay", "delta", "ret", "logret", "ts_mean", "ema", "wma", "ts_max", "ts_min", "ts_sum", "ts_std", "ts_zscore", "ts_rank",
  "rsi", "atr", "macd", "vol", "adv", "drawdown", "count", "streak", "days_since", "crosses_above", "crosses_below",
  "cs_rank", "cs_zscore", "cs_demean", "top_n", "bottom_n", "at", "of", "w", "tbill_ret",
  "min", "max", "abs", "log", "sign", "clip", "if",
] as const;

export const IDENTIFIERS = [...Object.keys(PRICE_IDENTS), ...Object.keys(CAL_IDENTS), ...Object.keys(EARNINGS_IDENTS), ...Object.keys(RIPPLE_IDENTS)];

const SLOT_LABEL: Record<string, string> = {
  delay: "delay in sessions",
  delta: "change period",
  ret: "return period",
  logret: "return period",
  ts_mean: "average length",
  ema: "average length",
  wma: "average length",
  ts_max: "high lookback",
  ts_min: "low lookback",
  ts_sum: "sum length",
  ts_std: "deviation length",
  ts_zscore: "z-score length",
  ts_rank: "rank lookback",
  rsi: "RSI length",
  atr: "ATR length",
  macd: "MACD length",
  vol: "volatility length",
  adv: "volume length",
  count: "count length",
  top_n: "number held",
  bottom_n: "number held",
  tbill_ret: "T-bill period",
  clip: "bound",
};

const rankShape = (s: Shape) => (s === "series" ? 2 : s === "market" ? 1 : 0);
const joinShape = (a: Shape, b: Shape): Shape => (rankShape(a) >= rankShape(b) ? a : b);

type Ctx = {
  self: string | null; // null: no per-ticker context (weights mode top level)
  env: CheckEnv;
  uses: Uses;
  stack: string[];
  /** True inside at()/of(): one ticker, so cross-sectional operators make no sense. */
  single: boolean;
};

const err = (msg: string, pos: Pos | null, hint: string | null = null) => new FslError(msg, pos, hint);

function windowArg(n: Node | undefined, ctx: Ctx, fn: string, min = 1): number {
  if (!n) throw err(`${fn}() needs a window length.`, null);
  if (n.k === "num") {
    if (!Number.isInteger(n.v)) throw err(`${fn}(): the length must be a whole number of sessions.`, n.pos);
    if (n.v < min) {
      throw err(
        fn === "delay" ? "delay() reads the past only: the delay must be at least 1 session." : `${fn}(): the length must be at least ${min}.`,
        n.pos,
        fn === "delay" ? "FSL has no future operator; delay(x, 1) is yesterday's value." : null,
      );
    }
    if (n.v > MAX_WINDOW) throw err(`${fn}(): the length can be at most ${MAX_WINDOW} sessions.`, n.pos);
    ctx.uses.maxWindow = Math.max(ctx.uses.maxWindow, n.v);
    return n.v;
  }
  if (n.k === "param") {
    const p = ctx.env.params[n.name];
    checkParamName(n.name, n.pos, ctx);
    if (!p) throw err(`Unknown parameter $${n.name}.`, n.pos);
    if (p.type !== "int") throw err(`${fn}(): $${n.name} is a length, so its type must be int.`, n.pos);
    if (p.min < min) {
      throw err(
        fn === "delay" ? `delay() reads the past only: $${n.name} must have a minimum of at least 1.` : `${fn}(): $${n.name} must have a minimum of at least ${min}.`,
        n.pos,
      );
    }
    if (p.max > MAX_WINDOW) throw err(`${fn}(): $${n.name} can be at most ${MAX_WINDOW}.`, n.pos);
    if (!ctx.uses.paramSlots.has(n.name)) ctx.uses.paramSlots.set(n.name, SLOT_LABEL[fn] ?? "length");
    ctx.uses.params.add(n.name);
    ctx.uses.maxWindow = Math.max(ctx.uses.maxWindow, p.max);
    return p.value;
  }
  throw err(`${fn}(): the length must be a number or a $parameter, not an expression.`, n.pos, "Windows are fixed so every read stays inside [t - n + 1, t].");
}

function checkParamName(name: string, pos: Pos, _ctx: Ctx) {
  if (!IDENT_RE.test(name)) {
    throw err(`$${name} is not a valid parameter name.`, pos, "Names use lower case letters, digits and _, start with a letter, at most 24 characters (e.g. $lookback).");
  }
}

function tickerArg(n: Node | undefined, fn: string): string {
  if (!n || n.k !== "str") throw err(`${fn}() needs a ticker in quotes first, e.g. ${fn}("SPY", ...).`, n?.pos ?? null);
  const t = n.v.trim().toUpperCase();
  if (!TICKER_RE.test(t)) throw err(`"${n.v}" is not a ticker.`, n.pos);
  return t;
}

function levelHint(): string {
  return "Adjusted prices change with every later dividend, so their level is not what traded. Compare raw_close with a number, or use a return or ratio such as close / ts_mean(close, 200).";
}

function isZero(n: Node): boolean {
  return n.k === "num" && n.v === 0;
}

function numeric(t: Ty, n: Node, what: string): void {
  if (t.kind === "bool") throw err(`${what} needs a number, got a true/false condition.`, n.pos);
  if (t.kind === "cat" || t.kind === "str") throw err(`${what} needs a number, got a label.`, n.pos);
}

function check(n: Node, ctx: Ctx): Ty {
  switch (n.k) {
    case "num":
      ctx.uses.literals.push(n.v);
      return { shape: "const", kind: "num", ticker: null };
    case "bool":
      return { shape: "const", kind: "bool", ticker: null };
    case "str":
      if (/^\d{4}-\d{2}(-\d{2})?$/.test(n.v.trim())) {
        throw err("Dates cannot appear inside a formula.", n.pos, "Set the test window in the period instead; a date inside a rule builds hindsight in.");
      }
      return { shape: "const", kind: "str", ticker: null };
    case "param": {
      checkParamName(n.name, n.pos, ctx);
      const p = ctx.env.params[n.name];
      if (!p) throw err(`Unknown parameter $${n.name}.`, n.pos, "Add it to the parameters, or use a number.");
      ctx.uses.params.add(n.name);
      if (!ctx.uses.paramSlots.has(n.name)) ctx.uses.paramSlots.set(n.name, "threshold");
      return { shape: "const", kind: "num", ticker: null };
    }
    case "ident":
      return checkIdent(n, ctx);
    case "un": {
      const a = check(n.a, ctx);
      if (n.op === "not") {
        if (a.kind !== "bool") throw err("not needs a true/false condition.", n.pos);
        return a;
      }
      numeric(a, n.a, "Minus");
      return a;
    }
    case "bin":
      return checkBin(n, ctx);
    case "call":
      return checkCall(n, ctx);
  }
}

function checkIdent(n: Extract<Node, { k: "ident" }>, ctx: Ctx): Ty {
  const name = n.name;
  if (name === "ripple.judged_dir" || name.includes("judged")) {
    throw err(
      "ripple.judged_dir is not available in backtests.",
      n.pos,
      "It comes from a language model that may remember what happened next. Use ripple.implied_dir (relation times event sign), which is deterministic.",
    );
  }
  if (name in PRICE_IDENTS) {
    if (!ctx.self) throw err(`${name} needs a ticker here: write at("SPY", ${name}).`, n.pos, "Weights are one number per date, so prices must name their ticker.");
    return { shape: "series", kind: PRICE_IDENTS[name]!, ticker: PRICE_IDENTS[name] === "adj" ? ctx.self : null };
  }
  if (name in CAL_IDENTS) return { shape: "market", kind: CAL_IDENTS[name]!, ticker: null };
  if (name in EARNINGS_IDENTS) {
    if (!ctx.self) throw err(`${name} needs a company: write of("NVDA", ${name}).`, n.pos);
    if (ctx.self === SELF) ctx.uses.earningsSelf = true;
    else ctx.uses.earningsTickers.add(ctx.self);
    return { shape: "series", kind: EARNINGS_IDENTS[name]!, ticker: null };
  }
  if (name in RIPPLE_IDENTS) {
    if (!ctx.self) throw err(`${name} needs a company: write of("NVDA", ${name}).`, n.pos);
    ctx.uses.ripple = true;
    return { shape: "series", kind: RIPPLE_IDENTS[name]!, ticker: null };
  }
  if (name === "rank") throw rankError(n.pos);
  if (name.startsWith("earnings.") || name.startsWith("ripple.")) {
    const group = name.startsWith("earnings.") ? EARNINGS_IDENTS : RIPPLE_IDENTS;
    throw err(`Unknown field ${name}.`, n.pos, `Available: ${Object.keys(group).join(", ")}.`);
  }
  if (name in ctx.env.defs) {
    if (!IDENT_RE.test(name)) throw err(`"${name}" is not a valid name.`, n.pos);
    if (ctx.stack.includes(name)) throw err(`The definitions refer to each other in a loop: ${[...ctx.stack, name].join(" -> ")}.`, n.pos);
    ctx.uses.defs.add(name);
    let node: Node;
    try {
      node = parse(ctx.env.defs[name]!);
    } catch (e) {
      throw err(`In ${name}: ${e instanceof Error ? e.message : String(e)}`, n.pos);
    }
    ctx.stack.push(name);
    try {
      return check(node, ctx);
    } catch (e) {
      if (e instanceof FslError && !e.message.startsWith("In ")) throw err(`In ${name}: ${e.message}`, n.pos, e.hint);
      throw e;
    } finally {
      ctx.stack.pop();
    }
  }
  if (/^[A-Z]/.test(name) || /\s/.test(name)) {
    throw err(`"${name}" is not a valid name.`, n.pos, "Names use lower case letters, digits and _ (e.g. lookback_period).");
  }
  throw err(`Unknown name "${name}".`, n.pos, suggest(name));
}

function suggest(name: string): string | null {
  const all = [...IDENTIFIERS, ...FUNCTIONS];
  const near = all.filter((x) => x.startsWith(name.slice(0, 3)) || name.startsWith(x.slice(0, 4))).slice(0, 4);
  return near.length ? `Did you mean ${near.join(", ")}?` : null;
}

function rankError(pos: Pos) {
  return err(
    "rank() is not available: it hides which way is best.",
    pos,
    "Use cs_rank(x) (a percentile from 0 to 1 across tickers, higher x gives a higher value), top_n(x, n) or bottom_n(x, n).",
  );
}

function checkBin(n: Extract<Node, { k: "bin" }>, ctx: Ctx): Ty {
  const a = check(n.a, ctx);
  const b = check(n.b, ctx);
  const shape = joinShape(a.shape, b.shape);
  switch (n.op) {
    case "and":
    case "or":
      if (a.kind !== "bool" || b.kind !== "bool") throw err(`${n.op} joins two true/false conditions.`, n.pos);
      return { shape, kind: "bool", ticker: null };
    case "+":
    case "-": {
      numeric(a, n.a, n.op === "+" ? "Adding" : "Subtracting");
      numeric(b, n.b, n.op === "+" ? "Adding" : "Subtracting");
      if (a.kind === "adj" || b.kind === "adj") {
        if (a.kind === "adj" && b.kind === "adj" && a.ticker === b.ticker) return { shape, kind: "adj", ticker: a.ticker };
        if (a.kind === "adj" && b.kind === "adj") throw err("Adjusted prices of different tickers cannot be added or subtracted.", n.pos, "Use a ratio, e.g. at(\"KO\", close) / at(\"PEP\", close).");
        throw err("An adjusted price plus or minus a number is a price level.", n.pos, levelHint());
      }
      return { shape, kind: "num", ticker: null };
    }
    case "*": {
      numeric(a, n.a, "Multiplying");
      numeric(b, n.b, "Multiplying");
      if (a.kind === "adj" && b.kind === "adj") throw err("Two adjusted prices cannot be multiplied.", n.pos);
      if (a.kind === "adj" || b.kind === "adj") return { shape, kind: "adj", ticker: (a.kind === "adj" ? a : b).ticker };
      return { shape, kind: "num", ticker: null };
    }
    case "/": {
      numeric(a, n.a, "Dividing");
      numeric(b, n.b, "Dividing");
      if (a.kind === "adj" && b.kind === "adj") return { shape, kind: "num", ticker: null }; // a ratio
      if (b.kind === "adj") throw err("Dividing a number by an adjusted price gives a level.", n.pos, levelHint());
      if (a.kind === "adj") return { shape, kind: "adj", ticker: a.ticker };
      return { shape, kind: "num", ticker: null };
    }
    default:
      checkComparable(a, b, n.a, n.b, n.op, n.pos);
      return { shape, kind: "bool", ticker: null };
  }
}

function checkComparable(a: Ty, b: Ty, na: Node, nb: Node, op: string, pos: Pos) {
  if (a.kind === "bool" || b.kind === "bool") throw err("Conditions cannot be compared; join them with and / or.", pos);
  const labels = (a.kind === "cat" || a.kind === "str") && (b.kind === "cat" || b.kind === "str");
  if (a.kind === "cat" || b.kind === "cat" || a.kind === "str" || b.kind === "str") {
    if (!labels || (a.kind === "str" && b.kind === "str")) throw err("Labels compare only with a label in quotes, e.g. ripple.relation == \"customer\".", pos);
    if (op !== "==" && op !== "!=") throw err("Labels compare only with == or !=.", pos);
    return;
  }
  if (a.kind === "adj" || b.kind === "adj") {
    if (a.kind === "adj" && b.kind === "adj") {
      if (a.ticker !== b.ticker) {
        throw err(
          `This compares the adjusted price of ${tickerName(a.ticker)} with that of ${tickerName(b.ticker)}.`,
          pos,
          "Adjusted levels of two tickers are not comparable. Compare returns, or a ratio with its own average.",
        );
      }
      return;
    }
    if ((a.kind === "adj" && isZero(nb)) || (b.kind === "adj" && isZero(na))) return;
    const other = a.kind === "adj" ? nb : na;
    throw err(
      other.k === "param" ? `An adjusted price is compared with $${other.name}.` : "An adjusted price is compared with a fixed number.",
      pos,
      levelHint(),
    );
  }
}

function tickerName(t: string | null): string {
  return !t || t === SELF ? "the traded ticker" : t;
}

function checkCall(n: Extract<Node, { k: "call" }>, ctx: Ctx): Ty {
  const fn = ALIASES[n.fn] ?? n.fn;
  const args = n.args;
  const arity = (lo: number, hi = lo) => {
    if (args.length < lo || args.length > hi) {
      throw err(`${n.fn}() takes ${lo === hi ? lo : `${lo} to ${hi}`} argument${hi === 1 ? "" : "s"}, got ${args.length}.`, n.pos);
    }
  };
  if (fn === "rank" || fn === "ts_rank_cs") throw rankError(n.pos);
  switch (fn) {
    case "delay": {
      arity(2);
      const x = check(args[0]!, ctx);
      windowArg(args[1], ctx, "delay", 1);
      return x;
    }
    case "delta": {
      arity(1, 2);
      const x = check(args[0]!, ctx);
      numeric(x, args[0]!, "delta()");
      if (args[1]) windowArg(args[1], ctx, "delta", 1);
      return x;
    }
    case "ret":
    case "logret": {
      arity(1, 2);
      const x = check(args[0]!, ctx);
      numeric(x, args[0]!, `${fn}()`);
      if (args[1]) windowArg(args[1], ctx, fn, 1);
      return { shape: x.shape, kind: "num", ticker: null };
    }
    case "ts_mean":
    case "ema":
    case "wma":
    case "ts_max":
    case "ts_min":
    case "ts_sum":
    case "ts_std": {
      arity(2);
      const x = check(args[0]!, ctx);
      if (fn === "ts_sum" && x.kind === "bool") {
        windowArg(args[1], ctx, fn, 1);
        return { shape: x.shape, kind: "num", ticker: null };
      }
      numeric(x, args[0]!, `${fn}()`);
      windowArg(args[1], ctx, fn, fn === "ts_std" ? 2 : 1);
      return x;
    }
    case "ts_zscore":
    case "ts_rank": {
      arity(2);
      const x = check(args[0]!, ctx);
      numeric(x, args[0]!, `${fn}()`);
      windowArg(args[1], ctx, fn, 2);
      return { shape: x.shape, kind: "num", ticker: null };
    }
    case "rsi": {
      arity(1, 2);
      let x: Ty;
      if (args.length === 1) {
        if (!ctx.self) throw err("rsi(n) needs a ticker here: write at(\"SPY\", rsi(close, 14)).", n.pos);
        windowArg(args[0], ctx, fn, 2);
        x = { shape: "series", kind: "adj", ticker: ctx.self };
      } else {
        x = check(args[0]!, ctx);
        numeric(x, args[0]!, "rsi()");
        windowArg(args[1], ctx, fn, 2);
      }
      return { shape: x.shape, kind: "num", ticker: null };
    }
    case "atr": {
      arity(1);
      if (!ctx.self) throw err("atr() needs a ticker here: write at(\"SPY\", atr(14)).", n.pos);
      windowArg(args[0], ctx, fn, 1);
      return { shape: "series", kind: "adj", ticker: ctx.self };
    }
    case "macd": {
      arity(3);
      const x = check(args[0]!, ctx);
      numeric(x, args[0]!, "macd()");
      const f = windowArg(args[1], ctx, fn, 1);
      const s = windowArg(args[2], ctx, fn, 2);
      if (args[1]!.k === "num" && args[2]!.k === "num" && f >= s) throw err("macd(x, fast, slow): fast must be shorter than slow.", n.pos);
      return x;
    }
    case "vol":
    case "adv": {
      arity(1);
      if (!ctx.self) throw err(`${fn}() needs a ticker here: write at("SPY", ${fn}(21)).`, n.pos);
      windowArg(args[0], ctx, fn, 2);
      return { shape: "series", kind: "num", ticker: null };
    }
    case "drawdown": {
      arity(1, 2);
      const x = check(args[0]!, ctx);
      numeric(x, args[0]!, "drawdown()");
      if (args[1]) windowArg(args[1], ctx, fn, 2);
      return { shape: x.shape, kind: "num", ticker: null };
    }
    case "count": {
      arity(2);
      const c = check(args[0]!, ctx);
      if (c.kind !== "bool") throw err("count(cond, n) counts sessions where a condition holds.", n.pos);
      windowArg(args[1], ctx, fn, 1);
      return { shape: c.shape, kind: "num", ticker: null };
    }
    case "streak":
    case "days_since": {
      arity(1);
      const c = check(args[0]!, ctx);
      if (c.kind !== "bool") throw err(`${fn}(cond) needs a true/false condition.`, n.pos);
      return { shape: c.shape, kind: "num", ticker: null };
    }
    case "crosses_above":
    case "crosses_below": {
      arity(2);
      const a = check(args[0]!, ctx);
      const b = check(args[1]!, ctx);
      numeric(a, args[0]!, `${fn}()`);
      numeric(b, args[1]!, `${fn}()`);
      checkComparable(a, b, args[0]!, args[1]!, ">", n.pos);
      return { shape: joinShape(a.shape, b.shape), kind: "bool", ticker: null };
    }
    case "cs_rank":
    case "cs_zscore":
    case "cs_demean":
    case "top_n":
    case "bottom_n": {
      const two = fn === "top_n" || fn === "bottom_n";
      arity(two ? 2 : 1);
      if (!ctx.self || ctx.single) throw err(`${fn}() compares tickers, so it needs the universe (not inside at() or of()).`, n.pos);
      const x = check(args[0]!, ctx);
      numeric(x, args[0]!, `${fn}()`);
      if (x.kind === "adj") throw err(`${fn}() over adjusted prices ranks price levels.`, n.pos, "Rank a return, ratio or z-score instead, e.g. cs_rank(ret(close, 126)).");
      if (two) windowArg(args[1], ctx, fn, 1);
      return { shape: "series", kind: two ? "bool" : "num", ticker: null };
    }
    case "at":
    case "of": {
      arity(2);
      const t = tickerArg(args[0], fn);
      ctx.uses.tickers.add(t);
      const inner: Ctx = { ...ctx, self: t, single: true };
      const x = check(args[1]!, inner);
      if (x.kind === "str") throw err(`${fn}() needs a formula after the ticker.`, n.pos);
      return { shape: x.shape === "const" ? "const" : "market", kind: x.kind, ticker: x.kind === "adj" ? t : null };
    }
    case "w": {
      arity(1);
      if (ctx.env.mode !== "weights") throw err("w() reads another weight, so it works only in weights mode.", n.pos);
      const t = tickerArg(args[0], "w");
      if (!ctx.env.weightTickers?.includes(t)) throw err(`w("${t}"): ${t} has no weight in this strategy.`, n.pos);
      ctx.uses.wRefs.add(t);
      return { shape: "market", kind: "num", ticker: null };
    }
    case "tbill_ret": {
      arity(1);
      windowArg(args[0], ctx, fn, 1);
      return { shape: "market", kind: "num", ticker: null };
    }
    case "min":
    case "max": {
      arity(2);
      const a = check(args[0]!, ctx);
      const b = check(args[1]!, ctx);
      numeric(a, args[0]!, `${fn}()`);
      numeric(b, args[1]!, `${fn}()`);
      if (a.kind === "adj" || b.kind === "adj") {
        if (a.kind !== "adj" || b.kind !== "adj" || a.ticker !== b.ticker) throw err(`${fn}() mixes an adjusted price with something else.`, n.pos, levelHint());
        return { shape: joinShape(a.shape, b.shape), kind: "adj", ticker: a.ticker };
      }
      return { shape: joinShape(a.shape, b.shape), kind: "num", ticker: null };
    }
    case "abs":
    case "log":
    case "sign": {
      arity(1);
      const x = check(args[0]!, ctx);
      numeric(x, args[0]!, `${fn}()`);
      if (x.kind === "adj") throw err(`${fn}() of an adjusted price is a level.`, n.pos, levelHint());
      return { shape: x.shape, kind: "num", ticker: null };
    }
    case "clip": {
      arity(3);
      const x = check(args[0]!, ctx);
      numeric(x, args[0]!, "clip()");
      if (x.kind === "adj") throw err("clip() of an adjusted price is a level.", n.pos, levelHint());
      const lo = check(args[1]!, ctx);
      const hi = check(args[2]!, ctx);
      numeric(lo, args[1]!, "clip()");
      numeric(hi, args[2]!, "clip()");
      return { shape: joinShape(x.shape, joinShape(lo.shape, hi.shape)), kind: "num", ticker: null };
    }
    case "if": {
      arity(3);
      const c = check(args[0]!, ctx);
      if (c.kind !== "bool") throw err("if(cond, a, b): the first argument must be a condition.", n.pos);
      const a = check(args[1]!, ctx);
      const b = check(args[2]!, ctx);
      const shape = joinShape(c.shape, joinShape(a.shape, b.shape));
      if (a.kind === "bool" && b.kind === "bool") return { shape, kind: "bool", ticker: null };
      numeric(a, args[1]!, "if()");
      numeric(b, args[2]!, "if()");
      if (a.kind === "adj" || b.kind === "adj") {
        if (a.kind !== "adj" || b.kind !== "adj" || a.ticker !== b.ticker) throw err("if() mixes an adjusted price with something else.", n.pos, levelHint());
        return { shape, kind: "adj", ticker: a.ticker };
      }
      return { shape, kind: "num", ticker: null };
    }
    default:
      throw err(`Unknown function ${n.fn}().`, n.pos, suggest(n.fn));
  }
}

export type CheckResult =
  | { ok: true; node: Node; type: Ty; uses: Uses }
  | { ok: false; error: string; hint: string | null; pos: Pos | null };

const ROLE_NEEDS: Record<Role, { kind: "bool" | "num"; label: string }> = {
  entry: { kind: "bool", label: "The entry rule" },
  exit: { kind: "bool", label: "The exit rule" },
  tiebreak: { kind: "num", label: "The tie-break score" },
  score: { kind: "num", label: "The ranking score" },
  filter: { kind: "bool", label: "The filter" },
  weight: { kind: "num", label: "A weight" },
  event: { kind: "bool", label: "The event" },
  targets: { kind: "bool", label: "The target condition" },
  universe_filter: { kind: "bool", label: "The universe filter" },
};

/** Parses and checks one formula in a role. Never throws. */
export function checkFormula(src: string, role: Role, env: CheckEnv, uses: Uses = emptyUses()): CheckResult {
  try {
    const node = parse(src);
    const ctx: Ctx = { self: role === "weight" ? null : SELF, env, uses, stack: [], single: false };
    const type = check(node, ctx);
    const need = ROLE_NEEDS[role];
    if (need.kind === "bool" && type.kind !== "bool") {
      throw err(`${need.label} must be a condition (true or false), e.g. close > ts_mean(close, 200).`, node.pos);
    }
    if (need.kind === "num" && (type.kind === "bool" || type.kind === "cat" || type.kind === "str")) {
      throw err(`${need.label} must be a number.`, node.pos);
    }
    if (type.kind === "adj" && (role === "score" || role === "tiebreak" || role === "weight")) {
      throw err(`${need.label} is an adjusted price level.`, node.pos, "Use a return, ratio or z-score.");
    }
    if (role === "targets" && type.shape !== "series") throw err("The target condition must depend on the ticker (e.g. ripple.relation == \"customer\").", node.pos);
    return { ok: true, node, type, uses };
  } catch (e) {
    if (e instanceof FslError) return { ok: false, error: e.message, hint: e.hint, pos: e.pos };
    return { ok: false, error: e instanceof Error ? e.message : String(e), hint: null, pos: null };
  }
}

/** w() dependency order for weights mode; throws FslError on a cycle. */
export function weightOrder(refs: Record<string, Set<string>>): string[] {
  const out: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (t: string, path: string[]) => {
    if (state.get(t) === 2) return;
    if (state.get(t) === 1) throw new FslError(`The weights refer to each other in a loop: ${[...path, t].map((x) => `w("${x}")`).join(" -> ")}.`);
    state.set(t, 1);
    for (const d of Array.from(refs[t] ?? [])) visit(d, [...path, t]);
    state.set(t, 2);
    out.push(t);
  };
  for (const t of Object.keys(refs).sort()) visit(t, []);
  return out;
}

/** Every identifier-like token in a formula (for tests and the AI repair message). */
export function identifiersIn(node: Node): string[] {
  const out: string[] = [];
  walk(node, (x) => {
    if (x.k === "ident") out.push(x.name);
  });
  return out;
}
