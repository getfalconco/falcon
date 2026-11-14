/**
 * StrategySpec v2 (design 4.1): the versioned strategy the AI compiles to and
 * the engine runs. Rules are FSL formulas; every number a user may tune is a
 * named $param shown as a slider. `legacy` exists only for specs converted
 * from v1 rules (v1ToV2), so old strategies behave exactly as before.
 *
 * Pure (zod + FSL); safe in the browser and on iPhone.
 */

import { z } from "zod/v4";
import {
  IDENT_RE,
  TICKER_RE,
  checkFormula,
  emptyUses,
  weightOrder,
  type CheckEnv,
  type Mode,
  type Role,
  type Uses,
} from "./fsl/check";
import { describeFormula, type DescribeEnv } from "./fsl/describe";
import { FslError, type Pos } from "./fsl/parse";
import { UNIVERSES, type UniverseBase } from "./universes";
import { hashOf } from "./util";
import type { Condition, RunConfig, Strategy } from "./schema";

z.config(z.locales.en());

export const SPEC_LIMITS = {
  maxTickers: 60,
  maxParams: 12,
  maxDefs: 20,
  maxYears: 20,
  earliestDate: "1995-01-01",
  maxFormulaChars: 2_000,
  maxWindows: 4,
  maxEventWindow: 60,
  /** Ticker x session cells one synchronous run may evaluate (design 2.5). */
  maxCells: 1_500_000,
} as const;

const Ident = z.string().regex(IDENT_RE, "Names use lower case letters, digits and _, start with a letter, at most 24 characters");
const Formula = z.string().min(1).max(SPEC_LIMITS.maxFormulaChars);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const ParamSchema = z.object({
  type: z.enum(["int", "number", "pct"]),
  value: z.number(),
  min: z.number(),
  max: z.number(),
  step: z.number().positive(),
});

export const UniverseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("static"), tickers: z.array(z.string().max(12)).min(1).max(SPEC_LIMITS.maxTickers) }),
  z.object({ kind: z.literal("rule"), base: z.enum(["falcon_semis", "sector_etfs"]), filter: Formula.nullable() }),
]);

const Sizing = z.union([z.literal("equal"), z.literal("inverse_vol"), z.object({ pct: z.number().min(0.5).max(100) })]);

export const PortfolioSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("rules"),
    entry: Formula,
    exit: Formula.nullable(),
    max_positions: z.number().int().min(1).max(SPEC_LIMITS.maxTickers),
    clock: z.enum(["close", "preopen"]),
    reentry: z.union([z.literal("edge"), z.object({ cooldown_days: z.number().int().min(0).max(252) })]),
    tiebreak: z.union([z.literal("seeded"), z.object({ by: Formula, order: z.enum(["desc", "asc"]) })]),
    sizing: Sizing,
  }),
  z.object({
    mode: z.literal("rank"),
    score: Formula,
    order: z.enum(["desc", "asc"]),
    select: z.union([
      z.object({ n: z.union([z.number().int().min(1).max(SPEC_LIMITS.maxTickers), z.string().regex(/^\$[a-z][a-z0-9_]{0,23}$/)]) }),
      z.object({ quantile: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]) }),
    ]),
    filter: Formula.nullable(),
    weighting: z.enum(["equal", "score", "inverse_vol"]),
  }),
  z.object({ mode: z.literal("weights"), weights: z.record(z.string().max(12), Formula) }),
  z.object({
    mode: z.literal("event_study"),
    event: Formula,
    targets: Formula,
    windows: z.array(z.number().int().min(1).max(SPEC_LIMITS.maxEventWindow)).min(1).max(SPEC_LIMITS.maxWindows),
  }),
]);

export const LegacySchema = z.object({
  tiebreak: z.literal("list_order"),
  reentry: z.literal("v1"),
  /** v1 costs: a fixed slippage (execution.spread) with no liquidity floor, cash at 0%. */
  costs: z.literal("v1"),
  /** v1 rules-mode rebalancing of open positions back to their entry weight. */
  drift: z.enum(["none", "weekly", "monthly"]),
});

export const SpecSchema = z.object({
  spec_version: z.literal(2),
  name: z.string().max(80),
  intent: z.string().max(4_000),
  clarifications: z.array(z.object({ q: z.string().max(400), a: z.string().max(400) })).max(6),
  universe: UniverseSchema,
  params: z.record(Ident, ParamSchema),
  defs: z.record(Ident, Formula),
  portfolio: PortfolioSchema,
  side: z.enum(["long", "long_short"]),
  rebalance: z.enum(["daily", "weekly", "monthly", "quarterly"]),
  risk: z.object({
    stop_pct: z.number().min(0.5).max(95).nullable(),
    trailing_pct: z.number().min(0.5).max(95).nullable(),
    take_profit_pct: z.number().min(0.5).max(1000).nullable(),
    max_hold_days: z.number().int().min(1).max(1260).nullable(),
  }),
  execution: z.object({
    commission_bps: z.number().min(0).max(200),
    spread: z.union([z.literal("auto"), z.number().min(0).max(500)]),
    borrow_bps_yr: z.number().min(0).max(5_000),
    gross_cap: z.union([z.literal(1), z.literal(2)]),
  }),
  capital: z.number().min(1_000).max(1_000_000_000),
  cash: z.enum(["tbill", "zero"]),
  /** null start: 10 years before the end; null end: the latest session. */
  period: z.object({ start: IsoDate.nullable(), end: IsoDate.nullable() }),
  holdout: z.enum(["off", "account"]),
  benchmark: z.enum(["SPY", "equal_weight_universe"]),
  legacy: LegacySchema.optional(),
});

export type ParamSpec = z.infer<typeof ParamSchema>;
export type StrategySpecV2 = z.infer<typeof SpecSchema>;
export type Portfolio = StrategySpecV2["portfolio"];
export type SpecIssue = { path: string; message: string; hint?: string | null; pos?: Pos | null };

export const DEFAULT_SPEC_FIELDS = {
  spec_version: 2 as const,
  clarifications: [],
  params: {},
  defs: {},
  side: "long" as const,
  rebalance: "monthly" as const,
  risk: { stop_pct: null, trailing_pct: null, take_profit_pct: null, max_hold_days: null },
  execution: { commission_bps: 1, spread: "auto" as const, borrow_bps_yr: 50, gross_cap: 1 as const },
  capital: 100_000,
  cash: "tbill" as const,
  period: { start: null, end: null },
  holdout: "off" as const,
  benchmark: "SPY" as const,
};

/** The tickers a spec trades (universe), upper case. */
export function universeTickers(spec: Pick<StrategySpecV2, "universe" | "portfolio">): string[] {
  if (spec.portfolio.mode === "weights") return Object.keys(spec.portfolio.weights).map((t) => t.trim().toUpperCase());
  if (spec.universe.kind === "rule") return [...UNIVERSES[spec.universe.base as UniverseBase].tickers];
  return spec.universe.tickers.map((t) => t.trim().toUpperCase());
}

/** $param values as the evaluator reads them: pct params divided by 100. */
export function resolvedParams(spec: Pick<StrategySpecV2, "params">): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(spec.params)) out[k] = p.type === "pct" ? p.value / 100 : p.value;
  return out;
}

/** Hash of everything that changes results (not the name, intent or clarifications). The seed of every random choice. */
export function specHash(spec: StrategySpecV2): string {
  const { name: _n, intent: _i, clarifications: _c, ...rest } = spec;
  return hashOf(rest);
}

export type Formulas = { role: Role; path: string; src: string }[];

export function formulasOf(spec: StrategySpecV2): Formulas {
  const out: Formulas = [];
  const p = spec.portfolio;
  if (spec.universe.kind === "rule" && spec.universe.filter) out.push({ role: "universe_filter", path: "universe.filter", src: spec.universe.filter });
  switch (p.mode) {
    case "rules":
      out.push({ role: "entry", path: "portfolio.entry", src: p.entry });
      if (p.exit) out.push({ role: "exit", path: "portfolio.exit", src: p.exit });
      if (p.tiebreak !== "seeded") out.push({ role: "tiebreak", path: "portfolio.tiebreak.by", src: p.tiebreak.by });
      break;
    case "rank":
      out.push({ role: "score", path: "portfolio.score", src: p.score });
      if (p.filter) out.push({ role: "filter", path: "portfolio.filter", src: p.filter });
      break;
    case "weights":
      for (const [t, f] of Object.entries(p.weights)) out.push({ role: "weight", path: `portfolio.weights.${t}`, src: f });
      break;
    case "event_study":
      out.push({ role: "event", path: "portfolio.event", src: p.event });
      out.push({ role: "targets", path: "portfolio.targets", src: p.targets });
      break;
  }
  return out;
}

export type SpecCheck =
  | { ok: true; spec: StrategySpecV2; uses: Uses; perFormula: Record<string, Uses>; weightOrder: string[] | null; tickers: string[] }
  | { ok: false; issues: SpecIssue[] };

function isRealDate(v: string): boolean {
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

function mergeUses(into: Uses, u: Uses) {
  u.tickers.forEach((t) => into.tickers.add(t));
  u.earningsTickers.forEach((t) => into.earningsTickers.add(t));
  into.earningsSelf ||= u.earningsSelf;
  into.ripple ||= u.ripple;
  u.params.forEach((t) => into.params.add(t));
  u.defs.forEach((t) => into.defs.add(t));
  u.wRefs.forEach((t) => into.wRefs.add(t));
  into.literals.push(...u.literals);
  u.paramSlots.forEach((v, k) => {
    if (!into.paramSlots.has(k)) into.paramSlots.set(k, v);
  });
  into.maxWindow = Math.max(into.maxWindow, u.maxWindow);
}

/**
 * Check 1 (spec valid): zod shape, then the rules a schema cannot say (dates,
 * params in range, tickers, mode restrictions), then every FSL formula through
 * the type checker. Tickers are upper-cased. Never throws.
 */
export function validateSpec(input: unknown, now = new Date()): SpecCheck {
  const parsed = SpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 12).map((i) => ({ path: i.path.join(".") || "spec", message: i.message })),
    };
  }
  const spec = structuredClone(parsed.data);
  const issues: SpecIssue[] = [];
  if (spec.universe.kind === "static") spec.universe.tickers = spec.universe.tickers.map((t) => t.trim().toUpperCase());
  if (spec.portfolio.mode === "weights") {
    const w: Record<string, string> = {};
    for (const [t, f] of Object.entries(spec.portfolio.weights)) w[t.trim().toUpperCase()] = f;
    spec.portfolio.weights = w;
    if (!Object.keys(w).length) issues.push({ path: "portfolio.weights", message: "Add at least one ticker with a weight." });
  }

  // Params.
  const names = Object.keys(spec.params);
  if (names.length > SPEC_LIMITS.maxParams) issues.push({ path: "params", message: `At most ${SPEC_LIMITS.maxParams} parameters.` });
  for (const [k, p] of Object.entries(spec.params)) {
    if (p.min > p.max) issues.push({ path: `params.${k}`, message: "min is above max." });
    if (p.value < p.min || p.value > p.max) issues.push({ path: `params.${k}`, message: `$${k} = ${p.value} is outside its range ${p.min} to ${p.max}.` });
    if (p.type === "int" && (!Number.isInteger(p.value) || !Number.isInteger(p.min) || !Number.isInteger(p.max))) {
      issues.push({ path: `params.${k}`, message: `$${k} is an int, so its value and range must be whole numbers.` });
    }
  }
  if (Object.keys(spec.defs).length > SPEC_LIMITS.maxDefs) issues.push({ path: "defs", message: `At most ${SPEC_LIMITS.maxDefs} definitions.` });
  for (const d of Object.keys(spec.defs)) {
    if (names.includes(d)) issues.push({ path: `defs.${d}`, message: `"${d}" is both a parameter and a definition.` });
  }

  // Universe and tickers.
  const tickers = universeTickers(spec);
  for (const t of tickers) if (!TICKER_RE.test(t)) issues.push({ path: "universe", message: `"${t}" is not a valid ticker.` });
  if (new Set(tickers).size !== tickers.length) issues.push({ path: "universe", message: "Tickers repeat." });

  // Mode restrictions.
  if (spec.side === "long_short") issues.push({ path: "side", message: "Long-short strategies are not available yet; long only for now." });
  if (spec.holdout === "account") issues.push({ path: "holdout", message: "Research mode (an account holdout) needs a signed-in account and is not available yet." });
  const p = spec.portfolio;
  if (p.mode === "rank" && "quantile" in p.select && p.select.quantile[0] >= p.select.quantile[1]) {
    issues.push({ path: "portfolio.select", message: "The quantile range must go from low to high, e.g. [0.8, 1]." });
  }
  if (p.mode === "rank" && "n" in p.select && typeof p.select.n === "string") {
    const pn = p.select.n.slice(1);
    const par = spec.params[pn];
    if (!par) issues.push({ path: "portfolio.select.n", message: `Unknown parameter ${p.select.n}.` });
    else if (par.type !== "int" || par.min < 1) issues.push({ path: "portfolio.select.n", message: `${p.select.n} must be an int of at least 1.` });
  }

  // Period.
  for (const k of ["start", "end"] as const) {
    const v = spec.period[k];
    if (v !== null && !isRealDate(v)) issues.push({ path: `period.${k}`, message: `${v} is not a real date.` });
  }
  const today = now.toISOString().slice(0, 10);
  if (spec.period.end && spec.period.end > today) issues.push({ path: "period.end", message: "The end cannot be in the future." });
  if (spec.period.start && spec.period.start < SPEC_LIMITS.earliestDate) issues.push({ path: "period.start", message: `No earlier than ${SPEC_LIMITS.earliestDate}.` });
  if (spec.period.start && spec.period.end && spec.period.start >= spec.period.end) issues.push({ path: "period", message: "The start must be before the end." });

  // FSL formulas.
  const env: CheckEnv = {
    mode: p.mode as Mode,
    params: spec.params,
    defs: spec.defs,
    weightTickers: p.mode === "weights" ? Object.keys(p.weights) : undefined,
  };
  const uses = emptyUses();
  const perFormula: Record<string, Uses> = {};
  const wRefs: Record<string, Set<string>> = {};
  for (const f of formulasOf(spec)) {
    const u = emptyUses();
    const r = checkFormula(f.src, f.role, env, u);
    if (!r.ok) {
      issues.push({ path: f.path, message: r.error, hint: r.hint, pos: r.pos });
      continue;
    }
    perFormula[f.path] = u;
    mergeUses(uses, u);
    if (f.role === "weight") wRefs[f.path.slice("portfolio.weights.".length)] = u.wRefs;
    if (f.role === "event" && r.type.shape === "const") issues.push({ path: f.path, message: "The event must change over time." });
  }
  if (p.mode === "rules" && p.clock === "preopen") {
    const e = perFormula["portfolio.entry"];
    if (e && !e.earningsSelf && !e.earningsTickers.size && !e.ripple) {
      issues.push({
        path: "portfolio.clock",
        message: "The pre-open clock is only for rules that react to an event (earnings or a Sighting).",
        hint: "Price rules decide on the close and fill at the next open.",
      });
    }
  }
  let order: string[] | null = null;
  if (p.mode === "weights" && !issues.length) {
    try {
      order = weightOrder(wRefs);
    } catch (e) {
      issues.push({ path: "portfolio.weights", message: e instanceof FslError ? e.message : String(e) });
    }
  }
  for (const name of names) {
    if (!uses.params.has(name) && !(p.mode === "rank" && "n" in p.select && p.select.n === `$${name}`)) {
      issues.push({ path: `params.${name}`, message: `$${name} is not used by any rule.` });
    }
  }

  const all = Array.from(new Set(tickers.concat(Array.from(uses.tickers), ["SPY"])));
  if (all.length > SPEC_LIMITS.maxTickers) issues.push({ path: "universe", message: `At most ${SPEC_LIMITS.maxTickers} tickers per run (universe plus referenced tickers), got ${all.length}.` });
  return issues.length ? { ok: false, issues } : { ok: true, spec, uses, perFormula, weightOrder: order, tickers: all };
}

/** The test window: the spec's dates, or the last 10 years to `today`. */
export function resolvePeriod(spec: Pick<StrategySpecV2, "period">, now = new Date()): { start: string; end: string } {
  const end = spec.period.end ?? now.toISOString().slice(0, 10);
  let start = spec.period.start;
  if (!start) {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 10);
    start = d.toISOString().slice(0, 10);
  }
  return { start, end };
}

// ---------------------------------------------------------------------------
// describe(spec): numbered plain-English rules, from operator templates only.

export type SpecDescription = {
  /** Numbered rules, in order. */
  rules: string[];
  /** Labels for each $param, generated from the operator slot it fills. */
  paramLabels: Record<string, string>;
  /** What the rules cannot know at each date (from the clock and the data used). */
  cannotKnow: string[];
};

function sizingText(p: Extract<Portfolio, { mode: "rules" }>): string {
  const per = typeof p.sizing === "object" ? `${p.sizing.pct}% of equity each` : p.sizing === "inverse_vol" ? "sized by inverse 63-session volatility" : `${Number((100 / p.max_positions).toFixed(2))}% of equity each`;
  return p.max_positions === 1 ? `One position at a time, ${per.replace(" each", "")}.` : `Up to ${p.max_positions} positions at once, ${per}.`;
}

const EVERY: Record<string, string> = { daily: "session", weekly: "week", monthly: "month", quarterly: "quarter" };

export function describeSpec(spec: StrategySpecV2, uses?: Uses): SpecDescription {
  const tickers = universeTickers(spec);
  const p = spec.portfolio;
  const clock = p.mode === "rules" ? p.clock : "close";
  const env: DescribeEnv = { params: spec.params, defs: spec.defs, single: tickers.length === 1 ? tickers[0]! : null, clock };
  const d = (src: string) => describeFormula(src, env);
  const rules: string[] = [];

  if (p.mode !== "weights") {
    if (spec.universe.kind === "rule") {
      const u = UNIVERSES[spec.universe.base as UniverseBase];
      rules.push(`Universe: ${u.label} (${u.tickers.length} tickers, today's membership)${spec.universe.filter ? `, only while ${d(spec.universe.filter)}` : ""}.`);
    } else {
      rules.push(tickers.length === 1 ? `Trades ${tickers[0]}.` : `Trades any of ${tickers.length} tickers: ${tickers.join(", ")}.`);
    }
  }
  const when = clock === "preopen" ? "at 09:15 New York time, using the previous close," : "on the close,";
  const fill = clock === "preopen" ? "at that day's open" : "at the next open";

  switch (p.mode) {
    case "rules": {
      rules.push(`Enters ${fill} when, ${when} ${d(p.entry)}.`);
      if (p.exit) rules.push(`Exits ${fill} when, ${when} ${d(p.exit)}.`);
      const r = spec.risk;
      if (r.stop_pct !== null) rules.push(`Stop loss ${r.stop_pct}% below the entry price.`);
      if (r.trailing_pct !== null) rules.push(`Trailing stop ${r.trailing_pct}% below the highest close since entry.`);
      if (r.take_profit_pct !== null) rules.push(`Take profit ${r.take_profit_pct}% above the entry price.`);
      if (r.max_hold_days !== null) rules.push(`Exits at the open after ${r.max_hold_days} ${r.max_hold_days === 1 ? "session" : "sessions"} held.`);
      if (!p.exit && r.stop_pct === null && r.trailing_pct === null && r.take_profit_pct === null && r.max_hold_days === null) {
        rules.push("No exit rule: positions stay open until the end of the test.");
      }
      rules.push(sizingText(p));
      if (spec.legacy) {
        rules.push("A held ticker can be entered again whenever the entry rule holds after an exit (v1 behaviour).");
      } else if (p.reentry === "edge") {
        rules.push("After an exit, a ticker is entered again only when the entry rule turns from false to true.");
      } else {
        rules.push(`After an exit, a ticker can be entered again after ${p.reentry.cooldown_days} sessions.`);
      }
      if (p.max_positions < tickers.length) {
        if (spec.legacy) rules.push("When signals outnumber free slots, entries go in the order the tickers are listed (v1 behaviour).");
        else if (p.tiebreak === "seeded") rules.push("When signals outnumber free slots, the order is a fixed pseudo-random draw seeded by these rules.");
        else rules.push(`When signals outnumber free slots, entries go by ${d(p.tiebreak.by)}, ${p.tiebreak.order === "desc" ? "highest" : "lowest"} first.`);
      }
      if (spec.legacy && spec.legacy.drift !== "none") rules.push(`Open positions go back to their entry weight every ${spec.legacy.drift === "weekly" ? "week" : "month"}.`);
      break;
    }
    case "rank": {
      const sel =
        "n" in p.select
          ? typeof p.select.n === "number"
            ? `the top ${p.select.n}`
            : `the top ${spec.params[p.select.n.slice(1)]?.value ?? "?"} (${p.select.n})`
          : `the ${Math.round(p.select.quantile[0] * 100)}th to ${Math.round(p.select.quantile[1] * 100)}th percentile`;
      rules.push(`On the last session of each ${EVERY[spec.rebalance]}, ranks the tickers with data by ${d(p.score)}, ${p.order === "desc" ? "highest" : "lowest"} first${p.filter ? `, among those where ${d(p.filter)}` : ""}.`);
      rules.push(`Holds ${sel} from the next open, ${p.weighting === "equal" ? "at equal weight" : p.weighting === "score" ? "weighted by score" : "weighted by inverse 63-session volatility"}; everything else is sold.`);
      break;
    }
    case "weights": {
      for (const [t, f] of Object.entries(p.weights)) rules.push(`Holds ${t} at a weight of ${d(f)}.`);
      rules.push(`Weights are set on the close of the last session of each ${EVERY[spec.rebalance]} and traded at the next open; weights above 100% in total are scaled down.`);
      break;
    }
    case "event_study": {
      rules.push(`Event: every date when ${d(p.event)}.`);
      rules.push(`Measures the tickers where ${d(p.targets)}, over ${p.windows.join(", ")} sessions after each event, against SPY (market model).`);
      break;
    }
  }
  if (p.mode !== "event_study") {
    const r = spec.risk;
    if (p.mode !== "rules") {
      if (r.stop_pct !== null) rules.push(`Stop loss ${r.stop_pct}% below the entry price.`);
      if (r.trailing_pct !== null) rules.push(`Trailing stop ${r.trailing_pct}% below the highest close since entry.`);
    }
    rules.push(spec.cash === "tbill" && !spec.legacy ? "Cash earns the 3-month T-bill rate." : "Cash earns nothing.");
  }

  const paramLabels: Record<string, string> = {};
  if (uses) uses.paramSlots.forEach((label, name) => (paramLabels[name] = label));
  for (const name of Object.keys(spec.params)) paramLabels[name] ??= name.replace(/_/g, " ");

  const cannotKnow: string[] = [];
  cannotKnow.push(clock === "preopen" ? "At 09:15 on a session: that session's prices, and any news after 09:15." : "On a session's close: any later price, and news after 16:00 New York time.");
  if (uses?.earningsSelf || uses?.earningsTickers.size) cannotKnow.push("Earnings releases count from their release time; an after-close release is first used on the next session.");
  if (uses?.ripple) cannotKnow.push("Sightings count from the moment they were published, with the supply links known at that time.");
  return { rules: rules.map((r, i) => `${i + 1}. ${r}`), paramLabels, cannotKnow };
}

// ---------------------------------------------------------------------------
// v1 -> v2

const MA = { sma: "ts_mean", ema: "ema" } as const;

/**
 * Converts v1 rules (schema.ts) to a v2 spec that runs identically: `legacy`
 * keeps the list-order tie-break, v1 re-entry, v1 costs and drift
 * rebalancing. TEMPLATES, saved strategies and strategyFromSighting go
 * through here.
 */
export function v1ToV2(s: Strategy, config: Partial<RunConfig> = {}, intent = ""): StrategySpecV2 {
  const params: Record<string, ParamSpec> = {};
  const add = (base: string, type: ParamSpec["type"], value: number, min: number, max: number, step = 1): string => {
    let name = base;
    for (let k = 2; name in params; k++) name = `${base}_${k}`;
    params[name] = { type, value, min: Math.min(min, value), max: Math.max(max, value), step };
    return `$${name}`;
  };
  const cond = (c: Condition): string => {
    let inner: string;
    const wrapRef = (t: string | null, x: string) => (t ? `at("${t}", ${x})` : x);
    const cmp = (op: string, a: string, b: string) =>
      op === "above" ? `${a} > ${b}` : op === "below" ? `${a} < ${b}` : op === "crosses_above" ? `crosses_above(${a}, ${b})` : `crosses_below(${a}, ${b})`;
    switch (c.type) {
      case "price_vs_ma":
        inner = cmp(c.op, "close", `${MA[c.ma]}(close, ${add("ma_len", "int", c.period, 2, 250)})`);
        return wrapRef(c.ticker, inner);
      case "ma_cross":
        inner = cmp(c.op, `${MA[c.fastMa]}(close, ${add("fast_len", "int", c.fastPeriod, 2, 250)})`, `${MA[c.slowMa]}(close, ${add("slow_len", "int", c.slowPeriod, 2, 250)})`);
        return wrapRef(c.ticker, inner);
      case "rsi":
        inner = cmp(c.op, `rsi(close, ${add("rsi_len", "int", c.period, 2, 100)})`, add("rsi_level", "number", c.value, 0, 100));
        return wrapRef(c.ticker, inner);
      case "n_day_return":
        inner = `ret(close, ${add("ret_days", "int", c.days, 1, 250)}) ${c.op === "above" ? ">" : "<"} ${add("ret_pct", "pct", c.pct, -100, 1000, 0.5)}`;
        return wrapRef(c.ticker, inner);
      case "gap":
        inner = `open / delay(close, 1) - 1 ${c.op === "above" ? ">" : "<"} ${add("gap_pct", "pct", c.pct, -100, 100, 0.5)}`;
        return wrapRef(c.ticker, inner);
      case "breakout":
        inner =
          c.op === "new_high"
            ? `close > delay(ts_max(close, ${add("high_len", "int", c.days, 2, 250)}), 1)`
            : `close < delay(ts_min(close, ${add("low_len", "int", c.days, 2, 250)}), 1)`;
        return wrapRef(c.ticker, inner);
      case "earnings_surprise": {
        inner = `earnings.surprise ${c.op === "above" ? ">" : "<"} ${add("surprise_pct", "pct", c.pct, -1000, 1000, 0.5)}`;
        if (c.daysAfter > 1) inner = `delay(${inner}, ${c.daysAfter - 1})`;
        return c.ticker ? `of("${c.ticker}", ${inner})` : inner;
      }
      case "ripple_event": {
        const parts = ["ripple.event"];
        if (c.relation) parts.push(`ripple.relation == "${c.relation}"`);
        if (c.direction === "up") parts.push("ripple.implied_dir > 0");
        if (c.direction === "down") parts.push("ripple.implied_dir < 0");
        if (c.direction === "unclear") parts.push("ripple.implied_dir == 0");
        if (c.maxDegree) parts.push(`ripple.degree <= ${c.maxDegree}`);
        inner = parts.join(" and ");
        return c.daysAfter > 1 ? `delay(${inner}, ${c.daysAfter - 1})` : inner;
      }
    }
  };
  const paren = (x: string, many: boolean) => (many && / (and|or) /.test(x) ? `(${x})` : x);
  const entryParts = s.entry.conditions.map(cond);
  const entry = entryParts.map((x) => paren(x, entryParts.length > 1)).join(s.entry.mode === "all" ? " and " : " or ");
  const exitParts = s.exit.conditions.map(cond);
  const exit = exitParts.length ? exitParts.map((x) => paren(x, exitParts.length > 1)).join(" or ") : null;

  return {
    spec_version: 2,
    name: s.name,
    intent,
    clarifications: [],
    universe: { kind: "static", tickers: [...s.universe] },
    params,
    defs: {},
    portfolio: {
      mode: "rules",
      entry,
      exit,
      max_positions: s.sizing.maxPositions,
      clock: "close",
      reentry: "edge",
      tiebreak: "seeded",
      sizing: s.sizing.positionPct !== null ? { pct: s.sizing.positionPct } : "equal",
    },
    side: "long",
    rebalance: "monthly",
    risk: { stop_pct: s.exit.stopLossPct, trailing_pct: null, take_profit_pct: s.exit.takeProfitPct, max_hold_days: s.exit.maxHoldingDays },
    execution: { commission_bps: config.commissionBps ?? 1, spread: config.slippageBps ?? 5, borrow_bps_yr: 50, gross_cap: 1 },
    capital: config.initialCapital ?? 100_000,
    cash: "zero",
    period: { start: config.start ?? null, end: config.end ?? null },
    holdout: "off",
    benchmark: "SPY",
    legacy: { tiebreak: "list_order", reentry: "v1", costs: "v1", drift: s.rebalance },
  };
}

/** A fresh spec for a blank strategy (SPY above its 200-session average). */
export function blankSpec(): StrategySpecV2 {
  return {
    ...structuredClone(DEFAULT_SPEC_FIELDS),
    name: "Untitled strategy",
    intent: "",
    universe: { kind: "static", tickers: ["SPY"] },
    params: { ma: { type: "int", value: 200, min: 20, max: 400, step: 10 } },
    portfolio: {
      mode: "rules",
      entry: "close > ts_mean(close, $ma)",
      exit: "close < ts_mean(close, $ma)",
      max_positions: 1,
      clock: "close",
      reentry: "edge",
      tiebreak: "seeded",
      sizing: "equal",
    },
  };
}

export { TICKER_RE as SPEC_TICKER_RE };
