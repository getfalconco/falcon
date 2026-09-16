/**
 * Quant Lab (spec v1.0) — the developer surface where Falcon's quantitative
 * claims become measurable.
 *
 * Define a rule, test it against history under honest constraints, and if it
 * survives, track what it does live. Deterministic, LLM-free, read-only over
 * every other engine's stores; it places no orders and sizes nothing.
 */

export * from "./types.js";
export * from "./config.js";
export { TradingCalendar } from "./calendar.js";
export { buildQuantSeries, detectGaps, snapshotAsOf, snapshotAt } from "./series.js";
export { runBackfill, type BackfillOutcome, type BackfillSummary } from "./backfill.js";
export {
  attributeFiling,
  buildEarningsHistory,
  buildFilingEvents,
  earningsRhythmAsOf,
  earningsWithin,
  nextEarningsAsOf,
  EARNINGS_ITEM,
  type FilingEvent,
} from "./filings.js";
export {
  consecutiveSessions,
  evaluatePatternAsOf,
  evaluatePatternsAsOf,
  inactiveBurst,
  viewAsOf,
  SCREEN_ASOF_APPROXIMATIONS,
} from "./screen-asof.js";
export { gaugeInputsAsOf, screenFindingsAsOf, setupAsOf, PERMISSIVE_SETUPS } from "./gauge-asof.js";
export { edgeDisclosedAt, graphAsOf, neighboursOf, type Neighbour } from "./graph-asof.js";
export {
  isBacktestable,
  newStrategy,
  nextVersion,
  unavailableComponents,
  validateStrategy,
  type ValidationResult,
} from "./strategy.js";
export {
  buildSectorIndex,
  computeHorizonReturn,
  entryPriceOf,
  headlineValue,
  resolveWindow,
  sectorMedianReturn,
  windowReturn,
  type ReturnContext,
  type Window,
} from "./returns.js";
export { dollarVolume, generateSignals, screenUniverse, type SignalGenResult } from "./signals.js";
export {
  bootstrapMedianCI,
  deciles,
  equityCurve,
  hitRate,
  maxDrawdown,
  mean,
  median,
  percentile,
  seeded,
  sharpe,
  sortino,
  stdDev,
} from "./stats.js";
export {
  assembleReport,
  computeHorizonStats,
  computeSampleStats,
  overfitWarning,
  sampleBaseRate,
  splitWindow,
  variantWarning,
  verdictLine,
} from "./report.js";
export {
  defaultWindow,
  loadEnvironment,
  runAndStore,
  runBacktest,
  type BacktestEnvironment,
} from "./backtest.js";
export { buildEquityCurve, EQUITY_ASSUMPTION, type EquityCurve, type EquityPoint } from "./equity.js";
export { missingSeeds, SEED_STRATEGIES } from "./seeds.js";
export {
  canEnable,
  completeSignals,
  evaluateLive,
  fillForwardReturns,
  forwardSignals,
  liveSignalId,
  type EnableDecision,
} from "./ledger.js";
export {
  LedgerStore,
  QuantLabConfigStore,
  ResultStore,
  SeriesStore,
  StrategyStore,
  resolveQuantLabDataDir,
} from "./store.js";

