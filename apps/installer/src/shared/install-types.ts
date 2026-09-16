/**
 * What the main process reports while it fetches, verifies and runs the real
 * Falcon setup. The renderer turns this into the bar, the file name and the
 * done state — it does no work of its own.
 */
export type InstallPhase =
  | "idle"
  | "connecting"
  | "downloading"
  | "verifying"
  | "installing"
  | "done"
  | "failed";

export type InstallProgress = {
  phase: InstallPhase;
  /** 0–100 overall, or null while there is nothing to measure yet. */
  value: number | null;
  /** Shown beside the bar: the artifact being fetched, or the step running. */
  label: string;
  /** Version being installed, once the feed has been read. */
  version?: string;
  /** Set only when phase is "failed". */
  error?: string;
};

/** Slices of the overall bar. Downloading owns most of it because it takes most of the time. */
export const PHASE_RANGES = {
  downloading: [0, 88],
  verifying: [88, 94],
  installing: [94, 99],
} as const;
