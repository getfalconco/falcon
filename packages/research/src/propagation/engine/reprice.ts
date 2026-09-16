import { computePricing } from "./pricing.js";
import { summarize, type QuantSource } from "./stage1.js";
import type { PropagationConfig } from "./config.js";
import type { PropagationRun, PropagationTarget } from "./types.js";

/**
 * Re-measures a stored run's targets against the current tape.
 *
 * Stage-1 prices a run once, at creation, and `PropagationService` returns any
 * existing run straight from cache — so without this pass a target's realized
 * move, its last price and its `sessions_elapsed` stay frozen at the moment the
 * run was built. The card then shows a live quote beside a share-of-the-called-
 * move computed from a close days older, and the share cannot move however far
 * the name travels.
 *
 * The inputs come from the target itself — its transmission tier and direction,
 * and the run's event timestamp — so this is the same measurement taken later.
 *
 * One caveat worth stating, because it is not obvious: the direction read here
 * is not always the one stage-1 priced against. `mergeStage2` rewrites
 * `transmission.direction` in place when the model adjusts it, or when stage-1
 * left it `unclear` (schema.ts). So a stored run can hold a refined direction
 * beside a price measured against the original. Repricing adopts the refined
 * one, deliberately: it is the direction the run now stands behind, and it is
 * what the card's own priced-in figure already uses (it prefers
 * `stage2.direction`). A number that changes sign here is that disagreement
 * being settled, not drift.
 *
 * A target is left alone once it is `stale`. `classifyPricing` stamps that as
 * soon as the horizon is passed, and the horizon is one-way: the run's window
 * has closed, its verdict is final, and re-asking would only spend quota to
 * rewrite a number nobody should be watching any more.
 */

export type RepriceOptions = {
  run: PropagationRun;
  config: PropagationConfig;
  quant: QuantSource;
  /** ISO instant to measure against — the caller's cycle clock. */
  now: string;
};

export type RepriceResult = {
  run: PropagationRun;
  /** Targets whose pricing was recomputed. */
  repriced: number;
  /** Of those, how many changed the numbers the card reads. */
  changed: number;
};

/** Worth re-asking the tape about? */
export function shouldReprice(target: PropagationTarget): boolean {
  if (!target.tracked) return false;
  if (!target.ticker) return false;
  // Vetoed targets are excluded from every priced-in figure, so measuring them
  // again would be work nothing reads.
  if (target.stage2?.verdict === "vetoed") return false;
  // Terminal. See the note above.
  if (target.pricing.status === "stale") return false;
  return true;
}

export async function repriceRun(options: RepriceOptions): Promise<RepriceResult> {
  const { run, config, quant, now } = options;
  const eventTs = run.event?.event_ts;
  if (!eventTs) return { run, repriced: 0, changed: 0 };

  let repriced = 0;
  let changed = 0;
  const targets: PropagationTarget[] = [];

  for (const target of run.targets) {
    if (!shouldReprice(target) || !quant.isTracked(target.ticker as string)) {
      targets.push(target);
      continue;
    }
    const snapshot = await quant.snapshot(target.ticker as string).catch(() => null);
    if (!snapshot) {
      // A snapshot that failed to load is not evidence about the price. Keeping
      // the previous reading is honest; overwriting it with `unknown` would
      // erase a real measurement because one request happened to fail.
      targets.push(target);
      continue;
    }
    const pricing = computePricing({
      snapshot,
      eventTs,
      now,
      tier: target.transmission.tier,
      direction: target.transmission.direction,
      config: config.pricing,
    });
    // A snapshot can arrive without the history the measurement needs — the
    // engine then answers `unknown`, which is "I could not look", not "there
    // is nothing there". Writing that over a real reading would delete a
    // measurement because the tracker happened to be cold, and the card would
    // lose a number it had been showing correctly for days. A reading only
    // ever gets replaced by another reading.
    if (pricing.status === "unknown" && target.pricing.status !== "unknown") {
      targets.push(target);
      continue;
    }
    repriced += 1;
    const before = target.pricing;
    if (
      before.status !== pricing.status ||
      before.realized_resid_pct !== pricing.realized_resid_pct ||
      before.realized_raw_pct !== pricing.realized_raw_pct ||
      before.last_price !== pricing.last_price ||
      before.sessions_elapsed !== pricing.sessions_elapsed
    ) {
      changed += 1;
    }
    targets.push({ ...target, pricing });
  }

  if (changed === 0) return { run, repriced, changed: 0 };
  // The summary counts targets by pricing status, so it has to be rebuilt
  // from the new statuses — otherwise a run whose last open target just
  // priced in still reports open > 0, and the card keeps calling it live.
  // Same helper stage-1 uses, so the counts stay defined the same way.
  return { run: { ...run, targets, summary: summarize(targets) }, repriced, changed };
}

/**
 * Reprices a set of runs, newest first. Returns only the runs that actually
 * changed, so a caller can persist the minimum.
 */
export async function repriceRuns(options: {
  runs: PropagationRun[];
  config: PropagationConfig;
  quant: QuantSource;
  now: string;
}): Promise<{ updated: PropagationRun[]; repriced: number; changed: number }> {
  const updated: PropagationRun[] = [];
  let repriced = 0;
  let changed = 0;
  for (const run of options.runs) {
    const result = await repriceRun({
      run,
      config: options.config,
      quant: options.quant,
      now: options.now,
    });
    repriced += result.repriced;
    changed += result.changed;
    if (result.changed > 0) updated.push(result.run);
  }
  return { updated, repriced, changed };
}
