/**
 * The eight condition checks (spec §3). Each is a pure function of the
 * gathered inputs, the config and the optional context, returning a status,
 * one templated reason line and the raw values it read. Null inputs make a
 * check `n_a` with the gap named (§6) — never pass, never fail.
 */

import type { GaugeConfig } from "./config.js";
import { fill, fmtPct, fmtRatio, fmtSignedPct, fmtZ, plural } from "./templates.js";
import {
  GAUGE_CHECK_NUMBER,
  type GaugeCheck,
  type GaugeCheckKey,
  type GaugeContext,
  type GaugeDirection,
  type GaugeInputs,
  type GaugeStatus,
  type GaugeValue,
} from "./types.js";

type CheckResult = {
  status: GaugeStatus;
  reason: string;
  note?: string | null;
  values?: Record<string, GaugeValue>;
  /** Template key of the reason — resolves the G2 short label (`short_<key>`). */
  tpl?: string;
};

/** G2: the short label for a caution/fail row, from `short_<reason template>`; null when unavailable. */
function shortLabel(config: GaugeConfig, r: CheckResult): string | null {
  if (r.status !== "caution" && r.status !== "fail") return null;
  if (!r.tpl) return null;
  return config.templates[`short_${r.tpl}`] ?? null;
}

function make(key: GaugeCheckKey, config: GaugeConfig, r: CheckResult): GaugeCheck {
  return {
    key,
    number: GAUGE_CHECK_NUMBER[key],
    label: config.labels[key],
    status: r.status,
    reason: r.reason,
    note: r.note ?? null,
    short_label: shortLabel(config, r),
    values: r.values ?? {},
  };
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** n_a reason naming the gap: short history when we know it is, else "not computed". */
function naReason(config: GaugeConfig, inputs: GaugeInputs, what: string): string {
  const sessions = inputs.history_sessions;
  if (inputs.quant == null) return fill(config.templates, "na_not_computed", { what });
  if (finite(sessions) && sessions < 252) return fill(config.templates, "na_history", { what, sessions });
  return fill(config.templates, "na_not_computed", { what });
}

function sign(v: number): -1 | 0 | 1 {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function dirSign(d: GaugeDirection): 1 | -1 {
  return d === "up" ? 1 : -1;
}

function dirWord(d: GaugeDirection): string {
  return d;
}

/** momentum z-score over an n-day window: m / (vol × √n). Null when vol is unusable. */
export function momentumZ(momentum: number, dailyVol: number, days: number): number | null {
  if (!(dailyVol > 0)) return null;
  return momentum / (dailyVol * Math.sqrt(days));
}

// ---------------------------------------------------------------------------
// 1 trend coherence
// ---------------------------------------------------------------------------

export function checkTrend(inputs: GaugeInputs, config: GaugeConfig, context: GaugeContext | null): GaugeCheck {
  const T = config.templates;
  const q = inputs.quant;
  const m5 = q?.momentum_5d ?? null;
  const m20 = q?.momentum_20d ?? null;
  const vol = q?.daily_vol ?? null;
  const values: Record<string, GaugeValue> = { momentum_5d: m5, momentum_20d: m20, daily_vol: vol };

  if (!finite(m5) || !finite(m20)) {
    return make("trend", config, { status: "n_a", reason: naReason(config, inputs, "momentum"), values });
  }

  const standalone = (): CheckResult => {
    const agree = sign(m5) * sign(m20) >= 0;
    const vars = { m5: fmtSignedPct(m5), m20: fmtSignedPct(m20) };
    return agree
      ? { status: "pass", reason: fill(T, "trend_pass_standalone", vars), values }
      : { status: "caution", reason: fill(T, "trend_caution_standalone", vars), values, tpl: "trend_caution_standalone" };
  };

  if (!context) return make("trend", config, standalone());

  const dir = context.expected_direction;
  if (!dir) {
    const r = standalone();
    return make("trend", config, { ...r, note: fill(T, "trend_note_undirected") });
  }
  const z = finite(vol) ? momentumZ(m5, vol, 5) : null;
  if (z == null) {
    return make("trend", config, { status: "n_a", reason: naReason(config, inputs, "momentum z (daily vol)"), values });
  }
  values.momentum_5d_z = z;
  values.expected_direction = dir;
  const vars = { m5: fmtSignedPct(m5), z: fmtZ(z), dir: dirWord(dir) };
  const s = sign(m5);
  if (s === 0) return make("trend", config, { status: "pass", reason: fill(T, "trend_flat_context", vars), values });
  const aligned = s === dirSign(dir);
  if (aligned) return make("trend", config, { status: "pass", reason: fill(T, "trend_pass_context", vars), values });
  if (Math.abs(z) > config.thresholds.trend.oppositeZFail) {
    return make("trend", config, { status: "fail", reason: fill(T, "trend_fail_context", vars), values, tpl: "trend_fail_context" });
  }
  return make("trend", config, { status: "caution", reason: fill(T, "trend_caution_context", vars), values, tpl: "trend_caution_context" });
}

// ---------------------------------------------------------------------------
// 2 volatility regime
// ---------------------------------------------------------------------------

export function checkRegime(inputs: GaugeInputs, config: GaugeConfig): GaugeCheck {
  const T = config.templates;
  const ratio = inputs.quant?.vol_regime ?? null;
  const values: Record<string, GaugeValue> = { vol_regime: ratio, daily_vol: inputs.quant?.daily_vol ?? null };
  if (!finite(ratio)) return make("regime", config, { status: "n_a", reason: naReason(config, inputs, "vol regime"), values });
  const th = config.thresholds.regime;
  const vars = { ratio: fmtRatio(ratio) };
  if (ratio > th.expandingMax) return make("regime", config, { status: "fail", reason: fill(T, "regime_fail_unstable", vars), values, tpl: "regime_fail_unstable" });
  if (ratio > th.stableMax) return make("regime", config, { status: "caution", reason: fill(T, "regime_caution_expanding", vars), values, tpl: "regime_caution_expanding" });
  if (ratio < th.contractingBelow) return make("regime", config, { status: "pass", reason: fill(T, "regime_pass_contracting", vars), values });
  return make("regime", config, { status: "pass", reason: fill(T, "regime_pass_stable", vars), values });
}

// ---------------------------------------------------------------------------
// 3 residual readability — never fails (the honesty check)
// ---------------------------------------------------------------------------

export function checkResidual(inputs: GaugeInputs, config: GaugeConfig): GaugeCheck {
  const T = config.templates;
  const r2 = inputs.quant?.r2 ?? null;
  const beta = inputs.quant?.beta ?? null;
  const values: Record<string, GaugeValue> = { r2, beta, r2_floor: inputs.r2_floor };
  if (!finite(r2)) return make("residual", config, { status: "n_a", reason: naReason(config, inputs, "r²"), values });
  const vars = { r2: fmtRatio(r2), beta: finite(beta) ? fmtRatio(beta) : "—" };
  if (r2 >= inputs.r2_floor) return make("residual", config, { status: "pass", reason: fill(T, "residual_pass", vars), values });
  return make("residual", config, { status: "caution", reason: fill(T, "residual_caution", vars), values, tpl: "residual_caution" });
}

// ---------------------------------------------------------------------------
// 4 volume state
// ---------------------------------------------------------------------------

export function checkVolume(inputs: GaugeInputs, config: GaugeConfig, context: GaugeContext | null): GaugeCheck {
  const T = config.templates;
  const ratio = inputs.quant?.volume_ratio ?? null;
  const partial = inputs.quant?.volume_ratio_partial ?? false;
  const values: Record<string, GaugeValue> = { volume_ratio: ratio, partial };
  if (!finite(ratio)) return make("volume", config, { status: "n_a", reason: naReason(config, inputs, "volume ratio"), values });
  const th = config.thresholds.volume;
  const vars = { ratio: fmtRatio(ratio) };
  const note = partial ? fill(T, "volume_note_partial") : null;
  let r: CheckResult;
  if (!context) {
    if (ratio > th.anomalyAbove) r = { status: "caution", reason: fill(T, "volume_anomaly", vars), tpl: "volume_anomaly" };
    else if (ratio > th.elevatedAbove) r = { status: "caution", reason: fill(T, "volume_elevated", vars), tpl: "volume_elevated" };
    else if (ratio < th.quietBelow) r = { status: "pass", reason: fill(T, "volume_quiet", vars) };
    else r = { status: "pass", reason: fill(T, "volume_normal", vars) };
  } else {
    if (ratio > th.anomalyAbove) r = { status: "caution", reason: fill(T, "volume_ctx_crowded", vars), tpl: "volume_ctx_crowded" };
    else if (ratio > th.elevatedAbove) r = { status: "caution", reason: fill(T, "volume_elevated", vars), tpl: "volume_elevated" };
    else if (ratio >= th.buildingMin) r = { status: "pass", reason: fill(T, "volume_ctx_confirming", vars) };
    else if (ratio < th.quietBelow) r = { status: "pass", reason: fill(T, "volume_ctx_early", vars) };
    else r = { status: "pass", reason: fill(T, "volume_normal", vars) };
  }
  return make("volume", config, { ...r, note, values });
}

// ---------------------------------------------------------------------------
// 5 stretch
// ---------------------------------------------------------------------------

export function checkStretch(inputs: GaugeInputs, config: GaugeConfig, context: GaugeContext | null): GaugeCheck {
  const T = config.templates;
  const q = inputs.quant;
  const m20 = q?.momentum_20d ?? null;
  const vol = q?.daily_vol ?? null;
  const fromHigh = q?.pct_from_52w_high ?? null;
  const fromLow = q?.pct_from_52w_low ?? null;
  const values: Record<string, GaugeValue> = { momentum_20d: m20, daily_vol: vol, pct_from_52w_high: fromHigh, pct_from_52w_low: fromLow };
  if (!finite(m20)) return make("stretch", config, { status: "n_a", reason: naReason(config, inputs, "20d move"), values });
  const z = finite(vol) ? momentumZ(m20, vol, 20) : null;
  if (z == null) return make("stretch", config, { status: "n_a", reason: naReason(config, inputs, "stretch z (daily vol)"), values });
  values.stretch_z = z;
  const th = config.thresholds.stretch;
  const az = Math.abs(z);
  const dir = context?.expected_direction ?? null;
  const vars = { m20: fmtSignedPct(m20), z: fmtZ(az), dir: dir ?? "" };

  let r: CheckResult;
  if (az <= th.passZ) r = { status: "pass", reason: fill(T, "stretch_pass", vars) };
  else if (az <= th.cautionZ) r = { status: "caution", reason: fill(T, "stretch_caution", vars), tpl: "stretch_caution" };
  else if (dir) {
    const inDirection = sign(m20) === dirSign(dir);
    r = inDirection
      ? { status: "fail", reason: fill(T, "stretch_fail_spent", vars), tpl: "stretch_fail_spent" }
      : { status: "caution", reason: fill(T, "stretch_caution_washout", vars), tpl: "stretch_caution_washout" };
  } else r = { status: "caution", reason: fill(T, "stretch_caution_heavy", vars), tpl: "stretch_caution_heavy" };

  // 52w proximity note — a disclosure, never a status change.
  let note: string | null = null;
  if (finite(fromHigh) && Math.abs(fromHigh) <= th.near52wPct) note = fill(T, "stretch_note_near_high", { pct: fmtPct(fromHigh) });
  else if (finite(fromLow) && Math.abs(fromLow) <= th.near52wPct) note = fill(T, "stretch_note_near_low", { pct: fmtPct(fromLow) });
  return make("stretch", config, { ...r, note, values });
}

// ---------------------------------------------------------------------------
// 6 event wall
// ---------------------------------------------------------------------------

export function checkEventWall(inputs: GaugeInputs, config: GaugeConfig, context: GaugeContext | null): GaugeCheck {
  const T = config.templates;
  const th = config.thresholds.eventWall;
  const next = inputs.next_earnings;
  const rhythm = inputs.quant?.earnings_rhythm ?? null;
  const values: Record<string, GaugeValue> = {
    due_at: next?.due_at ?? null,
    sessions_until: next?.sessions_until ?? null,
    fiscal_period: next?.fiscal_period ?? null,
    earnings_rhythm: rhythm,
  };
  if (context?.thesis_is_scheduled_event) return make("event_wall", config, { status: "n_a", reason: fill(T, "event_na_thesis"), values });
  if (!next || !finite(next.sessions_until) || next.sessions_until < 0) {
    return make("event_wall", config, { status: "pass", reason: fill(T, "event_pass_none", { horizon: th.cautionSessions }), values });
  }
  const n = next.sessions_until;
  const vars = { n, s: plural(n), horizon: th.cautionSessions, rhythm: finite(rhythm) ? fmtPct(rhythm) : fill(T, "event_rhythm_unavailable") };
  if (n <= th.failSessions) return make("event_wall", config, { status: "fail", reason: fill(T, "event_fail", vars), values, tpl: "event_fail" });
  if (n <= th.cautionSessions) return make("event_wall", config, { status: "caution", reason: fill(T, "event_caution", vars), values, tpl: "event_caution" });
  // G1: outside the wall but close and big → pass with the "sizeable event" note (distance × size is not swallowed).
  const sizeable = n <= th.noteSessionsMax && finite(rhythm) && rhythm >= th.noteRhythmMin;
  return make("event_wall", config, { status: "pass", reason: fill(T, "event_pass_far", vars), note: sizeable ? fill(T, "event_note_sizeable", vars) : null, values });
}

// ---------------------------------------------------------------------------
// 7 conflict scan (context only)
// ---------------------------------------------------------------------------

export function checkConflict(inputs: GaugeInputs, config: GaugeConfig, context: GaugeContext): GaugeCheck {
  const T = config.templates;
  const d = inputs.detectors;
  const tags = new Set(inputs.incidents.flatMap((i) => i.tags));
  const values: Record<string, GaugeValue> = {
    insider_cluster: d ? (d.insider_cluster.active ? d.insider_cluster.direction ?? "active" : false) : null,
    drift: d ? (d.drift.active ? d.drift.direction ?? "active" : false) : null,
    unexplained_move: d ? (d.unexplained_move.active ? d.unexplained_move.direction ?? "active" : false) : null,
    filing_overdue: d ? d.filing_overdue : null,
    news_burst: d ? d.news_burst : null,
    open_incidents: inputs.incidents.length,
    incident_tags: [...tags].sort().join(",") || null,
  };
  if (!d) return make("conflict", config, { status: "n_a", reason: fill(T, "na_no_detectors"), values });

  const dir = context.expected_direction;
  const fails: Array<{ reason: string; tpl: string }> = [];
  const cautions: Array<{ reason: string; tpl: string }> = [];
  if (dir) {
    const want = dirSign(dir);
    if (d.insider_cluster.active && d.insider_cluster.direction) {
      const insiderSign = d.insider_cluster.direction === "buy" ? 1 : -1;
      if (insiderSign !== want) {
        fails.push({ reason: fill(T, "conflict_fail_insider", { side: fill(T, d.insider_cluster.direction === "buy" ? "conflict_side_buy" : "conflict_side_sell"), dir }), tpl: "conflict_fail_insider" });
      }
    }
    if (d.unexplained_move.active && d.unexplained_move.direction && dirSign(d.unexplained_move.direction) !== want) {
      cautions.push({ reason: fill(T, "conflict_caution_unexplained", { move_dir: d.unexplained_move.direction, dir }), tpl: "conflict_caution_unexplained" });
    }
    if (d.drift.active && d.drift.direction && dirSign(d.drift.direction) !== want) {
      cautions.push({ reason: fill(T, "conflict_caution_drift", { move_dir: d.drift.direction, dir }), tpl: "conflict_caution_drift" });
    }
  }
  if (tags.has("disclosure_risk")) cautions.push({ reason: fill(T, "conflict_caution_disclosure"), tpl: "conflict_caution_disclosure" });
  if (d.filing_overdue) cautions.push({ reason: fill(T, "conflict_caution_filing_overdue"), tpl: "conflict_caution_filing_overdue" });

  values.conflicts = fails.length + cautions.length;
  if (fails.length) return make("conflict", config, { status: "fail", reason: fails[0].reason, note: [...fails.slice(1), ...cautions].map((c) => c.reason).join(" · ") || null, values, tpl: fails[0].tpl });
  if (cautions.length) return make("conflict", config, { status: "caution", reason: cautions[0].reason, note: cautions.slice(1).map((c) => c.reason).join(" · ") || null, values, tpl: cautions[0].tpl });
  return make("conflict", config, { status: "pass", reason: fill(T, dir ? "conflict_pass" : "conflict_pass_undirected"), values });
}

// ---------------------------------------------------------------------------
// 8 window freshness (context only)
// ---------------------------------------------------------------------------

export function checkFreshness(config: GaugeConfig, context: GaugeContext, sessionsSince: number | null): GaugeCheck {
  const T = config.templates;
  const th = config.thresholds.freshness;
  const values: Record<string, GaugeValue> = { event_ts: context.event_ts ?? null, sessions_since_event: sessionsSince, pricing_status: context.pricing_status ?? null };
  if (context.pricing_status === "priced") return make("freshness", config, { status: "fail", reason: fill(T, "freshness_fail_priced"), values, tpl: "freshness_fail_priced" });
  if (!finite(sessionsSince)) return make("freshness", config, { status: "n_a", reason: fill(T, "freshness_na"), values });
  const n = Math.max(0, sessionsSince);
  const vars = { n, s: plural(n) };
  if (n >= th.closedSessions) return make("freshness", config, { status: "fail", reason: fill(T, "freshness_fail_closed", vars), values, tpl: "freshness_fail_closed" });
  if (n <= th.freshMaxSessions) return make("freshness", config, { status: "pass", reason: fill(T, "freshness_pass", vars), values });
  return make("freshness", config, { status: "caution", reason: fill(T, "freshness_caution", vars), values, tpl: "freshness_caution" });
}
