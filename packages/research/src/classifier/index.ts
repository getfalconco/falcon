/**
 * Classifier — the first LLM-bearing engine (spec v1.0).
 *
 * Consumes classification requests from Base for news articles and unmapped
 * 8-Ks and returns structured verdicts. Everything around the single model
 * call is deterministic and tested against recorded fixtures.
 */

export * from "./types.js";
export * from "./config.js";
export * from "./schema.js";
export * from "./metadata.js";
export * from "./prompt.js";
export * from "./filing-items.js";
export * from "./service.js";
export * from "./eval.js";
export {
  ClassifierConfigStore,
  FileBackend,
  MemoryBackend,
  VerdictStore,
  emptyMetrics,
  isExpired,
  loadClassifierConfig,
  resolveClassifierDataDir,
  verdictKey,
  type AttemptRecord,
  type ClassifierBackend,
} from "./store.js";
export { anthropicConfigured, anthropicModelCaller } from "./anthropic.js";

/**
 * The Phase A host — the cycle owner. Lives here (not in a consumer) because
 * both the desktop panel and the always-on engine service run it.
 */
export * from "./host-types.js";
export { ClassifierHost, getClassifierHost } from "./host.js";
