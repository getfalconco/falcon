/**
 * Priced-in arithmetic shared by every reader of a run — the host's run-list
 * projection, the desktop dashboard card, the calendar and the pair frame.
 *
 * Pure functions over a `PropagationTarget`: no fs, no network, no config, so
 * the renderer imports them through `@meridian/research/propagation/contracts`
 * without pulling Node-only code into the Vite bundle.
 */

import type { PropagationTarget } from "./types.js";

/**
 * How far a target's move has been priced in, 0–1 — the one reading shared by
 * the dashboard card's target list, the calendar and the run list: open 0,
 * partial by the engine's realised/expected ratio (held inside the bar so it
 * never reads as fully open or fully priced), priced and stale 1.
 */
export function targetProgress(t: PropagationTarget): number {
  switch (t.pricing.status) {
    case "open":
      return 0;
    case "partial": {
      const r = t.pricing.ratio;
      return r == null || !Number.isFinite(r) ? 0.5 : Math.max(0.15, Math.min(0.85, r));
    }
    case "priced":
    case "stale":
      return 1;
    default:
      return 0.5;
  }
}

/**
 * A run's absorption, 0–1: the mean progress of its tracked, non-vetoed
 * targets — null when there is nothing to measure. Computed once where the
 * run list is projected so the renderer never has to load full runs for it.
 */
export function runAbsorption(targets: PropagationTarget[]): number | null {
  const xs = targets
    .filter(
      (t) =>
        t.stage2?.verdict !== "vetoed" &&
        t.tracked &&
        (t.pricing.status === "open" ||
          t.pricing.status === "partial" ||
          t.pricing.status === "priced" ||
          t.pricing.status === "stale"),
    )
    .map(targetProgress);
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * How far a target has travelled toward the move that was actually called,
 * as a share of it — the engine's own arithmetic, signed and unclamped.
 *
 * Positive means it is going the way the call said and 1 is the whole of the
 * called move (past 1 it has overshot). Negative means it is going the other
 * way. 0 is a name nothing has happened to yet. `null` is a name there is
 * nothing to measure with — no basis, no reference close.
 *
 * `expected_pct` is a magnitude and the direction sits beside it, which is
 * why the sign has to be reassembled here rather than read off one field.
 */
/**
 * The same share, measured against the price on screen right now.
 *
 * Everything needed is already to hand and none of it moves: the reference
 * close is the price when the call was made, and the called move is fixed for
 * the life of the run. Only the last price changes — and the card is already
 * streaming that for every name in the list. So the progress can simply be
 * recomputed on each quote instead of waiting for the engine's next sweep,
 * which is what left a days-old ratio sitting beside a live price.
 *
 * One difference worth knowing: this is the RAW move. The engine's own figure
 * subtracts the market's contribution (beta times the benchmark) so that a
 * name carried up by a rising tape does not read as the event being absorbed.
 * That adjustment needs a benchmark quote and a beta, neither of which is on
 * the target, so it cannot be done here. On a strong tape this reads a little
 * high; between sweeps it is the honest answer to "where is it now".
 */
export function livePricedIn(t: PropagationTarget, livePrice: number | null | undefined): number | null {
  const expected = t.pricing.expected_pct;
  if (expected == null || !Number.isFinite(expected) || expected <= 0) return null;
  const base = t.pricing.reference_close;
  if (base == null || !Number.isFinite(base) || base <= 0) return null;
  if (livePrice == null || !Number.isFinite(livePrice) || livePrice <= 0) return null;
  // A closed window is a closed verdict — the tape moving on afterwards is
  // not the call being absorbed, so the stored figure stands.
  if (t.pricing.status === "stale") return null;

  const realized = livePrice / base - 1;
  const direction = t.stage2?.direction ?? t.transmission.direction;
  const sign = direction === "positive" ? 1 : direction === "negative" ? -1 : 0;
  const travelled = sign === 0 ? Math.abs(realized) : realized * sign;
  return travelled / expected;
}

export function targetPricedIn(t: PropagationTarget): number | null {
  const expected = t.pricing.expected_pct;
  if (expected == null || !Number.isFinite(expected) || expected <= 0) return null;
  const realized = t.pricing.realized_resid_pct ?? t.pricing.realized_raw_pct;
  if (realized == null || !Number.isFinite(realized)) return null;
  const direction = t.stage2?.direction ?? t.transmission.direction;
  const sign = direction === "positive" ? 1 : direction === "negative" ? -1 : 0;
  // Mixed or unclear: the engine compares magnitudes only, so nothing can
  // contradict and the travel is always forward.
  const travelled = sign === 0 ? Math.abs(realized) : realized * sign;
  return travelled / expected;
}

/**
 * A run's signed priced-in share: the mean of its tracked, non-vetoed targets
 * that can be measured at all. `null` when none of them can.
 */
export function runPricedIn(targets: PropagationTarget[]): number | null {
  const xs = targets
    .filter((t) => t.tracked && t.stage2?.verdict !== "vetoed")
    .map(targetPricedIn)
    .filter((x): x is number => x != null);
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
