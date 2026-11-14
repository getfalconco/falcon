/**
 * @falcon/backtest: the pure core (schema, engine, metrics, summary). No
 * network or disk here, so the browser can import it too.
 *
 *   @falcon/backtest/data  Yahoo sources, disk cache, loader, one-call `backtest()` (Node)
 *   @falcon/backtest/nl    plain English -> rules with Claude (Node)
 *   @falcon/backtest/sighting  a Sightings card -> rules (type-only imports; the iPhone app uses it)
 */

export * from "./schema";
export * from "./engine";
export * from "./metrics";
export * from "./indicators";
export { describeCondition, describeStrategy } from "./describe";
export { strategyFromSighting, windowDays, type SightingBacktest } from "./sighting";
export { SEMIS, TEMPLATES, type StrategyTemplate } from "./templates";
export { isAdviceLike, neutralize, neutralizeList, plainStyle } from "./neutralize";
export type { Bar, EarningsEvent, EarningsSource, MarketData, PriceSource, RippleSignal, RippleSource } from "./data/types";

// --- v2: Strategy Lab (FSL, StrategySpec v2, engine v2, quality suite). Pure, browser-safe.
export * from "./spec";
export { parse as parseFsl, format as formatFsl, FslError, type Node as FslNode } from "./fsl/parse";
export { checkFormula, emptyUses, type CheckEnv, FUNCTIONS as FSL_FUNCTIONS, IDENTIFIERS as FSL_IDENTIFIERS, IDENT_RE, type CheckResult, type Uses } from "./fsl/check";
export { describeFormula } from "./fsl/describe";
export { UNIVERSES, type UniverseBase } from "./universes";
export { ENGINE_V2_VERSION, ASSUMPTIONS_V2, CAVEATS_V2, runChecked, type RunResultV2, type MetricsV2, type CheckedSpec } from "./run";
export type { TradeV2, SimResult, StrategyOutput } from "./simulate";
export { floorBps, corwinSchultzBps, TIERS as COST_TIERS } from "./costs";
export * from "./audit/report";
export { evidenceLabel } from "./audit/tiers";
export type { EventStudy, WindowStats, EventRow } from "./event-study";
export { eventStudyFromHistory, hasNoHistorySource, type HistoryStudy } from "./sighting";
export { ENGINE_V1_VERSION, type RunOptions } from "./engine";
export { hashOf, seededOrder } from "./util";
export { STARTERS, type Starter } from "./starters";
export { resolvedParams as specParamValues } from "./spec";
