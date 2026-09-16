/**
 * Propagation engine — spec v1.0.
 *
 * Consumes Base routing requests with `destination: propagation` (and
 * band-qualified Classifier candidates), walks the Deep Research graph one
 * hop, applies the transmission matrix and the pricing check
 * deterministically (stage-1), and refines under the subtract-only rule
 * (stage-2). Everything around the single model call is pure and tested
 * against recorded fixtures.
 */

export * from "./types.js";
export * from "./config.js";
export * from "./graph.js";
export * from "./traverse.js";
export * from "./matrix.js";
export * from "./pricing.js";
export * from "./mechanism.js";
export * from "./event.js";
export * from "./requests.js";
export * from "./stage1.js";
export * from "./reprice.js";
export * from "./schema.js";
export * from "./prompt.js";
export * from "./service.js";
export {
  FileBackend,
  MemoryBackend,
  PropagationConfigStore,
  PropagationRunStore,
  coerceStoredRun,
  emptyPropagationMetrics,
  isExpired,
  loadPropagationConfig,
  resolvePropagationDataDir,
  type AttemptRecord,
  type PropagationBackend,
  type RunListOptions,
} from "./store.js";
export { anthropicConfigured, anthropicModelCaller } from "./anthropic.js";

/**
 * The cycle owner. Lives here (not in a consumer) because the desktop panel
 * and the always-on engine service run the same host; what differs — where
 * runs are mirrored, who is told, which Classifier answers — is injected.
 */
export * from "./host-types.js";
export {
  PropagationHost,
  configurePropagationHost,
  getPropagationHost,
  resolveGraphPath,
  setGraphPathFallback,
  type HostNotifier,
  type PropagationHostDeps,
  type RemoteRuns,
  type VerdictLookupSource,
} from "./host.js";
