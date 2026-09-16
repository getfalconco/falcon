/**
 * Analyst — the reasoning engine for primary-ticker anomalies (spec v1.0).
 *
 * Consumes Base routing requests with `destination: analyst` and returns
 * structured assessments: cause, mechanism, evidence, edge status and a
 * falsifiable watch trigger. Everything around the single model call is
 * deterministic and tested against recorded fixtures.
 */

export * from "./types.js";
export * from "./config.js";
export * from "./reaction.js";
export * from "./assemble.js";
export * from "./schema.js";
export * from "./prompt.js";
export * from "./requests.js";
export * from "./service.js";
export {
  AnalystConfigStore,
  AnalystOutputStore,
  FileBackend,
  MemoryBackend,
  emptyMetrics,
  isExpired,
  loadAnalystConfig,
  outputKey,
  resolveAnalystDataDir,
  type AnalystBackend,
  type AttemptRecord,
  type OutputListOptions,
} from "./store.js";
export { anthropicConfigured, anthropicModelCaller } from "./anthropic.js";

/**
 * The host. Lives here (not in a consumer) because the desktop panel and the
 * always-on engine service run the same one; what differs is injected.
 */
export * from "./host-types.js";
export { AnalystHost, getAnalystHost } from "./host.js";
