/**
 * The strategy format: explicit rules a user can read and edit. The natural
 * language parser writes it, the engine reads it, the UI shows it.
 *
 * Every field is required; "not set" is `null`, never a missing key. That keeps
 * one schema for both the Claude structured output and the API input.
 *
 * Timing (see README): every condition is read on the close of day t with data
 * up to and including day t. Orders fill at the open of day t+1.
 */

import { z } from "zod/v4";
import type { Confidence, Direction, Relation } from "@falcon/ripple";

// zod registers its English messages as a module side effect, which bundlers
// drop (zod declares sideEffects: false). Without this the web app only says "Invalid input".
z.config(z.locales.en());

export const LIMITS = {
  /** Distinct tickers a run may load (universe plus any condition reference tickers). */
  maxTickers: 25,
  /** Longest test window. */
  maxYears: 10,
  earliestDate: "1995-01-01",
  maxIndicatorPeriod: 250,
  maxConditions: 6,
  maxHoldingDays: 252,
  maxDaysAfter: 20,
  minCapital: 1_000,
  maxCapital: 1_000_000_000,
  maxBps: 200,
} as const;

/** Exchange tickers as Yahoo spells them: BRK-B, ^VIX, RDS.A. Upper case. */
export const TICKER_RE = /^\^?[A-Z0-9][A-Z0-9.\-]{0,9}$/;

export const BENCHMARK = "SPY";

const RELATIONS = ["customer", "supplier", "competitor", "peer"] as const satisfies readonly Relation[];
const DIRECTIONS = ["up", "down", "unclear"] as const satisfies readonly Direction[];
const CONFIDENCES = ["low", "medium", "high"] as const satisfies readonly Confidence[];

const Ticker = z.string().max(12).describe("Exchange ticker in upper case, e.g. SPY, NVDA, BRK-B");
const RefTicker = Ticker.nullable().describe(
  "Read this condition on another ticker's prices (e.g. SPY as a market filter). null = the ticker being traded.",
);
const Period = z.number().int().min(2).max(LIMITS.maxIndicatorPeriod);
const MaKind = z.enum(["sma", "ema"]).describe("sma = simple moving average, ema = exponential moving average");
const CrossOp = z
  .enum(["above", "below", "crosses_above", "crosses_below"])
  .describe("above/below: true every day the relation holds. crosses_*: true only on the day it flips.");
const SideOp = z.enum(["above", "below"]);
const DaysAfter = z
  .number()
  .int()
  .min(1)
  .max(LIMITS.maxDaysAfter)
  .describe(
    "Trading days after the announcement. 1 = buy at the open of the first session after the announcement day.",
  );

export const PriceVsMa = z.object({
  type: z.literal("price_vs_ma"),
  ticker: RefTicker,
  ma: MaKind,
  period: Period,
  op: CrossOp,
});

export const MaCross = z.object({
  type: z.literal("ma_cross"),
  ticker: RefTicker,
  fastMa: MaKind,
  fastPeriod: Period,
  slowMa: MaKind,
  slowPeriod: Period,
  op: CrossOp.describe("Relation of the fast average to the slow one."),
});

export const Rsi = z.object({
  type: z.literal("rsi"),
  ticker: RefTicker,
  period: z.number().int().min(2).max(100).describe("Wilder RSI period, commonly 14; 2 for short-term"),
  op: CrossOp,
  value: z.number().min(0).max(100),
});

export const NDayReturn = z.object({
  type: z.literal("n_day_return"),
  ticker: RefTicker,
  days: z.number().int().min(1).max(LIMITS.maxIndicatorPeriod),
  op: SideOp,
  pct: z.number().min(-100).max(1000).describe("Percent change of the close over `days` sessions, e.g. -5"),
});

export const Gap = z.object({
  type: z.literal("gap"),
  ticker: RefTicker,
  op: SideOp,
  pct: z.number().min(-100).max(100).describe("Today's open vs yesterday's close in percent, e.g. 2 or -3"),
});

export const Breakout = z.object({
  type: z.literal("breakout"),
  ticker: RefTicker,
  days: z.number().int().min(2).max(LIMITS.maxIndicatorPeriod),
  op: z.enum(["new_high", "new_low"]).describe("Close above the highest (below the lowest) close of the prior `days` sessions"),
});

export const EarningsSurprise = z.object({
  type: z.literal("earnings_surprise"),
  ticker: Ticker.nullable().describe(
    "Whose earnings releases: null = the traded ticker's own. Set it (e.g. NVDA) to trade other tickers after that company reports.",
  ),
  op: SideOp.describe("above: EPS surprise above pct (a beat when pct >= 0). below: under pct (a miss when pct <= 0)."),
  pct: z.number().min(-1000).max(1000).describe("EPS surprise in percent: (actual - estimate) / |estimate| * 100"),
  daysAfter: DaysAfter,
});

export const RippleEventCond = z.object({
  type: z.literal("ripple_event"),
  relation: z.enum(RELATIONS).nullable().describe("What the traded company is to the event company; null = any"),
  direction: z.enum(DIRECTIONS).nullable().describe("Direction on the ripple card; null = any"),
  minConfidence: z.enum(CONFIDENCES).nullable(),
  maxDegree: z.union([z.literal(1), z.literal(2)]).nullable().describe("1 = direct links only; null = any"),
  daysAfter: DaysAfter,
});

export const Condition = z.discriminatedUnion("type", [
  PriceVsMa,
  MaCross,
  Rsi,
  NDayReturn,
  Gap,
  Breakout,
  EarningsSurprise,
  RippleEventCond,
]);

export const StrategySchema = z.object({
  version: z.literal(1),
  name: z.string().max(80).describe("Short neutral name, e.g. 'SPY above 200-day average'"),
  universe: z.array(Ticker).min(1).max(LIMITS.maxTickers).describe("Tickers the strategy may hold"),
  entry: z.object({
    mode: z.enum(["all", "any"]).describe("all = every condition must hold; any = one is enough"),
    conditions: z.array(Condition).min(1).max(LIMITS.maxConditions),
  }),
  exit: z.object({
    conditions: z
      .array(Condition)
      .max(LIMITS.maxConditions)
      .describe("Exit at the next open when any of these is true on the close. May be empty."),
    stopLossPct: z.number().min(0.5).max(95).nullable().describe("Exit when price falls this % below the entry fill"),
    takeProfitPct: z.number().min(0.5).max(1000).nullable().describe("Exit when price rises this % above the entry fill"),
    maxHoldingDays: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.maxHoldingDays)
      .nullable()
      .describe("Exit at the open after this many trading sessions held"),
  }),
  sizing: z.object({
    maxPositions: z.number().int().min(1).max(LIMITS.maxTickers).describe("Most positions open at once"),
    positionPct: z
      .number()
      .min(1)
      .max(100)
      .nullable()
      .describe("Percent of equity per new position; null = 100 / maxPositions"),
  }),
  rebalance: z
    .enum(["none", "weekly", "monthly"])
    .describe("Bring open positions back to their target weight at the first open of each week or month"),
});

export const CONDITION_TYPES = Condition.options.map((o) => o.shape.type.value);

export type Condition = z.infer<typeof Condition>;
export type Strategy = z.infer<typeof StrategySchema>;
export type ConditionType = Condition["type"];
export type TechnicalCondition = Exclude<Condition, { type: "earnings_surprise" | "ripple_event" }>;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const RunConfigSchema = z.object({
  start: IsoDate,
  end: IsoDate,
  initialCapital: z.number().min(LIMITS.minCapital).max(LIMITS.maxCapital),
  commissionBps: z.number().min(0).max(LIMITS.maxBps),
  slippageBps: z.number().min(0).max(LIMITS.maxBps),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;

export const DEFAULT_RUN = { initialCapital: 100_000, commissionBps: 1, slippageBps: 5 } as const;

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function zodErrors(error: z.ZodError, max = 12): string[] {
  return error.issues.slice(0, max).map((i) => {
    const where = i.path.length ? i.path.join(".") : "input";
    if (i.code === "invalid_union" && i.path[i.path.length - 1] === "type") {
      return `${where}: unknown condition type (use one of ${CONDITION_TYPES.join(", ")})`;
    }
    return `${where}: ${i.message}`;
  });
}

/** Tickers a strategy needs prices for: its universe plus condition reference tickers. */
export function strategyTickers(s: Strategy): string[] {
  const out = new Set<string>(s.universe);
  for (const c of [...s.entry.conditions, ...s.exit.conditions]) {
    if ("ticker" in c && c.ticker) out.add(c.ticker);
  }
  return Array.from(out);
}

function upper<T>(v: T): T {
  return (typeof v === "string" ? v.trim().toUpperCase() : v) as T;
}

/**
 * Shape check plus the rules a schema cannot say: ticker spelling, the ticker
 * cap across universe and references, no duplicate tickers. Tickers are
 * upper-cased first so "spy" is accepted.
 */
export function validateStrategy(input: unknown): Validation<Strategy> {
  const parsed = StrategySchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  const s = structuredClone(parsed.data);
  s.universe = s.universe.map(upper);
  for (const c of [...s.entry.conditions, ...s.exit.conditions]) {
    if ("ticker" in c && c.ticker) c.ticker = upper(c.ticker);
  }
  const errors: string[] = [];
  for (const t of strategyTickers(s)) {
    if (!TICKER_RE.test(t)) errors.push(`ticker "${t}" is not a valid symbol`);
  }
  if (new Set(s.universe).size !== s.universe.length) errors.push("universe: tickers repeat");
  const total = strategyTickers(s).length;
  if (total > LIMITS.maxTickers) {
    errors.push(`at most ${LIMITS.maxTickers} tickers per run (universe plus reference tickers), got ${total}`);
  }
  for (const c of [...s.entry.conditions, ...s.exit.conditions]) {
    if (c.type === "ma_cross" && c.fastPeriod >= c.slowPeriod) {
      errors.push("ma_cross: fastPeriod must be shorter than slowPeriod");
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: s };
}

function isRealDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}

export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addYears(iso: string, years: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/**
 * Fills defaults (last 10 years to today, 100k capital, 1 bps commission,
 * 5 bps slippage) and checks the window: real dates, start before end, not in
 * the future, no earlier than 1995, at most 10 years.
 */
export function validateRunConfig(input: Partial<RunConfig> | undefined, now = new Date()): Validation<RunConfig> {
  const today = todayIso(now);
  const end = input?.end ?? today;
  if (!isRealDate(end)) return { ok: false, errors: [`end: ${String(end)} is not a real date (YYYY-MM-DD)`] };
  const merged = {
    start: input?.start ?? addYears(end, -LIMITS.maxYears),
    end,
    initialCapital: input?.initialCapital ?? DEFAULT_RUN.initialCapital,
    commissionBps: input?.commissionBps ?? DEFAULT_RUN.commissionBps,
    slippageBps: input?.slippageBps ?? DEFAULT_RUN.slippageBps,
  };
  const parsed = RunConfigSchema.safeParse(merged);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  const c = parsed.data;
  const errors: string[] = [];
  if (!isRealDate(c.start)) return { ok: false, errors: [`start: ${c.start} is not a real date`] };
  if (c.start < LIMITS.earliestDate) errors.push(`start: no earlier than ${LIMITS.earliestDate}`);
  if (c.end > today) errors.push("end: cannot be in the future");
  if (daysBetween(c.start, c.end) < 30) errors.push("the window must be at least 30 days");
  if (c.start < addYears(c.end, -LIMITS.maxYears)) errors.push(`the window can be at most ${LIMITS.maxYears} years`);
  return errors.length ? { ok: false, errors } : { ok: true, value: c };
}
