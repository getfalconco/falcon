/**
 * §8 dashboard card contract — the only thing the RISK SCORE card is allowed
 * to know about the Risk Engine. It reads the latest snapshot's `score`,
 * `band`, `driver.sentence`, `computed_at`, `empty`; it never recomputes the
 * score and never reaches into component internals. Behind `riskCardEnabled`.
 *
 * One exception, for one number: when the driver is concentration the card
 * also learns which name it is about (`concentration`), so it can quote that
 * name's weight from the same account value and the same live prints the
 * Positions card prints it from (`concentrationShare`). The engine's own
 * sentence uses the same definition but is priced at its last recompute, so
 * beside a card on live prints the two would drift apart again by the move
 * since then.
 */

import { accountWeight, formatWeightPct, type AccountWeights } from "./portfolio-weights";
import type { RiskBand, RiskLatest } from "./risk-types";

export type RiskCardModel =
  | { kind: "hidden" }
  | { kind: "empty"; computed_at: string }
  | {
      kind: "score";
      score: number;
      band: RiskBand;
      sentence: string;
      computed_at: string;
      /** The top holding's ticker when the driver is concentration, else null. */
      concentration: string | null;
    };

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
  const top = s.driver?.component === "concentration" ? s.components?.concentration?.top?.[0]?.ticker : null;
  return {
    kind: "score",
    score: Math.max(0, Math.min(100, Math.round(s.score))),
    band: s.band,
    sentence: s.driver?.sentence ?? "",
    computed_at: s.computed_at,
    concentration: typeof top === "string" && top ? top : null,
  };
}

/** Where the card's read of `risk:latest` stands. */
export type RiskReadStatus = "loading" | "ready" | "error";

/**
 * What the card draws. Only `score` prints a number, and it is the snapshot's
 * own; nothing else carries one, so a state without a real snapshot can never
 * show a made-up score.
 *
 *   loading      first read not back yet: the header alone
 *   off          the card flag is off (calibration config)
 *   calculating  positions held, no score for them yet, one is being worked out
 *   empty        nothing held, nothing to score
 *   error        the read or the recompute failed, and there is no score to fall back on
 *   score        the snapshot's score; `pending` while a demo toggle is in
 *                flight, when the card dims it until the new one lands
 */
export type RiskCardView =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "calculating" }
  | { kind: "empty" }
  | { kind: "error" }
  | (Extract<RiskCardModel, { kind: "score" }> & { pending: boolean });

export type RiskCardViewInput = {
  latest: RiskLatest | null | undefined;
  /** The card's own read of `risk:latest`. */
  status: RiskReadStatus;
  /** The account push or the recompute that follows it failed (risk-account-bridge). */
  syncFailed: boolean;
  /** A demo on/off push is in flight. */
  pending: boolean;
  /** Whether the paper account holds anything, long or short. */
  holdsPositions: boolean;
};

export function riskCardView(input: RiskCardViewInput): RiskCardView {
  const { latest, status, syncFailed, pending, holdsPositions } = input;
  if (!latest) {
    if (status === "error") return { kind: "error" };
    if (pending) return { kind: "calculating" };
    return { kind: "loading" };
  }
  if (!latest.riskCardEnabled) return { kind: "off" };
  const model = riskCardModel(latest);
  if (model.kind === "score") return { ...model, pending };
  if (pending) return { kind: "calculating" };
  if (!holdsPositions) return { kind: "empty" };
  // Positions held but no score for them: either the engine has never scored
  // this user (a fresh account, or one whose state was archived when risk
  // went per user), or the last snapshot predates the first position. The
  // bridge pushes the account and asks for a recompute; until it lands the
  // card says it is working on it, and says so plainly if that failed.
  return syncFailed ? { kind: "error" } : { kind: "calculating" };
}

/**
 * Whether the engine's latest snapshot no longer describes the account just
 * pushed, in the one way the card cannot wait out the 60s debounce for: there
 * is no snapshot at all, or it is empty while the account holds something (or
 * the reverse). The bridge asks for a recompute right away when this is true.
 */
export function riskSnapshotStale(latest: RiskLatest | null | undefined, positionCount: number): boolean {
  if (!latest || !latest.riskCardEnabled || latest.demo) return false;
  const s = latest.snapshot;
  if (!s) return true;
  const scored = !s.empty && s.score != null;
  return positionCount > 0 ? !scored : scored;
}

/**
 * What the concentration sentence quotes, worked out from the account as the
 * Positions card values it: `pct` is "24.8%", printed exactly as the
 * Positions card prints the weight (a short by its size), or null when the
 * account is worth nothing or less. Null overall when
 * the driver is not concentration, or the name is no longer held (a snapshot
 * older than the last trade): the card then shows the engine's own sentence.
 */
export function concentrationShare(
  model: RiskCardModel,
  weights: AccountWeights,
): { ticker: string; pct: string | null } | null {
  if (model.kind !== "score" || !model.concentration) return null;
  const ticker = model.concentration.toUpperCase();
  const row = weights.positions.find((p) => p.ticker === ticker);
  if (!row) return null;
  const share = accountWeight(row.market_value, weights.total);
  return { ticker, pct: share == null ? null : formatWeightPct(Math.abs(share)) };
}
