/**
 * Screen (spec v1.0) — the tape-driven opportunity channel: multi-session
 * structures over the tracked universe's persisted quant series, scanned every
 * close. Deterministic, LLM-free, read-only over the Tracker stores, surface-
 * only (no pipeline messages, incidents, routing or budget).
 */

export * from "./types.js";
export * from "./config.js";
export * from "./templates.js";
export * from "./series.js";
export * from "./patterns.js";
export * from "./lifecycle.js";
export * from "./gather.js";
export * from "./scan.js";
export * from "./emit.js";
export * from "./hook.js";
export { ScreenConfigStore, ScreenFindingsStore, ScreenMessageStore, resolveScreenDataDir } from "./store.js";
export {
  bandHeadline,
  dominantSector,
  fmtTimes,
  type BandCandidate,
  type BandHeadline,
  type BandHeadlineInput,
  type BandMode,
} from "./band-headline.js";

/**
 * The host. Lives here (not in a consumer) because the desktop panel and the
 * always-on engine service run the same one; what differs is injected.
 */
export * from "./host-types.js";
export { ScreenHost, getScreenHost, setScreenNotifier, type ScreenNotifier } from "./host.js";
