/**
 * FSL in plain English, built only from operator templates, canonical
 * parameter names and generated labels. Model text never enters here, so the
 * numbered rules a user confirms are exactly what runs.
 */

import { ALIASES, SELF } from "./check";
import { parse, type Node } from "./parse";

export type DescribeEnv = {
  params: Record<string, { type: "int" | "number" | "pct"; value: number }>;
  defs: Record<string, string>;
  /** The traded ticker when the universe has one name ("SPY"), else null ("the ticker"). */
  single: string | null;
  clock: "close" | "preopen";
};

function fmt(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(4)));
}

function pctText(v: number): string {
  return `${fmt(v)}%`;
}

type Ctx = { subject: string | null; env: DescribeEnv; depth: number; its?: boolean };

function poss(ctx: Ctx): string {
  if (ctx.its) return "its";
  return ctx.subject ? `${ctx.subject}'s` : "the";
}

function priceName(name: string, ctx: Ctx): string {
  const lag = ctx.env.clock === "preopen";
  const base: Record<string, string> = {
    open: "open",
    high: "high",
    low: "low",
    close: "close",
    raw_close: "unadjusted close",
    volume: "volume",
    dollar_volume: "dollar volume",
  };
  const word = base[name] ?? name;
  return lag ? `${poss(ctx)} previous ${word}` : `${poss(ctx)} ${word}`;
}

function windowText(n: Node, env: DescribeEnv): string {
  if (n.k === "num") return fmt(n.v);
  if (n.k === "param") return fmt(env.params[n.name]?.value ?? NaN);
  return "?";
}

/** " ($ma)" for every $param among a call's arguments, so the slider is named. */
function paramNote(args: Node[]): string {
  const names = args.filter((a) => a.k === "param").map((a) => `$${(a as { name: string }).name}`);
  return names.length ? ` (${names.join(", ")})` : "";
}

function value(n: Node, env: DescribeEnv): string | null {
  if (n.k === "num") return fmt(n.v);
  if (n.k === "param") {
    const p = env.params[n.name];
    if (!p) return `$${n.name}`;
    return `${p.type === "pct" ? pctText(p.value) : fmt(p.value)} ($${n.name})`;
  }
  return null;
}

const CMP: Record<string, string> = {
  ">": "is above",
  ">=": "is at or above",
  "<": "is below",
  "<=": "is at or below",
  "==": "equals",
  "!=": "is not",
};

function sessions(k: string): string {
  return k === "1" ? "1 session" : `${k} sessions`;
}

/** One expression as a clause. */
export function phrase(n: Node, ctx: Ctx): string {
  const env = ctx.env;
  const sub = (x: Node, c: Ctx = ctx) => phrase(x, { ...c, depth: c.depth + 1 });
  const v = value(n, env);
  if (v !== null) return v;
  switch (n.k) {
    case "str":
      return `"${n.v}"`;
    case "bool":
      return n.v ? "always" : "never";
    case "ident":
      return identPhrase(n.name, ctx);
    case "un":
      return n.op === "not" ? `not (${sub(n.a)})` : `minus ${sub(n.a)}`;
    case "bin": {
      if (n.op === "and" || n.op === "or") return `${sub(n.a)}, ${n.op} ${sub(n.b)}`;
      if (n.op in CMP) {
        if (n.a.k === "ident" && n.a.name === "tdom" && n.b.k === "num") {
          return n.b.v < 0 ? `it is trading day ${fmt(-n.b.v)} from the end of the month` : `it is trading day ${fmt(n.b.v)} of the month`;
        }
        // The second mention of the same subject reads "its".
        return `${sub(n.a)} ${CMP[n.op]} ${phrase(n.b, { ...ctx, depth: ctx.depth + 1, its: true })}`;
      }
      const word = { "+": "plus", "-": "minus", "*": "times", "/": "divided by" }[n.op as "+"];
      return `${sub(n.a)} ${word} ${sub(n.b)}`;
    }
    case "call":
      return callPhrase(n, ctx);
    default:
      return "?";
  }
}

function identPhrase(name: string, ctx: Ctx): string {
  const env = ctx.env;
  if (["open", "high", "low", "close", "raw_close", "volume", "dollar_volume"].includes(name)) return priceName(name, ctx);
  const who = ctx.subject ?? "the ticker";
  switch (name) {
    case "dow":
      return "the weekday (1 = Monday)";
    case "month":
      return "the month (1 = January)";
    case "tdom":
      return "the trading day of the month";
    case "is_month_end":
      return "it is the last session of the month";
    case "is_quarter_end":
      return "it is the last session of the quarter";
    case "earnings.event":
      return `${who} has an earnings release ${env.clock === "preopen" ? "known before the open" : "known by the close"}`;
    case "earnings.days_since":
      return `the sessions since ${who}'s last earnings release`;
    case "earnings.reaction_abn":
      return `${who}'s abnormal return on its earnings reaction day (vs SPY, market model)`;
    case "earnings.surprise":
      return `${who}'s EPS surprise (Yahoo, beta data)`;
    case "ripple.event":
      return `a Sighting reaches ${who}`;
    case "ripple.days_since":
      return `the sessions since a Sighting last reached ${who}`;
    case "ripple.relation":
      return `${who}'s link to the event company`;
    case "ripple.degree":
      return "the link degree";
    case "ripple.event_kind":
      return "the event kind";
    case "ripple.event_sign":
      return "the event sign";
    case "ripple.implied_dir":
      return "the implied direction (relation times event sign)";
    case "ripple.edge_tier":
      return "the link tier";
    case "ripple.coverage":
      return "the analyst coverage bucket";
  }
  // Definitions are spelled out from their formula, so a model-chosen name never reaches the rules.
  if (name in env.defs && ctx.depth < 12) {
    try {
      return phrase(parse(env.defs[name]!), { ...ctx, its: false, depth: ctx.depth + 1 });
    } catch {
      return name.replace(/_/g, " ");
    }
  }
  return name;
}

function callPhrase(n: Extract<Node, { k: "call" }>, ctx: Ctx): string {
  const env = ctx.env;
  const fn = ALIASES[n.fn] ?? n.fn;
  const A = n.args;
  // "its" only fits where a phrase starts with the subject; nested arguments name it again.
  const sub = (x: Node, c: Ctx = ctx) => phrase(x, { ...c, its: c === ctx ? false : c.its, depth: c.depth + 1 });
  const w = (i: number) => windowText(A[i]!, env);
  const note = paramNote(A);
  const isClose = (x: Node | undefined) => x?.k === "ident" && x.name === "close";
  switch (fn) {
    case "delay": {
      const k = w(1);
      const head = phrase(A[0]!, { ...ctx, depth: ctx.depth + 1 });
      return k === "1" ? `${head} one session earlier` : `${head} ${sessions(k)} earlier`;
    }
    case "delta":
      return `the ${A[1] ? w(1) : "1"}-session change in ${sub(A[0]!)}`;
    case "ret":
    case "logret": {
      const k = A[1] ? w(1) : "1";
      const kind = fn === "ret" ? "return" : "log return";
      return (isClose(A[0]) ? `${poss(ctx)} ${k}-session ${kind}` : `the ${k}-session ${kind} of ${sub(A[0]!)}`) + note;
    }
    case "ts_mean":
      return (isClose(A[0]) ? `${poss(ctx)} ${w(1)}-session average close` : `the ${w(1)}-session average of ${sub(A[0]!)}`) + note;
    case "ema":
      return (isClose(A[0]) ? `${poss(ctx)} ${w(1)}-session exponential average close` : `the ${w(1)}-session exponential average of ${sub(A[0]!)}`) + note;
    case "wma":
      return `the ${w(1)}-session weighted average of ${sub(A[0]!)}`;
    case "ts_max":
      return isClose(A[0]) ? `${poss(ctx)} highest close of the last ${w(1)} sessions${note}` : `the highest ${sub(A[0]!)} of the last ${w(1)} sessions${note}`;
    case "ts_min":
      return isClose(A[0]) ? `${poss(ctx)} lowest close of the last ${w(1)} sessions${note}` : `the lowest ${sub(A[0]!)} of the last ${w(1)} sessions${note}`;
    case "ts_sum":
      return `the sum of ${sub(A[0]!)} over ${w(1)} sessions`;
    case "ts_std":
      return `the standard deviation of ${sub(A[0]!)} over ${w(1)} sessions`;
    case "ts_zscore":
      return `the ${w(1)}-session z-score of ${sub(A[0]!)}${note}`;
    case "ts_rank":
      return `the percentile of ${sub(A[0]!)} within its last ${w(1)} sessions`;
    case "rsi":
      return (A.length === 1 ? `${poss(ctx)} ${w(0)}-session RSI` : isClose(A[0]) ? `${poss(ctx)} ${w(1)}-session RSI` : `the ${w(1)}-session RSI of ${sub(A[0]!)}`) + note;
    case "atr":
      return `${poss(ctx)} ${w(0)}-session average true range`;
    case "macd":
      return `the MACD line (${w(1)}/${w(2)}) of ${sub(A[0]!)}`;
    case "vol":
      return `${poss(ctx)} ${w(0)}-session realized volatility (annualized)${note}`;
    case "adv":
      return `${poss(ctx)} ${w(0)}-session average dollar volume`;
    case "drawdown":
      return A[1] ? `the fall of ${sub(A[0]!)} from its ${w(1)}-session high` : `the fall of ${sub(A[0]!)} from its highest level so far`;
    case "count":
      return `the number of the last ${w(1)} sessions${note} on which ${sub(A[0]!)}`;
    case "streak":
      return `the number of sessions in a row on which ${sub(A[0]!)}`;
    case "days_since":
      return `the sessions since ${sub(A[0]!)}`;
    case "crosses_above":
      return `${sub(A[0]!)} crosses above ${sub(A[1]!, { ...ctx, its: true })}`;
    case "crosses_below":
      return `${sub(A[0]!)} crosses below ${sub(A[1]!, { ...ctx, its: true })}`;
    case "cs_rank":
      return `the percentile of ${sub(A[0]!)} across the universe (higher value, higher percentile)`;
    case "cs_zscore":
      return `the z-score of ${sub(A[0]!)} across the universe`;
    case "cs_demean":
      return `${sub(A[0]!)} minus its universe average`;
    case "top_n":
      return `${sub(A[0]!)} is among the ${w(1)}${note} highest in the universe`;
    case "bottom_n":
      return `${sub(A[0]!)} is among the ${w(1)}${note} lowest in the universe`;
    case "at":
    case "of": {
      const t = (A[0] as { v: string }).v.toUpperCase();
      return sub(A[1]!, { ...ctx, subject: t, its: false });
    }
    case "w":
      return `the weight of ${(A[0] as { v: string }).v.toUpperCase()}`;
    case "tbill_ret":
      return `the 3-month T-bill return over ${w(0)} sessions${note}`;
    case "min":
      return `the smaller of ${sub(A[0]!)} and ${sub(A[1]!)}`;
    case "max":
      return `the larger of ${sub(A[0]!)} and ${sub(A[1]!)}`;
    case "abs":
      return `the size of ${sub(A[0]!)}`;
    case "log":
      return `the logarithm of ${sub(A[0]!)}`;
    case "sign":
      return `the sign of ${sub(A[0]!)}`;
    case "clip":
      return `${sub(A[0]!)}, kept between ${sub(A[1]!)} and ${sub(A[2]!)}`;
    case "if":
      return `${sub(A[1]!)} when ${sub(A[0]!)}, otherwise ${sub(A[2]!)}`;
  }
  return `${n.fn}(...)`;
}

/** A formula as one clause; falls back to the formula text if it does not parse. */
export function describeFormula(src: string, env: DescribeEnv): string {
  try {
    const node = parse(src);
    return phrase(node, { subject: env.single, env, depth: 0 });
  } catch {
    return src;
  }
}

export { SELF };
