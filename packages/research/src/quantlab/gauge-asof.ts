/**
 * Gauge setups evaluated as of a past session (§3).
 *
 * Gauge's eleven recognisers are already point-in-time: they are pure, read no
 * clock, and their own tests hand-construct `GaugeInputs` and bypass gathering
 * entirely. What blocks a historical readout is one level up — Tracker's
 * `TickerState.quant` is a single latest snapshot, overwritten every close, so
 * `gather.ts` has nothing to build a past `GaugeInputs` from.
 *
 * So this module reconstructs `GaugeInputs` from the stored point-in-time
 * series and calls `recognizeSetup` UNCHANGED. Nothing in `gauge/` is edited,
 * which is what makes behaviour preservation structural rather than something
 * a test has to keep watching.
 *
 * What is faithfully reconstructed: every field `buildSetupView` reads —
 * vol_regime, volume_ratio, daily_vol, momentum 5d/20d, r², beta,
 * earnings_rhythm, and earnings proximity.
 *
 * What is not, and why:
 *  - `detectors` is null. It feeds only check 7 (conflict), which no setup
 *    recogniser reads, so a null costs the setup layer nothing.
 *  - `news.burst_active` is false — burst state cannot be rebuilt (see
 *    screen-asof.ts). This gates `move_spent` and `quiet_drift`, so those two
 *    setups run permissively and are flagged.
 *  - `incidents` is empty: Base incidents are a live artifact and, like
 *    detectors, reach only check 7.
 */

import { recognizeSetup, type SetupResult } from "../gauge/setups.js";
import type { GaugeConfig } from "../gauge/config.js";
import type {
  GaugeInputs,
  GaugeQuantInput,
  GaugeScreenFinding,
  GaugeScreenPattern,
} from "../gauge/types.js";
import type { ScreenConfig } from "../screen/config.js";
import type { ScreenEvaluation } from "../screen/types.js";
import type { TradingCalendar } from "./calendar.js";
import { earningsRhythmAsOf, nextEarningsAsOf, type FilingEvent } from "./filings.js";
import { consecutiveSessions, evaluatePatternsAsOf, type EvaluateAsOfOptions } from "./screen-asof.js";
import { snapshotAt } from "./series.js";
import type { QuantSeries, QuantSnapshot } from "./types.js";

/** Setups whose gates read a detector that cannot be rebuilt historically. */
export const PERMISSIVE_SETUPS = ["move_spent", "quiet_drift"] as const;

const SCREEN_PATTERNS: readonly GaugeScreenPattern[] = [
  "quiet_accumulation",
  "compression",
  "independent_tape",
  "insider_divergence",
];

function quantFromSnapshot(snap: QuantSnapshot, earningsRhythm: number | null): GaugeQuantInput {
  const moveZ =
    snap.ret != null && snap.daily_vol != null && snap.daily_vol > 0 ? snap.ret / snap.daily_vol : null;
  return {
    beta: snap.beta,
    r2: snap.r2,
    daily_vol: snap.daily_vol,
    vol_regime: snap.vol_regime,
    momentum_5d: snap.momentum_5d,
    momentum_20d: snap.momentum_20d,
    // Not carried in the series and read by no setup recogniser; null is the
    // honest value rather than a number nothing consumes.
    momentum_60d: null,
    volume_ratio: snap.volume_ratio,
    volume_ratio_partial: false,
    pct_from_52w_high: snap.pct_from_52w_high,
    pct_from_52w_low: snap.pct_from_52w_low,
    earnings_rhythm: earningsRhythm,
    move_zscore: moveZ,
    residual_zscore: snap.residual_z,
    as_of: snap.d,
  };
}

/** Screen evaluations projected into the shape Gauge's setup layer reads. */
export function screenFindingsAsOf(
  series: QuantSeries,
  session: string,
  screenConfig: ScreenConfig,
  r2Floor: number,
  options: EvaluateAsOfOptions = {},
): GaugeScreenFinding[] {
  const evaluations = evaluatePatternsAsOf(SCREEN_PATTERNS, series, session, screenConfig, r2Floor, options);
  const out: GaugeScreenFinding[] = [];
  for (const evaluation of evaluations) {
    if (evaluation.status !== "present") continue;
    const pattern = evaluation.pattern as GaugeScreenPattern;
    const held = consecutiveSessions(pattern, series, session, screenConfig, r2Floor, 90, options);
    out.push({
      pattern,
      state: held <= 1 ? "new" : "continuing",
      day_count: Math.max(1, held),
      direction: directionOf(evaluation),
      read: evaluation.read ?? "",
      values: evaluation.values as GaugeScreenFinding["values"],
    });
  }
  return out;
}

function directionOf(evaluation: ScreenEvaluation): GaugeScreenFinding["direction"] {
  const raw = evaluation.values?.direction;
  if (raw === "up" || raw === "down" || raw === "buy" || raw === "sell") return raw;
  return null;
}

export type GaugeAsOfDeps = {
  series: QuantSeries;
  session: string;
  calendar: TradingCalendar;
  gaugeConfig: GaugeConfig;
  screenConfig: ScreenConfig;
  r2Floor: number;
  /** Full item-2.02 history for the ticker, oldest first. */
  earnings: FilingEvent[];
  earningsKnowledgeHorizonSessions: number;
  /** True when a gap/unexplained/earnings event landed in the news lookback. */
  eventInWindow?: boolean;
  screenOptions?: EvaluateAsOfOptions;
};

/** Rebuilds `GaugeInputs` for one ticker as of one session. */
export function gaugeInputsAsOf(deps: GaugeAsOfDeps): GaugeInputs | null {
  const snap = snapshotAt(deps.series, deps.session);
  if (!snap) return null;

  const returnBySession = new Map<string, number | null>();
  for (const s of deps.series.snapshots) {
    if (s.d > deps.session) break;
    returnBySession.set(s.d, s.ret);
  }
  const rhythm = earningsRhythmAsOf(deps.session, deps.earnings, returnBySession, deps.calendar);
  const next = nextEarningsAsOf(deps.session, deps.earnings, deps.calendar, deps.earningsKnowledgeHorizonSessions);

  return {
    ticker: deps.series.ticker,
    tracked: true,
    // Gauge stamps its readout with this; the session's close is the instant
    // the state describes.
    now: `${deps.session}T20:00:00.000Z`,
    quant: quantFromSnapshot(snap, rhythm),
    detectors: null,
    next_earnings: next
      ? { due_at: `${next.due_session}T20:00:00.000Z`, sessions_until: next.sessions_until, fiscal_period: null }
      : null,
    incidents: [],
    r2_floor: deps.r2Floor,
    history_sessions: snap.history_sessions,
    screen: screenFindingsAsOf(deps.series, deps.session, deps.screenConfig, deps.r2Floor, deps.screenOptions),
    screen_available: true,
    news: {
      burst_active: false,
      articles: 0,
      event_in_window: deps.eventInWindow ?? false,
      lookback_sessions: 5,
    },
  };
}

/** The recognised setup as of a session, or null when the ticker did not trade it. */
export function setupAsOf(deps: GaugeAsOfDeps): SetupResult | null {
  const inputs = gaugeInputsAsOf(deps);
  if (!inputs) return null;
  // Standalone mode: a backtest has no live thesis to contradict, so context is
  // null and `contradicted_setup` never appears.
  return recognizeSetup(inputs, deps.gaugeConfig, null);
}
