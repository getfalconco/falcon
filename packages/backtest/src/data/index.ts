/** Node-only data layer: Yahoo sources, cache, loader, and the one-call `backtest()`. */

export * from "./types";
export { JsonCache, defaultCacheDir } from "./cache";
export { BROWSER_USER_AGENT, DeadlineError, PoliteFetcher, yahooFetcher } from "./http";
export {
  YahooEarningsSource,
  YahooPriceSource,
  mergeEarnings,
  parseChart,
  parseEarningsCalendar,
  parseQuoteSummaryEarnings,
  surprisePct,
} from "./yahoo";
export { WARMUP_CALENDAR_DAYS, backtest, defaultSources, hasQuarterGap, loadMarketData } from "./load";
export type { BacktestOptions, BacktestOutcome, Sources } from "./load";
export { runSpec, auditSpec, loadSpecData, type SpecOutcome, type SpecRunOptions, type AuditResult } from "./run-spec";
export { providerFromEnv, fileRippleSource, type MarketDataProvider, type RippleEventSource } from "./provider";
export { FredRateSource, parseFredCsv, DTB3_URL, type RateSource } from "./fred";
