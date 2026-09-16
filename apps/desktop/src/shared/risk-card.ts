/**
 * §8 dashboard card contract — the only thing the RISK SCORE card is allowed
 * to know about the Risk Engine. It reads the latest snapshot's `score`,
 * `band`, `driver.sentence`, `computed_at`, `empty`; it never recomputes and
 * never reaches into component internals. Behind `riskCardEnabled`.
 */

import type { RiskBand, RiskLatest } from "./risk-types";

export type RiskCardModel =
  | { kind: "hidden" }
  | { kind: "empty"; computed_at: string }
  | { kind: "score"; score: number; band: RiskBand; sentence: string; computed_at: string };

/** Band semantics ship with the snapshot; the card labels them, never re-derives them. */
export const RISK_BAND_LABEL: Record<RiskBand, string> = {
  low: "Low",
  moderate: "Moderate",
  elevated: "Elevated",
  high: "High",
};

export function riskCardModel(latest: RiskLatest | null | undefined): RiskCardModel {
  if (!latest || !latest.riskCardEnabled) return { kind: "hidden" };
  const s = latest.snapshot;
  if (!s) return { kind: "hidden" };
  if (s.empty || s.score == null || s.band == null) return { kind: "empty", computed_at: s.computed_at };
  return {
    kind: "score",
    score: Math.max(0, Math.min(100, Math.round(s.score))),
    band: s.band,
    sentence: s.driver?.sentence ?? "",
    computed_at: s.computed_at,
  };
}
