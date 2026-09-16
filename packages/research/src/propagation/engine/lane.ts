/**
 * Which lane a run actually took, and whether that was the lane it deserved (§S3b).
 *
 * Falcon has two paths from an event to a signal and they differ by three
 * orders of magnitude. A mapped 8-K or a gap can take the fast path — no LLM,
 * no budget, no waiting — and lands in seconds. Anything reaching propagation
 * through a Classifier verdict waits on batch cycles instead.
 *
 * Measured over the 24 runs in the live store on 2026-08-26:
 *
 *   filing trigger, fast path fired   15 s · 24 s · 115 s · 117 s · 202 s
 *   filing trigger, fast path missed  6.87 h · 6.87 h · 6.91 h · 43.5 h · 79.3 h
 *   news trigger (verdict lane)       19.6 h … 105.8 h, median 40.6 h
 *
 * The middle row is the finding. Those five runs had the SAME trigger type as
 * the five above them — the fast path exists for exactly them, and it did not
 * fire. Half of every eligible filing was silently demoted to the 15-minute
 * replay, and nothing anywhere recorded that a lane had been missed: the run
 * looked normal, only late.
 *
 * That is what "make it consistent" means operationally. A product that is
 * fast half the time and two days late the other half cannot be sold on speed,
 * and a miss nobody counts is a miss nobody fixes. So every run now records
 * the lane it took, and a run that qualified for the fast lane and did not get
 * it is counted as a miss rather than averaged into a latency number where it
 * disappears.
 *
 * Pure — the host supplies the run and the eligibility rule, this decides.
 */

import type { PropagationEvent, PropagationRun } from "./types.js";

/** How a run reached production. */
export type PropagationLane = "fast_path" | "cycle";

export type LaneVerdict = {
  lane: PropagationLane;
  /** Whether the triggering event could have taken the fast path at all. */
  eligible: boolean;
  /** Eligible, but produced by the cycle: the fast path should have caught this. */
  missed: boolean;
  /** Event instant → run produced, in ms; null when either timestamp is unusable. */
  event_to_run_ms: number | null;
};

/**
 * A run slower than this, on an eligible trigger, is a miss rather than a slow
 * fast path. The fast path debounces and then runs stage-1 for one ticker, so
 * a healthy pass is seconds; the replay cycle is 15 minutes. Ten minutes sits
 * clear of both and needs no tuning to stay meaningful.
 */
export const FAST_PATH_DEADLINE_MS = 10 * 60_000;

/**
 * Whether an event could have taken the fast path.
 *
 * This mirrors `fastPathTrigger`, but reads the EVENT on a finished run rather
 * than a live Tracker message — by the time a run exists the message that
 * caused it may be long gone, and the question "should this have been fast?"
 * still has to be answerable from the run alone.
 *
 * `filing_item` is the mapped-8-K lane and `gap_cause` is the market's own
 * read; a `verdict` event came through the Classifier and was never eligible.
 */
export function eligibleForFastPath(event: Pick<PropagationEvent, "source">): boolean {
  return event.source === "filing_item" || event.source === "gap_cause";
}

export function eventToRunMs(run: Pick<PropagationRun, "event" | "produced_at">): number | null {
  const from = Date.parse(run.event?.event_ts ?? "");
  const to = Date.parse(run.produced_at ?? "");
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const delta = to - from;
  // A run produced before its own event is a clock problem, not a negative
  // latency; report it as unusable rather than letting it drag a median down.
  return delta >= 0 ? delta : null;
}

/**
 * Classify one produced run.
 *
 * `lane` is what actually happened and only the producer knows it, so it is
 * passed in rather than inferred — a fast-path run that happened to take
 * eleven minutes is still a fast-path run, and a cycle run that landed inside
 * the deadline is still a cycle run.
 */
export function classifyLane(
  run: Pick<PropagationRun, "event" | "produced_at">,
  lane: PropagationLane,
): LaneVerdict {
  const eligible = eligibleForFastPath(run.event);
  const elapsed = eventToRunMs(run);
  const missed =
    eligible && lane === "cycle" && elapsed !== null && elapsed > FAST_PATH_DEADLINE_MS;
  return { lane, eligible, missed, event_to_run_ms: elapsed };
}

/** Per-lane latency counters, kept beside the model-call metrics. */
export type LaneMetrics = {
  fast_path_runs: number;
  cycle_runs: number;
  /** Eligible for the fast path, produced by the cycle anyway. */
  fast_path_missed: number;
  /** Event → run, ms, for runs the fast path produced. */
  fast_path_latencies_ms: number[];
  /** Event → run, ms, for runs the cycle produced. */
  cycle_latencies_ms: number[];
};

export function emptyLaneMetrics(): LaneMetrics {
  return {
    fast_path_runs: 0,
    cycle_runs: 0,
    fast_path_missed: 0,
    fast_path_latencies_ms: [],
    cycle_latencies_ms: [],
  };
}

/** How many samples to keep per lane — enough for a stable p50/p90, bounded on disk. */
export const LANE_LATENCY_WINDOW = 500;

export function recordLane(metrics: LaneMetrics, verdict: LaneVerdict): LaneMetrics {
  const next: LaneMetrics = {
    ...metrics,
    fast_path_latencies_ms: [...(metrics.fast_path_latencies_ms ?? [])],
    cycle_latencies_ms: [...(metrics.cycle_latencies_ms ?? [])],
  };
  if (verdict.lane === "fast_path") next.fast_path_runs += 1;
  else next.cycle_runs += 1;
  if (verdict.missed) next.fast_path_missed += 1;
  if (verdict.event_to_run_ms !== null) {
    const bucket = verdict.lane === "fast_path" ? next.fast_path_latencies_ms : next.cycle_latencies_ms;
    bucket.push(verdict.event_to_run_ms);
    if (bucket.length > LANE_LATENCY_WINDOW) bucket.splice(0, bucket.length - LANE_LATENCY_WINDOW);
  }
  return next;
}

export type LaneSummary = {
  runs: number;
  p50_ms: number | null;
  p90_ms: number | null;
};

function percentileOf(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

/**
 * The service-level read: p50 and p90 per lane, and the miss rate.
 *
 * The miss rate is deliberately its own number rather than folded into the
 * cycle percentiles. A missed fast path is not a slow run — it is a run that
 * took the wrong lane, and averaging it into the lane it wrongly took is
 * exactly how this stayed invisible.
 */
export function summarizeLanes(metrics: LaneMetrics): {
  fast_path: LaneSummary;
  cycle: LaneSummary;
  fast_path_missed: number;
  /** missed ÷ (fast-path runs + missed); null when nothing was eligible. */
  fast_path_miss_rate: number | null;
} {
  const fast = [...(metrics.fast_path_latencies_ms ?? [])].sort((a, b) => a - b);
  const cycle = [...(metrics.cycle_latencies_ms ?? [])].sort((a, b) => a - b);
  const missed = metrics.fast_path_missed ?? 0;
  const eligible = (metrics.fast_path_runs ?? 0) + missed;
  return {
    fast_path: {
      runs: metrics.fast_path_runs ?? 0,
      p50_ms: percentileOf(fast, 0.5),
      p90_ms: percentileOf(fast, 0.9),
    },
    cycle: {
      runs: metrics.cycle_runs ?? 0,
      p50_ms: percentileOf(cycle, 0.5),
      p90_ms: percentileOf(cycle, 0.9),
    },
    fast_path_missed: missed,
    fast_path_miss_rate: eligible > 0 ? missed / eligible : null,
  };
}
