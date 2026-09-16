/**
 * Gauge config (spec §9). Every §3 threshold, the memo TTL, the banned-word
 * list and every template string live here and are overridable from
 * `data/gauge/config.json` (stored config overrides code defaults field by
 * field). The r² floor is deliberately absent: it is Tracker's
 * `thresholds.lowR2Fallback`, read from the Tracker config and passed in as an
 * input, so the two engines can never disagree on it.
 */

import { GAUGE_SETUPS, type GaugeCheckKey, type GaugeSetupKey } from "./types.js";

export type GaugeThresholds = {
  trend: {
    /** Context mode: |momentum-5d z| above this, against the thesis → fail. */
    oppositeZFail: number;
  };
  regime: {
    /** vol30/vol90 ≤ this → stable (pass). */
    stableMax: number;
    /** ≤ this → expanding (caution); above → unstable (fail). */
    expandingMax: number;
    /** < this → contracting (pass with note). */
    contractingBelow: number;
  };
  volume: {
    quietBelow: number;
    /** Standalone: above this → elevated (caution). Context: buildingMin–this → confirming. */
    elevatedAbove: number;
    /** Above this → anomaly / crowded (caution). */
    anomalyAbove: number;
    /** Context: from this up to elevatedAbove → "volume confirming". */
    buildingMin: number;
  };
  stretch: {
    /** |z| ≤ this → pass. */
    passZ: number;
    /** |z| ≤ this → caution; above → fail (context, in direction) / caution (against). */
    cautionZ: number;
    /** Within this fraction of a 52w extreme → note appended (0.02 = 2%). */
    near52wPct: number;
  };
  eventWall: {
    /** Due within this many sessions → caution. */
    cautionSessions: number;
    /** Due within this many sessions → fail. */
    failSessions: number;
    /** G1: a pass with due ≤ this many sessions AND rhythm ≥ noteRhythmMin carries the "sizeable event" note. */
    noteSessionsMax: number;
    /** G1: earnings_rhythm (fraction) at or above which the note is appended. */
    noteRhythmMin: number;
  };
  freshness: {
    /** Sessions since the event ≤ this → fresh (pass). */
    freshMaxSessions: number;
    /** Sessions ≥ this → window closed (fail); between → aging (caution). */
    closedSessions: number;
  };
};

export type GaugeTemplates = Record<string, string>;

/**
 * v2 §2 setup recognition. Conditions are combinations of the same values the
 * v1 checks read, plus Screen's active findings; the evaluation `order` is
 * config too, so the table can be re-prioritised without a build.
 */
export type GaugeSetupThresholds = {
  /** Evaluation order — first match wins. */
  order: GaugeSetupKey[];
  coiled: {
    /** vol_regime at or below this reads as compressed. */
    regimeMax: number;
    /** volume_ratio strictly below this reads as quiet. */
    volumeRatioMax: number;
    /** |stretch_z| at or below this reads as un-extended. */
    stretchZMax: number;
  };
  eventWall: {
    /** Earnings within this many sessions holds the tape (state `wait`). */
    waitSessions: number;
    /** Within this many sessions the event dominates everything else. */
    imminentSessions: number;
  };
  moveSpent: {
    stretchZMin: number;
    volumeRatioMin: number;
  };
  accumulation: {
    /** |momentum-5d z| strictly below this reads as flat price. */
    momentumZMax: number;
  };
  confirmedDrift: {
    volumeRatioMin: number;
    volumeRatioMax: number;
    stretchZMax: number;
  };
  quietDrift: {
    /** volume_ratio strictly below this is "no participation yet". */
    volumeRatioMax: number;
  };
  regimeBreak: {
    /** vol_regime above this makes the structure unmeasurable. */
    regimeMin: number;
  };
  /** Lookback for the news/event gates (sessions). */
  newsLookbackSessions: number;
};

export type GaugeConfig = {
  schemaVersion: number;
  thresholds: GaugeThresholds;
  /** v2 setup recognition table. */
  setups: GaugeSetupThresholds;
  /** §10 setup ledger: append-only snapshots for the outcome study. */
  snapshots: {
    enabled: boolean;
    /** Trim the ledger to this many lines on write. */
    maxLines: number;
  };
  /** n_a checks at or above this → "calibrating" banner (§6). */
  calibratingNaCount: number;
  /** Host memo per (ticker, context-hash). */
  memoTtlMs: number;
  /** §5 — asserted against every template and label by test. */
  bannedWords: string[];
  labels: Record<GaugeCheckKey, string>;
  templates: GaugeTemplates;
};

export const DEFAULT_GAUGE_CONFIG: GaugeConfig = {
  schemaVersion: 1,
  thresholds: {
    trend: { oppositeZFail: 1.5 },
    regime: { stableMax: 1.2, expandingMax: 1.5, contractingBelow: 0.8 },
    volume: { quietBelow: 0.7, elevatedAbove: 2.0, anomalyAbove: 3.0, buildingMin: 1.0 },
    stretch: { passZ: 1.0, cautionZ: 2.0, near52wPct: 0.02 },
    eventWall: { cautionSessions: 3, failSessions: 1, noteSessionsMax: 10, noteRhythmMin: 0.05 },
    freshness: { freshMaxSessions: 1, closedSessions: 3 },
  },
  setups: {
    /**
     * Deviations from the v1.0 spec table's order, all measured against the
     * live universe on 2026-08-24 and all reversible here:
     *  - `coiled_event_ahead` sits above `event_wall` so a compressed name with
     *    an event still reads as compressed-but-resolved-by-the-event.
     *  - `event_wall` fires at 3 sessions, not 1: at `evt = 2` the spec's own
     *    table left NVDA on "no recognizable structure" while its own §3 wait
     *    example is "earnings in 2 sessions".
     *  - `unreadable` drops below the structural rows: a low r² makes residual
     *    reads weak, not range and volume. It is the fallback when there is no
     *    structure to stand on, and otherwise becomes `readable: false`.
     */
    order: [
      "coiled_event_ahead",
      "event_wall",
      "regime_break",
      "move_spent",
      "divergence",
      "accumulation",
      "confirmed_drift",
      "quiet_drift",
      "coiled",
      "unreadable",
      "no_setup",
    ],
    coiled: { regimeMax: 0.8, volumeRatioMax: 1.2, stretchZMax: 1.0 },
    eventWall: { waitSessions: 3, imminentSessions: 1 },
    moveSpent: { stretchZMin: 2.0, volumeRatioMin: 2.0 },
    accumulation: { momentumZMax: 1.0 },
    confirmedDrift: { volumeRatioMin: 1.2, volumeRatioMax: 3.0, stretchZMax: 2.0 },
    quietDrift: { volumeRatioMax: 1.2 },
    regimeBreak: { regimeMin: 1.5 },
    newsLookbackSessions: 5,
  },
  snapshots: { enabled: true, maxLines: 50_000 },
  calibratingNaCount: 3,
  memoTtlMs: 60_000,
  bannedWords: [
    "buy",
    "sell",
    "enter",
    "exit",
    "long",
    "short",
    "add",
    "trim",
    "target",
    "stop",
    "take profit",
    "signal",
    "prediction",
    "recommend",
    // v2 §6: the decision vocabulary a setup layer is tempted into. "actionable"
    // is the single allowed decision word and its definition is fixed in
    // `tooltip_state_actionable`.
    "opportunity",
    "edge",
    "high probability",
    "likely",
    "good setup",
    "bad setup",
  ],
  labels: {
    trend: "Trend coherence",
    regime: "Volatility regime",
    residual: "Residual readability",
    volume: "Volume state",
    stretch: "Stretch",
    event_wall: "Event wall",
    conflict: "Conflict scan",
    freshness: "Window freshness",
  },
  templates: {
    // --- generic n_a ---------------------------------------------------------
    na_history: "{what} unavailable — fresh listing, history window not yet full ({sessions} sessions on file)",
    na_not_computed: "{what} unavailable — close-run not yet computed",
    na_no_detectors: "detector state unavailable — Tracker state not yet built",

    // --- 1 trend coherence -----------------------------------------------------
    trend_pass_standalone: "5d and 20d momentum agree ({m5} / {m20}) — price action coherent",
    trend_caution_standalone: "5d and 20d momentum disagree ({m5} / {m20}) — mixed tape",
    trend_pass_context: "5d momentum {m5} (z {z}) aligned with the expected {dir} move",
    trend_flat_context: "5d momentum flat (z {z}) — neither aligned nor contradicting the expected {dir} move",
    trend_caution_context: "5d momentum {m5} (z {z}) mildly against the expected {dir} move",
    trend_fail_context: "tape is fighting the thesis — 5d momentum {m5} (z {z}) against the expected {dir} move",
    trend_note_undirected: "thesis direction unresolved — read as standalone",

    // --- 2 volatility regime ---------------------------------------------------
    regime_pass_stable: "vol regime {ratio}× its 90d norm — stable",
    regime_pass_contracting: "vol regime {ratio}× its 90d norm — contracting, quieter than usual",
    regime_caution_expanding: "vol regime {ratio}× its 90d norm — expanding",
    regime_fail_unstable: "regime unstable — vol {ratio}× its 90d norm; reads unreliable",

    // --- 3 residual readability --------------------------------------------------
    // A low r² means the market model explains LITTLE of this name's movement,
    // so subtracting β·benchmark adds noise instead of removing it — the same
    // reason Tracker falls back from residual_zscore to move_zscore under its
    // floor. (v1 shipped this line inverted, as "most daily movement is
    // market"; the numbers said the opposite.)
    residual_pass: "r² {r2}, β {beta} — residual reads usable",
    residual_caution: "β {beta}, r² {r2} — the market model explains little of the daily movement; residual reads no cleaner than the raw move",

    // --- 4 volume state ----------------------------------------------------------
    volume_quiet: "volume {ratio}× its average — quiet",
    volume_normal: "volume {ratio}× its average — normal",
    volume_elevated: "volume {ratio}× its average — elevated",
    volume_anomaly: "volume {ratio}× its average — event-driven tape",
    volume_ctx_early: "volume {ratio}× its average — early, market not yet looking",
    volume_ctx_confirming: "volume {ratio}× its average — confirming",
    volume_ctx_crowded: "volume {ratio}× its average — crowded, late",
    volume_note_partial: "intraday-partial — session volume still accumulating",

    // --- 5 stretch ---------------------------------------------------------------
    stretch_pass: "20d move {m20} is {z}σ — not stretched",
    stretch_caution: "20d move {m20} is {z}σ — stretched",
    stretch_caution_heavy: "20d move {m20} is {z}σ — heavily stretched",
    stretch_fail_spent: "move may be spent — 20d move {m20} already {z}σ in the expected {dir} direction",
    stretch_caution_washout: "20d move {m20} is {z}σ against the expected {dir} direction — potential washout",
    stretch_note_near_high: "within {pct} of the 52w high",
    stretch_note_near_low: "within {pct} of the 52w low",

    // --- 6 event wall ------------------------------------------------------------
    event_pass_none: "no scheduled event within {horizon} sessions",
    event_pass_far: "earnings in {n} sessions — outside the {horizon}-session wall",
    event_caution: "earnings in {n} session{s} — typical move {rhythm}",
    event_fail: "earnings in {n} session{s} — typical move {rhythm}",
    event_na_thesis: "event is the thesis",
    event_note_sizeable: "earnings in {n} sessions, typical move {rhythm} — sizeable event on the horizon",
    event_rhythm_unavailable: "unavailable",

    // --- 7 conflict scan (context only) ------------------------------------------
    conflict_fail_insider: "insider cluster {side} — contradicting the expected {dir} move",
    conflict_caution_unexplained: "unexplained move {move_dir} against the expected {dir} move",
    conflict_caution_drift: "drift {move_dir} against the expected {dir} move",
    conflict_caution_disclosure: "disclosure risk open on the name",
    conflict_caution_filing_overdue: "filing overdue on the name",
    conflict_pass: "nothing live contradicting the thesis",
    conflict_pass_undirected: "nothing live contradicting the thesis — direction unresolved, only disclosure conflicts scanned",
    conflict_side_sell: "distributing",
    conflict_side_buy: "accumulating",

    // --- 8 window freshness (context only) ---------------------------------------
    freshness_pass: "{n} session{s} since the event — fresh",
    freshness_caution: "{n} session{s} since the event — aging",
    freshness_fail_closed: "window closed — {n} sessions since the event; pricing status frozen",
    freshness_fail_priced: "window closed — already priced at the source",
    freshness_na: "event timestamp unavailable",

    // --- summary -----------------------------------------------------------------
    summary_clear_all: "clear — {aligned} of {evaluable} aligned",
    summary_clear_except: "clear except {check}: {reason}",
    summary_mixed: "mixed — {n} cautions: {labels}",
    summary_blocked: "blocked — {reason}",
    summary_untracked: "Not tracked — no gauge.",
    summary_unavailable: "{n} unavailable",
    banner_calibrating: "calibrating — limited history",

    // --- v2 §1–§3 setup names, readings, missing lines ------------------------------
    // Names are descriptive, never judgements (§6): COILED / MOVE SPENT, not
    // GOOD SETUP. Every reading is a condition sentence with its numbers.
    setup_name_coiled: "COILED",
    setup_name_coiled_event_ahead: "COILED · EVENT AHEAD",
    setup_name_quiet_drift: "QUIET DRIFT",
    setup_name_confirmed_drift: "CONFIRMED DRIFT",
    setup_name_accumulation: "ACCUMULATION",
    setup_name_move_spent: "MOVE SPENT",
    setup_name_divergence: "DIVERGENCE",
    setup_name_regime_break: "REGIME BREAK",
    setup_name_unreadable: "UNREADABLE",
    setup_name_event_wall: "EVENT WALL",
    setup_name_no_setup: "NO SETUP",

    setup_read_coiled: "Compressed range, quiet volume, no event wall for {evt} sessions",
    setup_read_coiled_confirmed: "Compressed for {n} sessions — vol {regime}× its 90d norm, quiet volume, no event wall for {evt} sessions",
    setup_read_coiled_event_ahead: "Compressed, but earnings in {evt} session{s} — the event resolves it, not the tape",
    setup_read_quiet_drift_up: "Pushing on its own for {n} sessions, market-independent",
    setup_read_quiet_drift_down: "Sliding on its own for {n} sessions, market-independent",
    setup_read_confirmed_drift_up: "Independent move higher with volume building — {n} sessions, {vr}× average",
    setup_read_confirmed_drift_down: "Independent move lower with volume building — {n} sessions, {vr}× average",
    setup_read_accumulation: "Volume arriving for {n} sessions, price flat — someone is building",
    setup_read_move_spent: "{z}σ move already delivered on {vr}× volume",
    setup_read_divergence_buy: "Insiders accumulating against a falling tape ({m20} over 20 sessions)",
    setup_read_divergence_sell: "Insiders distributing against a rising tape ({m20} over 20 sessions)",
    setup_read_regime_break: "Volatility {ratio}× its own norm — structure unreliable",
    setup_read_unreadable: "The market model explains little of the movement (β {beta}, r² {r2}) — residual reads no cleaner than the raw move",
    setup_read_unreadable_na: "Not enough history to fit the market model — residual reads unavailable",
    setup_read_event_wall: "Earnings in {evt} session{s}, typical move {rhythm} — everything else is noise until then",
    setup_read_no_setup: "No recognizable structure — normal tape",
    setup_read_untracked: "Not tracked — no gauge.",

    // Missing lines (§3): every one names a measured threshold and where the value stands now.
    setup_missing_volume_label: "volume confirmation",
    setup_missing_volume: "volume {vr}× average, needs {min}× — no participation yet",
    setup_missing_event_label: "earnings in {evt} session{s}",
    setup_missing_event: "earnings in {evt} session{s} on {due} — the tape reads through until it prints",
    setup_missing_regime_label: "regime to settle",
    setup_missing_regime: "vol {ratio}× its 90d norm, needs {max}× or below",

    // Readability caveat carried alongside a structural setup (§B4b).
    setup_readability_low_r2: "residual reads weak — the market model explains little (β {beta}, r² {r2}); the structure is measured on price and volume, not residuals",
    setup_readability_regime: "vol regime {ratio}× its 90d norm — measurements are unstable",

    // Context-mode contradiction (§2).
    setup_contradicted: "The tape is set up in the opposite direction of the thesis — {setup} reads {dir}, the thesis expects {expected}",

    // --- G3 state tooltips (one sentence each) -------------------------------------
    tooltip_state_actionable: "conditions are consistent enough to test a thesis",
    tooltip_state_wait: "a structure is present but one condition is still missing",
    tooltip_state_nothing_here: "no structure, or the move has already happened",
    tooltip_state_unreadable: "the measurement itself is unreliable here",
    tooltip_state_contradicted_setup: "the tape is set up against the thesis",
    tooltip_clear: "conditions are consistent and readable",
    tooltip_mixed: "conditions disagree — no clean read",
    tooltip_blocked: "at least one condition rules out a clean read",
    tooltip_untracked: "not in the Tracker universe — nothing to read",

    // --- G2 short labels (2–3 words) keyed by the reason template they describe ------
    short_trend_caution_standalone: "momentum split",
    short_trend_caution_context: "tape against thesis",
    short_trend_fail_context: "tape fighting thesis",
    short_regime_caution_expanding: "vol expanding",
    short_regime_fail_unstable: "regime unstable",
    short_residual_caution: "weak residual read",
    short_volume_elevated: "volume elevated",
    short_volume_anomaly: "event-driven tape",
    short_volume_ctx_crowded: "volume crowded",
    short_stretch_caution: "stretched",
    short_stretch_caution_heavy: "heavily stretched",
    short_stretch_fail_spent: "move spent",
    short_stretch_caution_washout: "potential washout",
    short_event_caution: "earnings near",
    short_event_fail: "earnings imminent",
    short_conflict_fail_insider: "insider conflict",
    short_conflict_caution_unexplained: "unexplained move against",
    short_conflict_caution_drift: "drift against",
    short_conflict_caution_disclosure: "disclosure risk",
    short_conflict_caution_filing_overdue: "filing overdue",
    short_freshness_caution: "window aging",
    short_freshness_fail_closed: "window closed",
    short_freshness_fail_priced: "already priced",
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

export function mergeGaugeConfig(stored: DeepPartial<GaugeConfig> | null | undefined): GaugeConfig {
  const d = DEFAULT_GAUGE_CONFIG;
  if (!stored) return structuredClone(d);
  const s = stored;
  const t = s.thresholds ?? {};
  const labels = { ...d.labels };
  for (const key of Object.keys(d.labels) as GaugeCheckKey[]) labels[key] = str(s.labels?.[key], d.labels[key]);
  const templates: GaugeTemplates = { ...d.templates };
  for (const [key, value] of Object.entries(s.templates ?? {})) if (typeof value === "string" && value.length > 0) templates[key] = value;
  const su = s.setups ?? {};
  const order = Array.isArray(su.order) && su.order.length > 0 && su.order.every((k) => (GAUGE_SETUPS as readonly string[]).includes(k as string))
    ? ([...new Set(su.order as GaugeSetupKey[])] as GaugeSetupKey[])
    : [...d.setups.order];
  return {
    schemaVersion: d.schemaVersion,
    setups: {
      // Any setup the stored order forgot still evaluates, at the end, in the
      // default order — a truncated list must never silently disable a row.
      order: [...order, ...d.setups.order.filter((k) => !order.includes(k))],
      coiled: {
        regimeMax: num(su.coiled?.regimeMax, d.setups.coiled.regimeMax),
        volumeRatioMax: num(su.coiled?.volumeRatioMax, d.setups.coiled.volumeRatioMax),
        stretchZMax: num(su.coiled?.stretchZMax, d.setups.coiled.stretchZMax),
      },
      eventWall: {
        waitSessions: num(su.eventWall?.waitSessions, d.setups.eventWall.waitSessions),
        imminentSessions: num(su.eventWall?.imminentSessions, d.setups.eventWall.imminentSessions),
      },
      moveSpent: {
        stretchZMin: num(su.moveSpent?.stretchZMin, d.setups.moveSpent.stretchZMin),
        volumeRatioMin: num(su.moveSpent?.volumeRatioMin, d.setups.moveSpent.volumeRatioMin),
      },
      accumulation: { momentumZMax: num(su.accumulation?.momentumZMax, d.setups.accumulation.momentumZMax) },
      confirmedDrift: {
        volumeRatioMin: num(su.confirmedDrift?.volumeRatioMin, d.setups.confirmedDrift.volumeRatioMin),
        volumeRatioMax: num(su.confirmedDrift?.volumeRatioMax, d.setups.confirmedDrift.volumeRatioMax),
        stretchZMax: num(su.confirmedDrift?.stretchZMax, d.setups.confirmedDrift.stretchZMax),
      },
      quietDrift: { volumeRatioMax: num(su.quietDrift?.volumeRatioMax, d.setups.quietDrift.volumeRatioMax) },
      regimeBreak: { regimeMin: num(su.regimeBreak?.regimeMin, d.setups.regimeBreak.regimeMin) },
      newsLookbackSessions: num(su.newsLookbackSessions, d.setups.newsLookbackSessions),
    },
    snapshots: {
      enabled: typeof s.snapshots?.enabled === "boolean" ? s.snapshots.enabled : d.snapshots.enabled,
      maxLines: num(s.snapshots?.maxLines, d.snapshots.maxLines),
    },
    thresholds: {
      trend: { oppositeZFail: num(t.trend?.oppositeZFail, d.thresholds.trend.oppositeZFail) },
      regime: {
        stableMax: num(t.regime?.stableMax, d.thresholds.regime.stableMax),
        expandingMax: num(t.regime?.expandingMax, d.thresholds.regime.expandingMax),
        contractingBelow: num(t.regime?.contractingBelow, d.thresholds.regime.contractingBelow),
      },
      volume: {
        quietBelow: num(t.volume?.quietBelow, d.thresholds.volume.quietBelow),
        elevatedAbove: num(t.volume?.elevatedAbove, d.thresholds.volume.elevatedAbove),
        anomalyAbove: num(t.volume?.anomalyAbove, d.thresholds.volume.anomalyAbove),
        buildingMin: num(t.volume?.buildingMin, d.thresholds.volume.buildingMin),
      },
      stretch: {
        passZ: num(t.stretch?.passZ, d.thresholds.stretch.passZ),
        cautionZ: num(t.stretch?.cautionZ, d.thresholds.stretch.cautionZ),
        near52wPct: num(t.stretch?.near52wPct, d.thresholds.stretch.near52wPct),
      },
      eventWall: {
        cautionSessions: num(t.eventWall?.cautionSessions, d.thresholds.eventWall.cautionSessions),
        failSessions: num(t.eventWall?.failSessions, d.thresholds.eventWall.failSessions),
        noteSessionsMax: num(t.eventWall?.noteSessionsMax, d.thresholds.eventWall.noteSessionsMax),
        noteRhythmMin: num(t.eventWall?.noteRhythmMin, d.thresholds.eventWall.noteRhythmMin),
      },
      freshness: {
        freshMaxSessions: num(t.freshness?.freshMaxSessions, d.thresholds.freshness.freshMaxSessions),
        closedSessions: num(t.freshness?.closedSessions, d.thresholds.freshness.closedSessions),
      },
    },
    calibratingNaCount: num(s.calibratingNaCount, d.calibratingNaCount),
    memoTtlMs: num(s.memoTtlMs, d.memoTtlMs),
    bannedWords: Array.isArray(s.bannedWords) && s.bannedWords.every((w) => typeof w === "string") ? [...(s.bannedWords as string[])] : [...d.bannedWords],
    labels,
    templates,
  };
}
