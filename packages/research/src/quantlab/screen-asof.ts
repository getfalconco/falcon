/**
 * Screen patterns evaluated as of a past session (§3).
 *
 * Screen needs no refactor: `session` is already threaded through
 * `PatternContext`, `buildSeriesView` and `evaluateTicker`, and `completedBars`
 * is a documented no-lookahead cut. This module only supplies the inputs from
 * the stored point-in-time series and calls Screen's own evaluators unchanged,
 * so a change to Screen's math reaches the backtester automatically and the two
 * can never disagree.
 *
 * Two detector inputs cannot be rebuilt for a multi-year window and are handled
 * explicitly rather than quietly:
 *
 *  - `news_burst` — news counts are ~40 sessions deep and the provider's free
 *    tier reaches ~12 months, so burst state is gone. It is passed as
 *    INACTIVE, matching `screen-replay.ts`. That is the permissive direction:
 *    the veto never fires, so more signals appear here than would appear live.
 *    A strategy that still cannot beat its base rate under a disabled veto is
 *    convincingly dead; one that passes is provisional.
 *  - `insider_cluster` — Tracker prunes transactions to a 10-business-day
 *    window. There is no honest substitute, so it is passed as null, which
 *    makes `insider_divergence` evaluate to n_a rather than to a guess.
 *
 * Both are reported on every backtest as approximations.
 */

import { evaluatePattern, type PatternContext } from "../screen/patterns.js";
import type { ScreenConfig, ScreenWindows } from "../screen/config.js";
import type {
  ScreenEvaluation,
  ScreenInsiderClusterInput,
  ScreenNewsBurstInput,
  ScreenPattern,
  ScreenSeriesView,
  ScreenSessionView,
} from "../screen/types.js";
import type { QuantSeries, QuantSnapshot } from "./types.js";

/** The approximations a backtest is running under, carried into the report. */
export type ScreenAsOfApproximations = {
  news_burst: "inactive";
  insider_cluster: "unavailable";
};

export const SCREEN_ASOF_APPROXIMATIONS: ScreenAsOfApproximations = {
  news_burst: "inactive",
  insider_cluster: "unavailable",
};

/** A burst input that never fires — the historical substitute, stated not implied. */
export function inactiveBurst(): ScreenNewsBurstInput {
  return { active: false, last_fired_at: null, fired_days: [] };
}

function toSessionView(snap: QuantSnapshot): ScreenSessionView {
  return {
    d: snap.d,
    close: snap.close,
    volume: snap.volume,
    ret: snap.ret,
    bench_ret: snap.bench_ret,
    volume_ratio: snap.volume_ratio,
    residual_move: snap.residual_move,
    residual_z: snap.residual_z,
  };
}

/**
 * Rebuilds Screen's series view from stored snapshots.
 *
 * Every field is read straight off the snapshot rather than recomputed — the
 * snapshots ARE `buildSeriesView` output (see series.ts), so this is a
 * projection, not a second implementation.
 */
export function viewAsOf(series: QuantSeries, session: string, windows: ScreenWindows): ScreenSeriesView | null {
  let at = -1;
  for (let i = series.snapshots.length - 1; i >= 0; i--) {
    if (series.snapshots[i].d === session) {
      at = i;
      break;
    }
    if (series.snapshots[i].d < session) break;
  }
  if (at < 0) return null;
  const snap = series.snapshots[at];
  const first = Math.max(0, at + 1 - windows.sessions);
  return {
    ticker: series.ticker,
    as_of: snap.d,
    history_sessions: snap.history_sessions,
    sessions: series.snapshots.slice(first, at + 1).map(toSessionView),
    beta: snap.beta,
    r2: snap.r2,
    daily_vol: snap.daily_vol,
    vol_regime: snap.vol_regime,
    momentum_5d: snap.momentum_5d,
    momentum_20d: snap.momentum_20d,
    range_10s: snap.range_10s,
    pct_from_52w_high: snap.pct_from_52w_high,
    pct_from_52w_low: snap.pct_from_52w_low,
  };
}

export type EvaluateAsOfOptions = {
  /** Overrides for tests / a future backfill that restores these detectors. */
  newsBurst?: ScreenNewsBurstInput | null;
  insiderCluster?: ScreenInsiderClusterInput | null;
};

/** One pattern on one ticker as of one session. Null when the ticker did not trade it. */
export function evaluatePatternAsOf(
  pattern: ScreenPattern,
  series: QuantSeries,
  session: string,
  config: ScreenConfig,
  r2Floor: number,
  options: EvaluateAsOfOptions = {},
): ScreenEvaluation | null {
  const view = viewAsOf(series, session, config.windows);
  if (!view) return null;
  const ctx: PatternContext = {
    session,
    config,
    r2Floor,
    news_burst: options.newsBurst !== undefined ? options.newsBurst : inactiveBurst(),
    insider_cluster: options.insiderCluster !== undefined ? options.insiderCluster : null,
  };
  return evaluatePattern(pattern, view, ctx);
}

/** Every requested pattern as of one session. */
export function evaluatePatternsAsOf(
  patterns: readonly ScreenPattern[],
  series: QuantSeries,
  session: string,
  config: ScreenConfig,
  r2Floor: number,
  options: EvaluateAsOfOptions = {},
): ScreenEvaluation[] {
  const out: ScreenEvaluation[] = [];
  for (const pattern of patterns) {
    const evaluation = evaluatePatternAsOf(pattern, series, session, config, r2Floor, options);
    if (evaluation) out.push(evaluation);
  }
  return out;
}

/**
 * How many consecutive sessions the pattern has held ending at `session`,
 * walking backwards. 1 means this is its first — Screen's `new` state.
 *
 * Screen's own lifecycle is a persisted reducer, but its `new`/`continuing`
 * distinction is exactly "was the condition also true on the previous scanned
 * session", so recomputing it from the series gives the same answer without
 * carrying a store through the backtest.
 */
export function consecutiveSessions(
  pattern: ScreenPattern,
  series: QuantSeries,
  session: string,
  config: ScreenConfig,
  r2Floor: number,
  maxLookback: number,
  options: EvaluateAsOfOptions = {},
): number {
  let at = series.snapshots.findIndex((s) => s.d === session);
  if (at < 0) return 0;
  let count = 0;
  while (at >= 0 && count < maxLookback) {
    const evaluation = evaluatePatternAsOf(pattern, series, series.snapshots[at].d, config, r2Floor, options);
    if (evaluation?.status !== "present") break;
    count++;
    at--;
  }
  return count;
}
