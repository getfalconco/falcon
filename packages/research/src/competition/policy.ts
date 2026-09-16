/**
 * Frozen paper-competition policy.
 *
 * Quality filters match the product "open signal" card
 * (`isOpenWindowSignal`: conf ≥ 0.55, window open, not low magnitude)
 * plus a non-unclear direction so the book can take the displayed side.
 * No extra model. Hold / sizing match the published backtest defaults.
 */

export const PAPER_COMPETITION_RUN_ID = "falcon-live-paper-60d";

export const PAPER_COMPETITION_POLICY = {
  version: "paper-60d-v1",
  startingCashUsd: 10_000,
  durationDays: 60,
  minConfidence: 0.55,
  windowOpenOnly: true,
  excludeLowMagnitude: true,
  /** Follow the signal's displayed direction (paper short if negative). */
  longOnly: false,
  holdWeekdays: 5,
  positionFraction: 0.1,
  maxConcurrentPositions: 10,
  /** Same freshness window as the user-facing last-24h open-signal list. */
  maxSignalAgeHours: 24,
  fill: "last_extended_or_regular_quote",
  benchmark: "SPY",
} as const;

export type PaperCompetitionPolicy = typeof PAPER_COMPETITION_POLICY;

export type SkipReason =
  | "run_inactive"
  | "generated_before_lookback"
  | "stale_for_ui_window"
  | "below_min_confidence"
  | "window_closed"
  | "low_magnitude"
  | "unclear_direction"
  | "long_only_skip_short"
  | "duplicate_ticker"
  | "max_positions"
  | "insufficient_cash"
  | "missing_price";

export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  run_inactive: "Run is not active",
  generated_before_lookback: "Signal predates the 24h lookback around run start",
  stale_for_ui_window: "Older than 24h — would not show as an open window to users",
  below_min_confidence: "path_confidence below 0.55",
  window_closed: "Already priced in (window closed)",
  low_magnitude: "Magnitude is low — hidden from open-signal cards",
  unclear_direction: "Direction unclear — no side to take",
  long_only_skip_short: "Policy is long-only",
  duplicate_ticker: "Already holding this ticker",
  max_positions: "Max concurrent positions reached",
  insufficient_cash: "Not enough cash for a 10% sleeve (no leverage)",
  missing_price: "No live quote at decision time",
};

/** Next calendar moment after `from` that is `n` weekdays later (UTC). */
export function addWeekdays(from: Date, n: number): Date {
  const d = new Date(from.getTime());
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return d;
}

export function shortMechanismLine(
  reasoning: string,
  eventSummary: string,
  mechanism: string,
  maxLen = 90,
): string {
  const text = (reasoning || eventSummary || mechanism).trim();
  if (!text) return mechanism;
  const first = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  if (first.length <= maxLen) return first;
  return `${first.slice(0, maxLen - 1).trim()}…`;
}

export function competitionHeadline(input: {
  ticker: string;
  direction: string;
  reasoning: string;
  eventSummary: string;
  mechanism: string;
}): string {
  const arrow = input.direction === "positive" ? "↑" : input.direction === "negative" ? "↓" : "→";
  return `${input.ticker} ${arrow} — ${shortMechanismLine(input.reasoning, input.eventSummary, input.mechanism)}`;
}
