/**
 * Backtest report assembly and the §7 guards.
 *
 * The guards are the product. A backtest that only reported its own numbers
 * would be a machine for producing encouraging results, so every figure here
 * is placed next to the thing that undermines it:
 *
 *  - the base rate, beside the strategy's own median
 *  - the bootstrap CI, beside the point estimate
 *  - the out-of-sample block, beside the in-sample one
 *  - the variant count, beside all of it
 *
 * And below thirty signals no point estimate is printed at all. The
 * distribution is still shown, because "we do not know" is a finding and a
 * shape is still information, but a median of seventeen trades is not.
 */

import type { QuantLabConfig } from "./config.js";
import { computeHorizonReturn, headlineValue, resolveWindow, type ReturnContext } from "./returns.js";
import { buildEquityCurve } from "./equity.js";
import type { TradingCalendar } from "./calendar.js";
import {
  bootstrapMedianCI,
  deciles,
  hitRate,
  maxDrawdown,
  mean,
  median,
  seeded,
  sharpe,
  sortino,
} from "./stats.js";
import type {
  BacktestReport,
  Exclusion,
  HorizonStats,
  ReturnLayer,
  SampleStats,
  Signal,
  Strategy,
} from "./types.js";

/** The value a horizon is scored on, under the report's headline layer. */
function layerValue(signal: Signal, sessions: number, layer: ReturnLayer): number | null {
  const ret = signal.returns.find((r) => r.sessions === sessions);
  if (!ret) return null;
  if (layer === "raw") return ret.raw;
  if (layer === "market_adjusted") return ret.market_adjusted ?? ret.raw;
  return headlineValue(ret);
}

export type BaseRateDeps = {
  ctx: ReturnContext;
  calendar: TradingCalendar;
  multiplier: number;
  rand: () => number;
};

/**
 * The base rate: the same tickers, the same horizon, entered on random dates.
 *
 * Without it the strategy's number is unreadable. "+0.4% median at 5 sessions"
 * means nothing until you know whether holding those same names for five
 * sessions on any random day also returns +0.4%.
 *
 * Sampling is per signal and matched on ticker, so a strategy that fires mostly
 * on one volatile name is compared against that name, not against the universe
 * average.
 */
export function sampleBaseRate(
  signals: Signal[],
  sessions: number,
  layer: ReturnLayer,
  strategy: Strategy,
  deps: BaseRateDeps,
): { median: number | null; n: number } {
  const draws: number[] = [];
  for (const signal of signals) {
    const series = deps.ctx.seriesByTicker.get(signal.ticker);
    if (!series || series.snapshots.length === 0) continue;
    for (let i = 0; i < deps.multiplier; i++) {
      const at = (deps.rand() * series.snapshots.length) | 0;
      const randomSession = series.snapshots[at]?.d;
      if (!randomSession) continue;
      const window = resolveWindow(deps.calendar, randomSession, strategy.entry.when, sessions);
      if (!window?.exit) continue;
      const snap = series.snapshots[at];
      const ret = computeHorizonReturn(deps.ctx, {
        ticker: signal.ticker,
        window,
        holdSessions: sessions,
        // Signed the same way as the signal it is the counterfactual for:
        // comparing a short strategy against a long base rate would flatter or
        // damn it purely on market drift.
        sign: signal.sign,
        beta: snap.beta,
      });
      const value = layer === "raw" ? ret.raw : layer === "market_adjusted" ? ret.market_adjusted ?? ret.raw : headlineValue(ret);
      if (value != null) draws.push(value);
    }
  }
  return { median: median(draws), n: draws.length };
}

export type HorizonStatsDeps = {
  config: QuantLabConfig;
  layer: ReturnLayer;
  strategy: Strategy;
  baseRate: BaseRateDeps;
};

export function computeHorizonStats(signals: Signal[], sessions: number, deps: HorizonStatsDeps): HorizonStats {
  const scored = signals
    .map((s) => ({ signal: s, value: layerValue(s, sessions, deps.layer) }))
    .filter((s): s is { signal: Signal; value: number } => s.value != null);
  const values = scored.map((s) => s.value);
  const nTickers = new Set(scored.map((s) => s.signal.ticker)).size;

  const base = sampleBaseRate(
    scored.map((s) => s.signal),
    sessions,
    deps.layer,
    deps.strategy,
    deps.baseRate,
  );

  // §7: below the floor no point estimate is printed. The distribution still
  // is — a shape is information even when a median is not.
  const insufficient = values.length < deps.config.backtest.minSignals;
  if (insufficient) {
    return {
      sessions,
      n: values.length,
      n_tickers: nTickers,
      median: null,
      mean: null,
      hit_rate: null,
      sharpe: null,
      sortino: null,
      max_drawdown: null,
      ci_low: null,
      ci_high: null,
      deciles: deciles(values),
      base_rate_median: base.median,
      base_rate_n: base.n,
      insufficient: true,
    };
  }

  const annualisation = {
    holdSessions: sessions,
    sessionsPerYear: deps.config.backtest.sessionsPerYear,
    riskFreeRate: deps.config.backtest.riskFreeRate,
  };
  // Drawdown is path-dependent, so the equity curve must run in the order the
  // signals actually fired.
  const chronological = [...scored]
    .sort((a, b) => a.signal.session.localeCompare(b.signal.session))
    .map((s) => s.value);
  const ci = bootstrapMedianCI(values, deps.config.backtest.bootstrapIterations, deps.baseRate.rand);

  return {
    sessions,
    n: values.length,
    n_tickers: nTickers,
    median: median(values),
    mean: mean(values),
    hit_rate: hitRate(values),
    sharpe: sharpe(values, annualisation),
    sortino: sortino(values, annualisation),
    max_drawdown: maxDrawdown(chronological),
    ci_low: ci?.low ?? null,
    ci_high: ci?.high ?? null,
    deciles: deciles(values),
    base_rate_median: base.median,
    base_rate_n: base.n,
    insufficient: false,
  };
}

export function computeSampleStats(
  label: SampleStats["label"],
  signals: Signal[],
  from: string,
  to: string,
  deps: HorizonStatsDeps,
): SampleStats {
  return {
    label,
    from,
    to,
    horizons: deps.strategy.hold.sessions.map((h) => computeHorizonStats(signals, h, deps)),
  };
}

/**
 * Splits the window by DATE, not by signal count.
 *
 * Splitting on the signal index would let a strategy that fired heavily in one
 * regime put most of that regime on both sides of the line. A date split keeps
 * the out-of-sample period a genuinely later period.
 */
export function splitWindow(
  calendar: TradingCalendar,
  from: string,
  to: string,
  inSampleRatio: number,
): { isFrom: string; isTo: string; oosFrom: string; oosTo: string } | null {
  const sessions = calendar.range(from, to);
  if (sessions.length < 2) return null;
  const cut = Math.max(1, Math.min(sessions.length - 1, Math.floor(sessions.length * inSampleRatio)));
  return {
    isFrom: sessions[0],
    isTo: sessions[cut - 1],
    oosFrom: sessions[cut],
    oosTo: sessions[sessions.length - 1],
  };
}

const pct = (v: number | null): string => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);
const num2 = (v: number | null): string => (v == null ? "n/a" : v.toFixed(2));

/**
 * One deterministic sentence, shown at the top of the Results tab.
 *
 * It reads the OUT-OF-SAMPLE block, never the in-sample one: the in-sample
 * number is the one the rule was shaped against, so leading with it would
 * make the verdict a description of the search rather than of the strategy.
 */
export function verdictLine(oos: SampleStats, config: QuantLabConfig): string {
  const scored = oos.horizons.filter((h) => !h.insufficient);
  if (scored.length === 0) {
    const best = oos.horizons.reduce<HorizonStats | null>((a, h) => (a == null || h.n > a.n ? h : a), null);
    return `Insufficient out-of-sample signals (n=${best?.n ?? 0}) — below the ${config.backtest.minSignals}-signal floor, no point estimate.`;
  }
  // The horizon with the most evidence, not the most flattering one.
  const chosen = scored.reduce((a, h) => (h.n > a.n ? h : a));
  const edge = chosen.median != null && chosen.base_rate_median != null ? chosen.median - chosen.base_rate_median : null;

  const head = `OOS median ${pct(chosen.median)} vs base rate ${pct(chosen.base_rate_median)} at ${chosen.sessions}d, n=${chosen.n}, Sharpe ${num2(chosen.sharpe)}`;

  const straddles =
    chosen.ci_low != null &&
    chosen.ci_high != null &&
    chosen.base_rate_median != null &&
    chosen.ci_low <= chosen.base_rate_median &&
    chosen.base_rate_median <= chosen.ci_high;

  if (edge == null) return `${head} — base rate unavailable, no comparison possible.`;
  if (straddles) return `${head} — the confidence interval contains the base rate, indistinguishable from it: no edge.`;
  if (edge < 0) return `${head} — below its own base rate: negative edge.`;
  const magnitude = Math.abs(edge) < 0.005 ? "marginal edge" : Math.abs(edge) < 0.015 ? "modest edge" : "material edge";
  return `${head} — ${magnitude} of ${pct(edge)} over base rate.`;
}

/**
 * "IS Sharpe 1.8 vs OOS 0.2 — likely overfit."
 *
 * The gap is flagged in BOTH directions. A collapse from in-sample to
 * out-of-sample is the overfitting signature the spec names. The reverse — a
 * rule that only works in the recent period — is not overfitting, but it is
 * just as disqualifying for a rule you intend to run forward, and it would
 * otherwise slip through as a good result.
 */
export function overfitWarning(
  inSample: SampleStats,
  outOfSample: SampleStats,
  config: QuantLabConfig,
): string | null {
  for (const is of inSample.horizons) {
    const oos = outOfSample.horizons.find((h) => h.sessions === is.sessions);
    if (!oos || is.sharpe == null || oos.sharpe == null) continue;
    const gap = is.sharpe - oos.sharpe;
    if (gap >= config.backtest.overfitSharpeGap) {
      return `IS Sharpe ${num2(is.sharpe)} vs OOS ${num2(oos.sharpe)} at ${is.sessions}d — likely overfit.`;
    }
    if (-gap >= config.backtest.overfitSharpeGap) {
      return `IS Sharpe ${num2(is.sharpe)} vs OOS ${num2(oos.sharpe)} at ${is.sessions}d — the edge exists only in the recent period, so it is regime-dependent, not established.`;
    }
  }
  return null;
}

/**
 * Flags a split that cannot do its job because one side is empty.
 *
 * This is common and legitimate — a strategy reading the relationship graph
 * can only fire from the earliest edge disclosure onward, which may be well
 * inside the nominal window. Reporting it as a warning rather than as a silent
 * `n=0` is the difference between a stated limit and an apparent bug.
 */
export function splitWarning(
  signals: Signal[],
  inSample: SampleStats,
  outOfSample: SampleStats,
): string | null {
  const isN = Math.max(0, ...inSample.horizons.map((h) => h.n));
  const oosN = Math.max(0, ...outOfSample.horizons.map((h) => h.n));
  if (isN > 0 && oosN > 0) return null;
  if (signals.length === 0) return null;
  const first = signals[0].session;
  const last = signals[signals.length - 1].session;
  const empty = isN === 0 ? "in-sample" : "out-of-sample";
  return (
    `IS/OOS split is degenerate — the ${empty} period holds no signals. ` +
    `All ${signals.length} signals fall between ${first} and ${last}. ` +
    `Re-run with the window narrowed to that span to get a split that separates anything.`
  );
}

export function variantWarning(variantNumber: number, config: QuantLabConfig): string | null {
  if (variantNumber <= config.backtest.variantWarningThreshold) return null;
  return `Selection across many variants inflates apparent performance. This is variant ${variantNumber}; treat the best result as a hypothesis, not a finding.`;
}

export type AssembleReportInput = {
  reportId: string;
  strategy: Strategy;
  config: QuantLabConfig;
  calendar: TradingCalendar;
  ctx: ReturnContext;
  signals: Signal[];
  window: { from: string; to: string };
  excluded: Exclusion[];
  variantNumber: number;
  extraCaveats: string[];
  now: string;
};

export function assembleReport(input: AssembleReportInput): BacktestReport {
  const layer: ReturnLayer = "sector_relative";
  const baseDeps: BaseRateDeps = {
    ctx: input.ctx,
    calendar: input.calendar,
    multiplier: input.config.backtest.baseRateMultiplier,
    // One generator for the whole report, seeded from config: re-running a
    // backtest must not move the intervals.
    rand: seeded(input.config.backtest.randomSeed),
  };
  const deps: HorizonStatsDeps = { config: input.config, layer, strategy: input.strategy, baseRate: baseDeps };

  const split = splitWindow(input.calendar, input.window.from, input.window.to, input.config.backtest.inSampleRatio);
  const inSampleSignals = split ? input.signals.filter((s) => s.session <= split.isTo) : [];
  const oosSignals = split ? input.signals.filter((s) => s.session >= split.oosFrom) : [];

  const full = computeSampleStats("full", input.signals, input.window.from, input.window.to, deps);
  const inSample = computeSampleStats("in_sample", inSampleSignals, split?.isFrom ?? input.window.from, split?.isTo ?? input.window.to, deps);
  const outOfSample = computeSampleStats("out_of_sample", oosSignals, split?.oosFrom ?? input.window.from, split?.oosTo ?? input.window.to, deps);

  return {
    report_id: input.reportId,
    strategy_id: input.strategy.strategy_id,
    strategy_version: input.strategy.version,
    strategy_name: input.strategy.name,
    created_at: input.now,
    window: input.window,
    headline_layer: layer,
    full,
    in_sample: inSample,
    out_of_sample: outOfSample,
    variant_number: input.variantNumber,
    variant_warning: variantWarning(input.variantNumber, input.config),
    overfit_warning: overfitWarning(inSample, outOfSample, input.config),
    split_warning: splitWarning(input.signals, inSample, outOfSample),
    created_after_oos_view: input.strategy.created_after_oos_view,
    verdict: verdictLine(outOfSample, input.config),
    excluded: input.excluded,
    caveats: [...input.config.reportCaveats, ...input.extraCaveats],
    signals: input.signals,
    equity: input.strategy.hold.sessions.map((horizon) =>
      buildEquityCurve({
        signals: input.signals,
        ctx: input.ctx,
        calendar: input.calendar,
        horizon,
        when: input.strategy.entry.when,
        from: input.window.from,
        to: input.window.to,
      }),
    ),
  };
}
