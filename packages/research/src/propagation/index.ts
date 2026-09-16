/**
 * Propagation contracts and shared stores.
 *
 * The first-generation engine (traverse → judge → gate → mint) and its
 * signal stores are gone; ./engine is the system that replaced it. What
 * remains here is the vocabulary other subsystems still speak (graph types,
 * priced-in checks) and the graph/engine-health backend stores.
 */

export {
  checkPricedIn,
  fetchCurrentPrice,
  fetchLatestPrice,
  fetchPriceNear,
  type LatestPrice,
} from "./priced-in.js";
export { loadGraphFile } from "./load-graph.js";
export {
  persistGraphToSupabase,
  isGraphBackendConfigured,
  type GraphEdgeLike,
} from "./graph-supabase-store.js";
export {
  persistEngineHealth,
  isEngineHealthBackendConfigured,
  type EngineHealthPayload,
} from "./engine-health-store.js";
export type {
  CandidatePath,
  DailySignalsFile,
  GraphEdge,
  GraphFile,
  PathHop,
  PropagationEvent,
  SecondOrderSignal,
  SignalOutcome,
} from "./types.js";
