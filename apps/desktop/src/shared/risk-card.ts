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
 *
 * And one read per name: while a Positions row is hovered the card shows that
 * name's entry in the snapshot's `positions` (the engine's per-position
 * metrics, computed in the same recompute), through `riskHoverView`. Still
 * nothing recomputed here: the lines are the snapshot's figures, formatted.
 */

import { accountWeight, formatWeightPct, type AccountWeights } from "./portfolio-weights";
import type { RiskBand, RiskLatest, RiskSnapshot } from "./risk-types";

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

/**
 * One factual line of the hovered position's read. Values arrive formatted
 * (numbers only); the card supplies the words and formats the date in the
 * reader's locale.
 */
export type RiskHoverLine =
  | { kind: "weight"; value: string }
  | { kind: "beta"; value: string }
  | { kind: "volatility"; value: string; portfolio: string | null }
  | { kind: "earnings"; due_at: string }
  | { kind: "correlation"; ticker: string; value: string };

export type RiskHoverView = {
  ticker: string;
  /** The name's share of the portfolio risk as printed ("38%", "-4.2%"), or null. */
  share: string | null;
  /** The same share for the arc, clamped to 0..1; null with no share. */
  shareFrac: number | null;
  /** At most `RISK_HOVER_MAX_LINES`, in a fixed order; only the lines the data has. */
  lines: RiskHoverLine[];
};

export const RISK_HOVER_MAX_LINES = 4;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A share of risk the way the card prints it: whole percent, a tenth under 10%. */
export function formatRiskShare(share: number): string {
  const pct = share * 100;
  const digits = Math.abs(pct) < 10 ? 1 : 0;
  const text = pct.toFixed(digits);
  return `${text === "-0.0" || text === "-0" ? text.slice(1) : text}%`;
}

/**
 * What the card shows while a Positions row is hovered: that name's own read
 * from the snapshot's per-position metrics (risk engine positions.ts). Null
 * when nothing is hovered, there is no scored snapshot, or the name is neither
 * held now nor in the snapshot: the card stays on the portfolio.
 *
 * The weight is the one the Positions card prints beside the row (same
 * account, same prints, same definition), so the two never disagree; the
 * snapshot's own account weight is the fallback when the row is not in the
 * live book. A snapshot from before per-position metrics existed carries only
 * that, so the card shows the weight line alone. Nothing else is filled in.
 */
export function riskHoverView(
  snapshot: RiskSnapshot | null | undefined,
  hovered: string | null | undefined,
  weights: AccountWeights,
  now: number = Date.now(),
): RiskHoverView | null {
  if (!hovered || !snapshot || snapshot.empty || snapshot.score == null) return null;
  const ticker = hovered.trim().toUpperCase();
  if (!ticker) return null;
  const row = weights.positions.find((p) => p.ticker === ticker);
  const metrics = Array.isArray(snapshot.positions) ? snapshot.positions.find((p) => p?.ticker === ticker) : undefined;
  if (!row && !metrics) return null;

  const lines: RiskHoverLine[] = [];
  const liveWeight = row ? accountWeight(row.market_value, weights.total) : null;
  const weight = liveWeight ?? (finite(metrics?.account_weight) ? metrics.account_weight : null);
  const weightPct = formatWeightPct(weight == null ? null : Math.abs(weight));
  if (weightPct) lines.push({ kind: "weight", value: weightPct });
  if (finite(metrics?.beta)) lines.push({ kind: "beta", value: metrics.beta.toFixed(2) });
  if (finite(metrics?.daily_vol_pct)) {
    const port = snapshot.components?.volatility?.port_vol_daily_pct;
    lines.push({ kind: "volatility", value: `${metrics.daily_vol_pct.toFixed(1)}%`, portfolio: finite(port) ? `${port.toFixed(1)}%` : null });
  }
  const due = metrics?.earnings?.due_at;
  const dueMs = typeof due === "string" ? Date.parse(due) : NaN;
  // A print already past since the recompute is no longer upcoming.
  if (typeof due === "string" && Number.isFinite(dueMs) && dueMs >= now - 12 * 3600_000) lines.push({ kind: "earnings", due_at: due });
  const corr = metrics?.correlation;
  if (corr && finite(corr.value) && typeof corr.ticker === "string" && corr.ticker) {
    lines.push({ kind: "correlation", ticker: corr.ticker, value: corr.value.toFixed(2) });
  }

  const share = finite(metrics?.risk_share) ? metrics.risk_share : null;
  return {
    ticker,
    share: share == null ? null : formatRiskShare(share),
    shareFrac: share == null ? null : Math.max(0, Math.min(1, share)),
    lines: lines.slice(0, RISK_HOVER_MAX_LINES),
  };
}
