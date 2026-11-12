/**
 * @falcon/backtest: the pure core (schema, engine, metrics, summary). No
 * network or disk here, so the browser can import it too.
 *
 *   @falcon/backtest/data  Yahoo sources, disk cache, loader, one-call `backtest()` (Node)
 *   @falcon/backtest/nl    plain English -> rules with Claude (Node)
 */

export * from "./schema";
export * from "./engine";
export * from "./metrics";
export * from "./indicators";
export { describeCondition, describeStrategy } from "./describe";
export { isAdviceLike, neutralize, neutralizeList, plainStyle } from "./neutralize";
export type { Bar, EarningsEvent, EarningsSource, MarketData, PriceSource, RippleSignal, RippleSource } from "./data/types";
