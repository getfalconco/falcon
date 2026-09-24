/**
 * Session calendar — what is scheduled for the US session a reader is on:
 * the curated macro releases and FOMC decisions, options expiries and index
 * rebalances by rule, the earnings dates of the names they hold, and the
 * session's own exceptions.
 *
 * Deterministic assembly over injected ports, so the desktop and any later
 * engine handler supply their own way of reaching the chain and the provider.
 */

export * from "./types.js";
export * from "./window.js";
export * from "./expiry.js";
export * from "./rebalance.js";
export * from "./index-map.js";
export * from "./data/macro-calendar.js";
export * from "./macro-calendar.js";
export * from "./today.js";
export * from "./build.js";
