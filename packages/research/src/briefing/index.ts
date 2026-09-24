/**
 * Handover briefing (spec v1.0) — the report a reader meets before the US
 * open: the overnight sessions, the book they carried through them, the
 * corporate events on the names they hold, and today's calendar.
 *
 * Deterministic assembly over injected ports, so the desktop, the replay
 * script and any later engine handler supply their own way of reaching the
 * world; one short model-written narrative over the same facts, with a
 * template that stands in for it.
 */

export * from "./types.js";
export * from "./window.js";
export * from "./expiry.js";
export * from "./rebalance.js";
export * from "./index-map.js";
export * from "./data/macro-calendar.js";
export * from "./macro-calendar.js";
export * from "./markets.js";
export * from "./book.js";
export * from "./implications.js";
export * from "./stories.js";
export * from "./narrative.js";
export * from "./chain-slice.js";
export * from "./gather.js";
