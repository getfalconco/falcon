/**
 * Gauge (spec v1.0) — the pre-flight instrument panel: deterministic
 * condition checks over a tracked ticker's live quant state, standalone or
 * against a thesis context. Never a recommendation; no LLM, no fetches, no
 * persistence beyond config.
 */

export * from "./types.js";
export * from "./config.js";
export * from "./templates.js";
export * from "./checks.js";
export * from "./summary.js";
export * from "./setups.js";
export * from "./compute.js";
export * from "./gather.js";
export * from "./memo.js";
export { GaugeConfigStore, GaugeSnapshotStore, resolveGaugeDataDir, snapshotKey, toSnapshot } from "./store.js";

/**
 * The host. Lives here (not in a consumer) because the desktop panel and the
 * always-on engine service run the same one; what differs is injected.
 */
export * from "./host-types.js";
export { GaugeHost, getGaugeHost } from "./host.js";
