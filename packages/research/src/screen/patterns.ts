/**
 * Pattern functions (spec §3) — one pure function per pattern over a series
 * view + the detector state it may read. Each returns present / absent / n_a
 * with a values payload, the qualifying sessions, modifiers and one templated
 * read. Separate from Tracker's detectors by design (§2): different windows,
 * different thresholds, no firing state — nothing here is reused from, or
 * feeds, the pipeline.
 */

import { nyYmd } from "../tracker/calendar.js";
import type { ScreenConfig } from "./config.js";
import { fill, fmtPct, fmtRatio, fmtSignedPct, fmtUsd, fmtZ, round4 } from "./templates.js";
import type {
  ScreenEvaluation,
  ScreenInsiderClusterInput,
  ScreenModifier,
  ScreenNewsBurstInput,
  ScreenPattern,
  ScreenSeriesView,
  ScreenValue,
} from "./types.js";

export type PatternContext = {
  /** Completed trading session the scan describes. */
  session: string;
  config: ScreenConfig;
  /** Tracker's `thresholds.lowR2Fallback` — the shared r² floor (§3.3). */
  r2Floor: number;
  news_burst: ScreenNewsBurstInput | null;
  insider_cluster: ScreenInsiderClusterInput | null;
};

function base(view: ScreenSeriesView, pattern: ScreenPattern, ctx: PatternContext): ScreenEvaluation {
  return {
    ticker: view.ticker,
    pattern,
    session: ctx.session,
    status: "absent",
    na_reason: null,
    values: {},
    modifiers: [],
    qualifying_sessions: [],
    sessions_view: view.sessions,
    read: null,
  };
}

function na(view: ScreenSeriesView, pattern: ScreenPattern, ctx: PatternContext, reason: string, values: Record<string, ScreenValue> = {}): ScreenEvaluation {
  return { ...base(view, pattern, ctx), status: "n_a", na_reason: reason, values };
}

function naHistory(view: ScreenSeriesView, pattern: ScreenPattern, ctx: PatternContext, needed: number): ScreenEvaluation {
  return na(view, pattern, ctx, fill(ctx.config.templates, "na_history", { sessions: view.history_sessions, needed }), { history_sessions: view.history_sessions });
}

/** Trading-day ymd of an ISO instant (null-safe). */
function ymdOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : nyYmd(d);
}

/** §3.1 gate: a news_burst active now, or fired on any session inside [windowStart, session]. */
export function newsBurstInWindow(input: ScreenNewsBurstInput, windowStart: string, session: string): boolean {
  if (input.active) return true;
  const last = ymdOf(input.last_fired_at);
  if (last != null && last >= windowStart && last <= session) return true;
  return input.fired_days.some((d) => d >= windowStart && d <= session);
}

// ---------------------------------------------------------------------------
// 3.1 quiet_accumulation — volume without price, sustained
// ---------------------------------------------------------------------------

export function evaluateQuietAccumulation(view: ScreenSeriesView, ctx: PatternContext): ScreenEvaluation {
  const pattern: ScreenPattern = "quiet_accumulation";
  const { windows: w, thresholds, templates } = ctx.config;
  const t = thresholds.quietAccumulation;
  const needed = w.volumeBaselineSessions + w.sessions;
  if (view.sessions.length < w.sessions || view.sessions.some((s) => s.volume_ratio == null)) return naHistory(view, pattern, ctx, needed);
  if (view.momentum_5d == null || view.daily_vol == null) return naHistory(view, pattern, ctx, Math.max(needed, w.volShortSessions + 1));
  if (!ctx.news_burst) return na(view, pattern, ctx, fill(templates, "na_detectors"));
  if (view.daily_vol <= 0) return na(view, pattern, ctx, "daily vol is zero — momentum not scalable");

  const qualifying = view.sessions.filter((s) => (s.volume_ratio ?? 0) >= t.volumeRatioMin);
  const momentumZ = Math.abs(view.momentum_5d) / (view.daily_vol * Math.sqrt(w.momentumShort));
  const windowStart = view.sessions[0].d;
  const burst = newsBurstInWindow(ctx.news_burst, windowStart, ctx.session);
  const avgRatio = qualifying.length > 0 ? qualifying.reduce((a, s) => a + (s.volume_ratio ?? 0), 0) / qualifying.length : null;
  const maxRatio = Math.max(...view.sessions.map((s) => s.volume_ratio ?? 0));

  const values: Record<string, ScreenValue> = {
    sessions_qualifying: qualifying.length,
    sessions_window: w.sessions,
    avg_volume_ratio: round4(avgRatio),
    max_volume_ratio: round4(maxRatio),
    volume_ratio_min: t.volumeRatioMin,
    momentum_5d: round4(view.momentum_5d),
    momentum_5d_z: round4(momentumZ),
    daily_vol: round4(view.daily_vol),
    news_burst_in_window: burst,
    window_start: windowStart,
  };
  const present = qualifying.length >= t.minQualifyingSessions && momentumZ < t.momentumZMax && !burst;
  const evaluation: ScreenEvaluation = { ...base(view, pattern, ctx), values, qualifying_sessions: qualifying.map((s) => s.d) };
  if (!present) return evaluation;
  return {
    ...evaluation,
    status: "present",
    read: fill(templates, "quiet_accumulation", {
      n: qualifying.length,
      window: w.sessions,
      ratio: fmtRatio(avgRatio ?? 0, 1),
      baseline: w.volumeBaselineSessions,
      z: fmtRatio(momentumZ, 1),
    }),
  };
}

// ---------------------------------------------------------------------------
// 3.2 compression — the coiled range (direction-symmetric)
// ---------------------------------------------------------------------------

export function evaluateCompression(view: ScreenSeriesView, ctx: PatternContext): ScreenEvaluation {
  const pattern: ScreenPattern = "compression";
  const { windows: w, thresholds, templates } = ctx.config;
  const t = thresholds.compression;
  if (view.vol_regime == null || view.daily_vol == null) return naHistory(view, pattern, ctx, w.volLongSessions + 1);
  if (view.range_10s == null) return naHistory(view, pattern, ctx, w.compressionRangeSessions);
  if (view.daily_vol <= 0) return na(view, pattern, ctx, "daily vol is zero — range not scalable");

  const implied = view.daily_vol * Math.sqrt(w.compressionRangeSessions);
  const bound = t.rangeVolMultiple * implied;
  const rangeRatio = view.range_10s / implied;
  const modifiers: ScreenModifier[] = [];
  if (view.pct_from_52w_high != null && Math.abs(view.pct_from_52w_high) <= t.near52wPct) modifiers.push("near_52w_high");
  if (view.pct_from_52w_low != null && Math.abs(view.pct_from_52w_low) <= t.near52wPct) modifiers.push("near_52w_low");

  const values: Record<string, ScreenValue> = {
    vol_regime: round4(view.vol_regime),
    vol_regime_max: t.volRegimeMax,
    range: round4(view.range_10s),
    range_window: w.compressionRangeSessions,
    range_implied: round4(implied),
    range_bound: round4(bound),
    range_ratio: round4(rangeRatio),
    range_ratio_max: t.rangeVolMultiple,
    daily_vol: round4(view.daily_vol),
    pct_from_52w_high: round4(view.pct_from_52w_high),
    pct_from_52w_low: round4(view.pct_from_52w_low),
  };
  const present = view.vol_regime <= t.volRegimeMax && rangeRatio <= t.rangeVolMultiple;
  const evaluation: ScreenEvaluation = { ...base(view, pattern, ctx), values, modifiers: present ? modifiers : [], qualifying_sessions: present ? view.sessions.map((s) => s.d) : [] };
  if (!present) return evaluation;
  return {
    ...evaluation,
    status: "present",
    read: fill(templates, "compression", {
      regime: fmtRatio(view.vol_regime),
      window: w.compressionRangeSessions,
      range: fmtPct(view.range_10s),
      bound: fmtPct(bound),
    }),
  };
}

// ---------------------------------------------------------------------------
// 3.3 independent_tape — repeated same-sign residuals
// ---------------------------------------------------------------------------

export function evaluateIndependentTape(view: ScreenSeriesView, ctx: PatternContext): ScreenEvaluation {
  const pattern: ScreenPattern = "independent_tape";
  const { windows: w, thresholds, templates } = ctx.config;
  const t = thresholds.independentTape;
  if (view.history_sessions === 0) return na(view, pattern, ctx, fill(templates, "na_benchmark"));
  if (view.r2 == null || view.sessions.length < w.sessions || view.sessions.some((s) => s.residual_z == null || s.residual_move == null)) {
    return naHistory(view, pattern, ctx, w.betaSessions + w.sessions);
  }
  if (view.daily_vol == null) return naHistory(view, pattern, ctx, w.volShortSessions + 1);
  if (view.r2 < ctx.r2Floor) {
    return na(view, pattern, ctx, fill(templates, "na_r2", { r2: fmtRatio(view.r2), floor: fmtRatio(ctx.r2Floor) }), { r2: round4(view.r2), r2_floor: ctx.r2Floor });
  }
  if (view.daily_vol <= 0) return na(view, pattern, ctx, "daily vol is zero — residuals not scalable");

  const ups = view.sessions.filter((s) => (s.residual_z ?? 0) >= t.residualZMin);
  const downs = view.sessions.filter((s) => (s.residual_z ?? 0) <= -t.residualZMin);
  const direction = ups.length >= downs.length ? "up" : "down";
  const qualifying = direction === "up" ? ups : downs;
  const net = view.sessions.reduce((a, s) => a + (s.residual_move ?? 0), 0);
  const implied = view.daily_vol * Math.sqrt(w.sessions);
  const netZ = Math.abs(net) / implied;
  // The net residual must carry the qualifying sign — "same direction, market-
  // independent" is not true when three +1σ days are swamped by two −3σ days.
  const signAgrees = direction === "up" ? net > 0 : net < 0;

  const values: Record<string, ScreenValue> = {
    sessions_qualifying: qualifying.length,
    sessions_window: w.sessions,
    direction,
    residual_z_min: t.residualZMin,
    net_residual: round4(net),
    net_residual_implied: round4(implied),
    net_residual_z: round4(netZ),
    net_residual_z_min: t.netResidualVolMultiple,
    r2: round4(view.r2),
    beta: round4(view.beta),
    daily_vol: round4(view.daily_vol),
    residual_z_max_abs: round4(Math.max(...view.sessions.map((s) => Math.abs(s.residual_z ?? 0)))),
  };
  const present = qualifying.length >= t.minQualifyingSessions && netZ >= t.netResidualVolMultiple && signAgrees;
  const evaluation: ScreenEvaluation = { ...base(view, pattern, ctx), values, qualifying_sessions: qualifying.map((s) => s.d) };
  if (!present) return evaluation;
  return {
    ...evaluation,
    status: "present",
    read: fill(templates, "independent_tape", {
      n: qualifying.length,
      window: w.sessions,
      dir: fill(templates, direction === "up" ? "independent_tape_dir_up" : "independent_tape_dir_down"),
      zmin: fmtRatio(t.residualZMin, 1),
      net: fmtSignedPct(net),
      implied: fmtPct(implied),
    }),
  };
}

// ---------------------------------------------------------------------------
// 3.4 insider_divergence — flow against tape
// ---------------------------------------------------------------------------

export function evaluateInsiderDivergence(view: ScreenSeriesView, ctx: PatternContext): ScreenEvaluation {
  const pattern: ScreenPattern = "insider_divergence";
  const { windows: w, thresholds, templates } = ctx.config;
  const t = thresholds.insiderDivergence;
  if (view.momentum_20d == null || view.daily_vol == null) return naHistory(view, pattern, ctx, Math.max(w.momentumLong + 1, w.volShortSessions + 1));
  if (!ctx.insider_cluster) return na(view, pattern, ctx, fill(templates, "na_detectors"));
  if (view.daily_vol <= 0) return na(view, pattern, ctx, "daily vol is zero — momentum not scalable");
  const cluster = ctx.insider_cluster;
  const momentumZ = Math.abs(view.momentum_20d) / (view.daily_vol * Math.sqrt(w.momentumLong));
  const values: Record<string, ScreenValue> = {
    cluster_active: cluster.active,
    direction: cluster.direction,
    insider_count: cluster.insider_count,
    window_business_days: cluster.window_business_days,
    total_notional: cluster.total_notional,
    cluster_last_fired_at: cluster.last_fired_at,
    momentum_20d: round4(view.momentum_20d),
    momentum_20d_z: round4(momentumZ),
    momentum_20d_z_min: t.momentumZMin,
    daily_vol: round4(view.daily_vol),
  };
  if (!cluster.active) return { ...base(view, pattern, ctx), values };
  if (cluster.direction == null) return na(view, pattern, ctx, fill(templates, "na_cluster_direction"), values);

  const tapeSign = Math.sign(view.momentum_20d);
  const against = cluster.direction === "buy" ? tapeSign < 0 : tapeSign > 0;
  const present = against && momentumZ >= t.momentumZMin;
  const evaluation: ScreenEvaluation = { ...base(view, pattern, ctx), values, qualifying_sessions: present ? view.sessions.map((s) => s.d) : [] };
  if (!present) return evaluation;
  return {
    ...evaluation,
    status: "present",
    read: fill(templates, cluster.direction === "buy" ? "insider_divergence_buy" : "insider_divergence_sell", {
      count: cluster.insider_count ?? "?",
      window: cluster.window_business_days ?? "?",
      notional: cluster.total_notional != null ? fmtUsd(cluster.total_notional) : "notional unavailable",
      m20: fmtSignedPct(view.momentum_20d),
      z: fmtZ(momentumZ, 1),
    }),
  };
}

export const PATTERN_EVALUATORS: Record<ScreenPattern, (view: ScreenSeriesView, ctx: PatternContext) => ScreenEvaluation> = {
  quiet_accumulation: evaluateQuietAccumulation,
  compression: evaluateCompression,
  independent_tape: evaluateIndependentTape,
  insider_divergence: evaluateInsiderDivergence,
};

export function evaluatePattern(pattern: ScreenPattern, view: ScreenSeriesView, ctx: PatternContext): ScreenEvaluation {
  return PATTERN_EVALUATORS[pattern](view, ctx);
}

/** Modifier display text (panel + read suffix). */
export function modifierText(config: ScreenConfig, modifier: ScreenModifier, view: { pct_from_52w_high: number | null; pct_from_52w_low: number | null }): string {
  if (modifier === "near_52w_high") return fill(config.templates, "modifier_near_52w_high", { pct: fmtPct(view.pct_from_52w_high ?? 0) });
  return fill(config.templates, "modifier_near_52w_low", { pct: fmtPct(view.pct_from_52w_low ?? 0) });
}
