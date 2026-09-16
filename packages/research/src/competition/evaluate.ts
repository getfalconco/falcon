import {
  PAPER_COMPETITION_POLICY,
  type PaperCompetitionPolicy,
  type SkipReason,
} from "./policy.js";

export type CompetitionSignal = {
  id: string;
  terminal_ticker: string;
  direction: string;
  magnitude: string;
  path_confidence: number;
  priced_in_status: string;
  generated_at: string;
};

export type BookState = {
  now: Date;
  runStartedAt: Date;
  runActive: boolean;
  cash: number;
  equity: number;
  openTickers: ReadonlySet<string>;
  openCount: number;
};

export type PolicyDecision =
  | { action: "take" }
  | { action: "skip"; reason: SkipReason };

function hoursBetween(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / 3_600_000;
}

/**
 * Same quality bar as user-facing open signals, then book constraints.
 * `missing_price` is applied by the worker after a quote attempt.
 */
export function evaluateSignal(
  signal: CompetitionSignal,
  book: BookState,
  policy: PaperCompetitionPolicy = PAPER_COMPETITION_POLICY,
): PolicyDecision {
  if (!book.runActive) return { action: "skip", reason: "run_inactive" };

  const generated = new Date(signal.generated_at);
  if (!Number.isFinite(generated.getTime())) {
    return { action: "skip", reason: "stale_for_ui_window" };
  }

  const lookbackStart = new Date(
    book.runStartedAt.getTime() - policy.maxSignalAgeHours * 3_600_000,
  );
  if (generated < lookbackStart) {
    return { action: "skip", reason: "generated_before_lookback" };
  }
  if (hoursBetween(book.now, generated) > policy.maxSignalAgeHours) {
    return { action: "skip", reason: "stale_for_ui_window" };
  }

  if (signal.path_confidence < policy.minConfidence) {
    return { action: "skip", reason: "below_min_confidence" };
  }
  if (policy.windowOpenOnly && signal.priced_in_status !== "not yet reflected") {
    return { action: "skip", reason: "window_closed" };
  }
  if (policy.excludeLowMagnitude && signal.magnitude === "low") {
    return { action: "skip", reason: "low_magnitude" };
  }
  if (signal.direction !== "positive" && signal.direction !== "negative") {
    return { action: "skip", reason: "unclear_direction" };
  }
  if (policy.longOnly && signal.direction !== "positive") {
    return { action: "skip", reason: "long_only_skip_short" };
  }

  const ticker = signal.terminal_ticker.toUpperCase();
  if (book.openTickers.has(ticker)) {
    return { action: "skip", reason: "duplicate_ticker" };
  }
  if (book.openCount >= policy.maxConcurrentPositions) {
    return { action: "skip", reason: "max_positions" };
  }

  const notional = book.equity * policy.positionFraction;
  if (book.cash < notional) {
    return { action: "skip", reason: "insufficient_cash" };
  }

  return { action: "take" };
}
