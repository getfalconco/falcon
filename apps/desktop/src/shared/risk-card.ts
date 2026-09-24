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

/**
 * One colour per band, beside the labels so a surface that prints a band takes
 * both from the same place. The risk card and the Shift+R panel each carry
 * their own copy of these four values; a third copy in the handover briefing
 * would be one more that can drift when a band is recoloured.
 */
export const RISK_BAND_COLOR: Record<RiskBand, string> = {
  low: "#16A34A",
  moderate: "#CA8A04",
  elevated: "#EA580C",
  high: "#DC2626",
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
