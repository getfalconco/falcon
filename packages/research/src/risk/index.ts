/**
 * Risk Engine (spec v1.0) — deterministic portfolio risk index for the paper
 * account: five components, a blended 0–100 score with band semantics, one
 * driver sentence. No LLM, no external fetches.
 */

export * from "./types.js";
export * from "./config.js";
export * from "./anchors.js";
export * from "./network.js";
export * from "./components.js";
export * from "./blend.js";
export * from "./compute.js";
export * from "./triggers.js";
export * from "./gather.js";
export { RiskConfigStore, RiskAccountStore, RiskSnapshotStore, resolveRiskDataDir, toHistoryItem } from "./store.js";

/**
 * The host. Lives here (not in a consumer) because the desktop panel and the
 * always-on engine service run the same one; where a fresh snapshot is pushed
 * is injected.
 */
export * from "./host-types.js";
export { RiskHost, getRiskHost, setRiskNotifier, type RiskNotifier } from "./host.js";
