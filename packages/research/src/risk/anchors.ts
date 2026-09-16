/**
 * Piecewise-linear anchor tables (§3). Below the first anchor → first score;
 * above the last → last score; linear interpolation between neighbours.
 * Scores are returned unrounded so the blend keeps full precision; the
 * snapshot rounds at the edge.
 */

import type { AnchorTable } from "./config.js";

export function interpolateAnchors(table: AnchorTable, x: number): number {
  if (table.length === 0) return 0;
  if (!Number.isFinite(x)) return table[0][1];
  const sorted = [...table].sort((a, b) => a[0] - b[0]);
  if (x <= sorted[0][0]) return sorted[0][1];
  const last = sorted[sorted.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < sorted.length; i++) {
    const [x0, y0] = sorted[i - 1];
    const [x1, y1] = sorted[i];
    if (x <= x1) {
      if (x1 === x0) return y1;
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return last[1];
}

/** Clamp to the 0–100 score range and round to the nearest integer. */
export function roundScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
