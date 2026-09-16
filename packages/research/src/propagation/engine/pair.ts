/**
 * The pair record — every event the engine has propagated from one root to one
 * particular name, and how each call turned out. Pure data shaping, shared by
 * the host and the desktop pair frame (see `progress.ts` on why it lives here).
 */

import type {
  EventDirection as PropagationDirection,
  Materiality as PropagationMateriality,
  PricingStatus,
  PropagationRole,
  PropagationTier,
  StrengthTier as PropagationStrengthTier,
} from "./types.js";

/**
 * The record between two companies: every event the engine has propagated
 * from a root to one particular name, and how each of those calls turned out.
 *
 * Read straight off the run store in the main process — the renderer must
 * never have to pull hundreds of full runs to answer "how often has this
 * pair's read been right?".
 */

/**
 * What became of one call. The engine's own pricing statuses, read as a
 * verdict on the direction it transmitted:
 * - `hit` — moved the way it said, far enough to count (`priced`)
 * - `partial` — moved that way, but short of the expected size
 * - `miss` — moved against it (`contradicted`)
 * - `open` — not enough movement yet to say
 * - `expired` — the horizon passed without a resolution (`stale`)
 */
export type PairOutcome = "hit" | "partial" | "miss" | "open" | "expired";

/**
 * The engine's own pricing thresholds, mirrored so the desktop can read a
 * measured move the same way the engine scored it. Keep in step with
 * `pricing` in the propagation config.
 */
export const OPEN_BELOW = 0.35;
export const PRICED_AT_OR_ABOVE = 1;

/**
 * The verdict on one call, from how far it has travelled toward the move that
 * was called (see `targetPricedIn`: signed, 1 is the whole of it).
 *
 * Read from the number rather than from `pricing.status` because runs written
 * by older engine builds carry a status that their own note contradicts —
 * "moved against the transmitted direction" filed as `partial`. The number is
 * recomputed from the stored prices every time, so it is never stale.
 */
export function pairOutcome(pricedIn: number | null, status: PricingStatus): PairOutcome {
  if (pricedIn == null || !Number.isFinite(pricedIn)) {
    // Nothing measurable: only the status can say whether time ran out.
    return status === "stale" ? "expired" : "open";
  }
  if (Math.abs(pricedIn) < OPEN_BELOW) return status === "stale" ? "expired" : "open";
  if (pricedIn < 0) return "miss";
  if (status === "stale") return "expired";
  return pricedIn >= PRICED_AT_OR_ABOVE ? "hit" : "partial";
}

/** Only calls that resolved with a direction belong in the rate. */
export function isResolved(outcome: PairOutcome): boolean {
  return outcome === "hit" || outcome === "partial" || outcome === "miss";
}

export type PairHistoryEvent = {
  run_id: string;
  event_label: string;
  event_type: string;
  event_direction: PropagationDirection;
  event_materiality: PropagationMateriality;
  event_ts: string;
  produced_at: string;
  /** What the engine expected of this name — stage 2's read where it has one. */
  expected_direction: PropagationDirection;
  transmission_tier: PropagationTier;
  mechanism: string;
  pricing_status: PricingStatus;
  outcome: PairOutcome;
  /** The size the engine expected, and what the name actually did (residual). */
  expected_pct: number | null;
  realized_pct: number | null;
  /** realised / expected, the engine's own ratio. */
  ratio: number | null;
  sessions_elapsed: number | null;
  /** 0–1 priced-in share, the same reading the cards use. */
  progress: number;
  /** Signed share of the called move travelled — see `targetPricedIn`. */
  priced_in: number | null;
};

export type PropagationPairHistory = {
  root: string;
  target: string;
  /** The name as the graph knows it. */
  label: string | null;
  role: PropagationRole | null;
  tier: PropagationStrengthTier | null;
  /** How the root reaches it, from the most recent run that said. */
  mechanism: string | null;
  /** Newest first. */
  events: PairHistoryEvent[];
  hits: number;
  partials: number;
  misses: number;
  open: number;
  expired: number;
  /** (hits + partials) / resolved — the share where the direction was right. */
  hit_rate: number | null;
  /** Mean expected and realised size across the resolved calls, in percent. */
  avg_expected_pct: number | null;
  avg_realized_pct: number | null;
  /** Mean realised/expected across the resolved calls — how much of the
   *  called move the name actually made. */
  avg_ratio: number | null;
};

export type PropagationPairHistoryResult =
  | { ok: true; history: PropagationPairHistory }
  | { ok: false; error: string };
