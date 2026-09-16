/**
 * Base Engine — deterministic coordination layer between Tracker and the
 * downstream specialist engines (spec v1.2).
 *
 * Built so far: the incident model (§2), priority scoring (§3) and the
 * routing table (§4). Batching/budget/supersession (§5) and the live wiring
 * to Tracker land on top of these.
 */

export * from "./article-dedupe.js";
export * from "./classification.js";
export * from "./config.js";
export * from "./incident.js";
export * from "./pre-earnings-preview.js";
export * from "./priority.js";
export * from "./replay.js";
export * from "./routing.js";
export * from "./tags.js";
export * from "./types.js";
export { BaseConfigStore, loadBaseConfig, resolveBaseDataDir } from "./store.js";
