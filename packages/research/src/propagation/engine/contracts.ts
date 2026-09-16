/**
 * Renderer-safe contracts for the Propagation engine.
 *
 * Everything re-exported here is pure: types, and functions over plain run
 * data. No fs, no network, no Anthropic client — so a browser bundle can
 * import it, which is what lets the desktop renderer and the engine share one
 * definition of "how much of the called move has been priced in" instead of
 * keeping a hand-synced mirror of it.
 *
 * The Node-only surface (stores, service, hosts) stays behind
 * `@meridian/research/propagation/engine`.
 */

export * from "./progress.js";
export * from "./pair.js";
export * from "./fast-path.js";

/** Host-facing shapes (run rows, cycle summary, status) — types only. */
export type * from "./host-types.js";
