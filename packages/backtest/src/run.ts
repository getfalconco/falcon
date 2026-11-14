/**
 * The v2 run, pure: a checked spec and loaded data in, curves, trades,
 * metrics and the Tier A quality report out. The Node wrapper that loads data
 * is data/run-spec.ts.
 */

import { tierA } from "./audit/tiers";
import type { QualityReport } from "./audit/report";
import { EVIDENCE_SUBTITLE, HYPOTHETICAL } from "./audit/report";
import { eventStudy, type EventStudy } from "./event-study";
import { cagrPct, curveMetrics, maxDrawdownPct, type CurveMetrics } from "./metrics";
import { asSeries, computeOutput, evalEnv, simOptions, type ComputedOutput } from "./output";
import { prepare, type Prepared, type SpecData } from "./prepare";
import { buyAndHold, simulate, type SimOptions, type SimResult, type TradeV2 } from "./simulate";
import { describeSpec, resolvePeriod, specHash, universeTickers, type SpecCheck, type SpecDescription, type StrategySpecV2 } from "./spec";
import { Evaluator } from "./fsl/eval";
import { mean, std } from "./stats";

export const ENGINE_V2_VERSION = "2.0";

export type CheckedSpec = Extract<SpecCheck, { ok: true }>;

export type MetricsV2 = CurveMetrics & {
  /** Sharpe of daily returns over the T-bill rate (DTB3). */
  sharpeRf: number | null;
};

export type RunResultV2 = {
  version: 2;
  engine: string;
  spec: StrategySpecV2;
  specHash: string;
  describe: SpecDescription;
  period: { start: string; end: string; sessions: number };
  dates: string[];
  curves: { strategy: number[]; benchmark: number[]; equalWeight: number[] | null; invested: number[] } | null;
  benchmark: { ticker: string; label: string };
  trades: TradeV2[];
  yearly: { year: string; strategyPct: number; benchmarkPct: number; equalWeightPct: number | null; activePct: number }[];
  metrics: {
    strategy: MetricsV2;
    benchmark: MetricsV2;
    equalWeight: MetricsV2 | null;
    /** Arithmetic mean of daily active returns x 252, percent. */
    activeAnnualPct: number;
    activeVsEqualWeightPct: number | null;
    tradeCount: number;
    winRatePct: number | null;
    avgTradeReturnPct: number | null;
    exposurePct: number;
    /** One-sided turnover per year (1 = the whole book once). */
    turnoverAnnual: number;
    costsPaid: number;
    skippedEntries: number;
    capacityAdvPct: number | null;
  };
  eventStudy: EventStudy | null;
  quality: QualityReport;
  sources: SpecData["sources"];
  warnings: string[];
  assumptions: string[];
  caveats: string[];
  provenance: { specHash: string; engine: string; dataProvider: string; betaSource: boolean; ratesFallback: boolean; rippleConnected: boolean; trial: number };
};

export const ASSUMPTIONS_V2 = [
  "On the close clock, rules read each session's close and orders fill at the next open. On the pre-open clock (event rules only), rules read the previous close and events known by 09:15 New York time, and fill at that day's open.",
  "Stops and take-profit orders fill at their level during the day, or at the open when the price gaps past them. A day that touches both is assumed to hit the stop.",
  "Prices are adjusted for splits and dividends, so dividends count as reinvested. Shares are fractional.",
  "Each fill pays half the spread (a floor set by the stock's average dollar volume and price) plus the commission.",
  "Idle cash earns the 3-month T-bill rate (FRED DTB3), and Sharpe uses it as the risk-free rate.",
  "When entry signals outnumber free slots, the order is a fixed pseudo-random draw seeded by the rules.",
];

export const CAVEATS_V2 = [
  HYPOTHETICAL,
  "Survivorship bias: the price source only lists companies that trade today. Delisted, merged and bankrupt names are missing, which tends to flatter results for lists of stocks picked today.",
  "Earnings history from Yahoo can miss quarters, mainly in the most recent year.",
];

export function curveWithRf(values: Float64Array | number[], dates: string[], rf: Float64Array | null): MetricsV2 {
  const v = Array.from(values);
  const m = curveMetrics(v, dates);
  const ex: number[] = [];
  for (let i = 1; i < v.length; i++) ex.push((v[i - 1]! > 0 ? v[i]! / v[i - 1]! - 1 : 0) - (rf ? rf[i] ?? 0 : 0));
  const sd = std(ex);
  return { ...m, sharpeRf: sd > 1e-12 ? (mean(ex) / sd) * Math.sqrt(252) : null };
}

export function dailyRets(v: Float64Array | number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < v.length; i++) out.push(v[i - 1]! > 0 ? v[i]! / v[i - 1]! - 1 : 0);
  return out;
}

export type Sim = { sim: SimResult; computed: ComputedOutput };

/** Evaluate and simulate a spec on prepared data (the building block of every check). */
export function simulateSpec(check: CheckedSpec, prep: Prepared, extra: Partial<SimOptions> = {}, spec: StrategySpecV2 = check.spec): Sim {
  const computed = computeOutput(spec, prep, check.weightOrder);
  const sim = simulate(prep.panel, computed.output, simOptions(spec, prep, computed.universe, extra));
  return { sim, computed };
}

export type Benchmarks = { spy: Float64Array; ew: Float64Array | null };

export function benchmarks(spec: StrategySpecV2, prep: Prepared): Benchmarks {
  const legacy = Boolean(spec.legacy);
  const opts = {
    capital: spec.capital,
    commissionBps: spec.execution.commission_bps,
    spread: spec.execution.spread,
    noCostFloor: legacy,
    cashRate: legacy || spec.cash === "zero" ? null : prep.tbill,
  };
  const spy = buyAndHold(prep.panel, ["SPY"], prep.startIndex, prep.endIndex, opts);
  const tickers = universeTickers(spec);
  const ew = tickers.length > 1 || tickers[0] !== "SPY" ? buyAndHold(prep.panel, tickers, prep.startIndex, prep.endIndex, opts) : null;
  return { spy, ew };
}

function yearly(dates: string[], s: Float64Array, b: Float64Array, ew: Float64Array | null) {
  const out: RunResultV2["yearly"] = [];
  let i0 = 0;
  for (let i = 1; i <= dates.length; i++) {
    if (i === dates.length || dates[i]!.slice(0, 4) !== dates[i0]!.slice(0, 4)) {
      const base = i0 === 0 ? 0 : i0 - 1;
      const r = (x: Float64Array) => (x[i - 1]! / x[base]! - 1) * 100;
      out.push({ year: dates[i0]!.slice(0, 4), strategyPct: r(s), benchmarkPct: r(b), equalWeightPct: ew ? r(ew) : null, activePct: r(s) - r(b) });
      i0 = i;
    }
  }
  return out;
}

export type RunOptionsV2 = { trials?: number; now?: Date; data: SpecData };

export function runChecked(check: CheckedSpec, opts: RunOptionsV2): RunResultV2 {
  const spec = check.spec;
  const period = resolvePeriod(spec, opts.now);
  const p = spec.portfolio;
  const clock = p.mode === "rules" ? p.clock : "close";
  const tickers = Array.from(new Set([...check.tickers]));
  const prep = prepare(opts.data, tickers, period, clock, Boolean(spec.legacy));
  const hash = specHash(spec);
  const description = describeSpec(spec, check.uses);
  const warnings = [...opts.data.warnings, ...prep.warnings];
  const universe = universeTickers(spec);
  const dates = prep.panel.dates.slice(prep.startIndex, prep.endIndex + 1);
  const provenance = {
    specHash: hash,
    engine: ENGINE_V2_VERSION,
    dataProvider: opts.data.sources.prices,
    betaSource: opts.data.flags.betaSource,
    ratesFallback: opts.data.flags.ratesFallback,
    rippleConnected: opts.data.flags.rippleConnected,
    trial: Math.max(1, opts.trials ?? 1),
  };
  if (check.uses.ripple && !opts.data.flags.rippleConnected) {
    warnings.push("Sightings history is not connected to the backtester yet, so ripple.* rules never fire in this run.");
  }
  if (opts.data.flags.ratesFallback && !spec.legacy) warnings.push("The T-bill rate (FRED DTB3) could not be loaded, so cash earned 0% and Sharpe used a 0% risk-free rate.");
  for (const t of universe) {
    const c = prep.panel.col.get(t)!;
    const T = prep.panel.dates.length;
    let any = false;
    for (let i = prep.startIndex; i <= prep.endIndex && !any; i++) any = prep.panel.has[c * T + i] === 1;
    if (!any) warnings.push(`${t}: no price data in the test window, left out.`);
  }

  if (p.mode === "event_study") {
    const ev = new Evaluator(evalEnv(spec, prep));
    const U = universe.length;
    const T = prep.panel.dates.length;
    const event = asSeries(ev.run(p.event), U, T);
    const targets = asSeries(ev.run(p.targets), U, T);
    const hits = new Float64Array(U * T);
    for (let i = 0; i < hits.length; i++) hits[i] = event[i]! > 0 && targets[i]! > 0 ? 1 : 0;
    const study = eventStudy(prep.panel, universe, hits, p.windows, { start: prep.startIndex, end: prep.endIndex }, 1, parseInt(hash.slice(0, 8), 16));
    const quality = tierA({ check, prep, data: opts.data, trials: provenance.trial, now: opts.now ?? new Date(), base: null, bench: null, study });
    return {
      version: 2,
      engine: ENGINE_V2_VERSION,
      spec,
      specHash: hash,
      describe: description,
      period: { start: dates[0]!, end: dates[dates.length - 1]!, sessions: dates.length },
      dates: [],
      curves: null,
      benchmark: { ticker: "SPY", label: "SPY (market model)" },
      trades: [],
      yearly: [],
      metrics: emptyMetrics(),
      eventStudy: study,
      quality,
      sources: opts.data.sources,
      warnings,
      assumptions: ASSUMPTIONS_V2,
      caveats: CAVEATS_V2,
      provenance,
    };
  }

  const base = simulateSpec(check, prep);
  const bench = benchmarks(spec, prep);
  const sim = base.sim;
  const rf = sim.cashRate;
  const sM = curveWithRf(sim.equity, dates, rf);
  const bM = curveWithRf(bench.spy, dates, rf);
  const eM = bench.ew ? curveWithRf(bench.ew, dates, rf) : null;
  for (const m of [sM, bM, ...(eM ? [eM] : [])]) {
    m.startValue = spec.capital;
    m.totalReturnPct = (m.endValue / spec.capital - 1) * 100;
    m.annualizedReturnPct = cagrPct(spec.capital, m.endValue, dates[0]!, dates[dates.length - 1]!);
  }
  const benchCurve = spec.benchmark === "equal_weight_universe" && bench.ew ? bench.ew : bench.spy;
  const sr = dailyRets(sim.equity);
  const br = dailyRets(benchCurve);
  const active = sr.map((x, i) => x - br[i]!);
  const ewr = bench.ew ? dailyRets(bench.ew) : null;
  const years = dates.length / 252;
  const trades = sim.trades;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const quality = tierA({ check, prep, data: opts.data, trials: provenance.trial, now: opts.now ?? new Date(), base, bench, study: null });
  if (sim.skippedEntries > 0) warnings.push(`${sim.skippedEntries} entry signals were not taken because every position slot was in use or cash ran out.`);

  return {
    version: 2,
    engine: ENGINE_V2_VERSION,
    spec,
    specHash: hash,
    describe: description,
    period: { start: dates[0]!, end: dates[dates.length - 1]!, sessions: dates.length },
    dates,
    curves: {
      strategy: Array.from(sim.equity),
      benchmark: Array.from(bench.spy),
      equalWeight: bench.ew ? Array.from(bench.ew) : null,
      invested: Array.from(sim.invested),
    },
    benchmark: spec.benchmark === "equal_weight_universe" ? { ticker: "EW", label: "Equal-weight universe held throughout" } : { ticker: "SPY", label: "SPY held throughout" },
    trades,
    yearly: yearly(dates, sim.equity, bench.spy, bench.ew),
    metrics: {
      strategy: sM,
      benchmark: bM,
      equalWeight: eM,
      activeAnnualPct: mean(active) * 252 * 100,
      activeVsEqualWeightPct: ewr ? mean(sr.map((x, i) => x - ewr[i]!)) * 252 * 100 : null,
      tradeCount: trades.length,
      winRatePct: trades.length ? (wins / trades.length) * 100 : null,
      avgTradeReturnPct: trades.length ? mean(trades.map((t) => t.returnPct)) : null,
      exposurePct: (Array.from(sim.invested).filter((x) => x > 0).length / dates.length) * 100,
      turnoverAnnual: years > 0 ? Array.from(sim.turnover).reduce((a, b) => a + b, 0) / 2 / years : 0,
      costsPaid: sim.costsPaid,
      skippedEntries: sim.skippedEntries,
      capacityAdvPct: sim.maxAdvPct,
    },
    eventStudy: null,
    quality,
    sources: opts.data.sources,
    warnings,
    assumptions: spec.legacy ? ASSUMPTIONS_V2.slice(0, 3).concat("v1 rules: a fixed slippage per fill, cash earns nothing, ties go in list order.") : ASSUMPTIONS_V2,
    caveats: CAVEATS_V2,
    provenance,
  };
}

function emptyMetrics(): RunResultV2["metrics"] {
  const z: MetricsV2 = { totalReturnPct: 0, annualizedReturnPct: null, sharpe: null, sharpeRf: null, maxDrawdownPct: 0, volatilityPct: null, startValue: 0, endValue: 0 };
  return {
    strategy: z,
    benchmark: z,
    equalWeight: null,
    activeAnnualPct: 0,
    activeVsEqualWeightPct: null,
    tradeCount: 0,
    winRatePct: null,
    avgTradeReturnPct: null,
    exposurePct: 0,
    turnoverAnnual: 0,
    costsPaid: 0,
    skippedEntries: 0,
    capacityAdvPct: null,
  };
}

export { maxDrawdownPct, EVIDENCE_SUBTITLE };
