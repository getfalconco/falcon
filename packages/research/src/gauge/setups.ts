/**
 * Setup recognition (v2 §2). Deterministic combinations of the same values the
 * v1 checks read, plus Screen's active multi-session findings, resolved in a
 * configured order — first match wins. Pure functions; no LLM, no fetches.
 *
 * The layer answers "what structure is this name in?", never "should I act?".
 * `actionable` is the one decision word the language rules allow, and it means
 * exactly: conditions are consistent enough to test a thesis (§6).
 */

import { nyYmd } from "../tracker/calendar.js";
import type { GaugeConfig } from "./config.js";
import { fill, fmtPct, fmtRatio, fmtSignedPct, fmtZ, plural } from "./templates.js";
import type {
  GaugeContext,
  GaugeDecisionState,
  GaugeInputs,
  GaugeMissing,
  GaugeScreenFinding,
  GaugeScreenPattern,
  GaugeSetup,
  GaugeSetupKey,
  GaugeSignedDirection,
  GaugeValue,
} from "./types.js";

// ---------------------------------------------------------------------------
// Derived view
// ---------------------------------------------------------------------------

export type SetupView = {
  inputs: GaugeInputs;
  config: GaugeConfig;
  /** vol30 / vol90. */
  regime: number | null;
  volumeRatio: number | null;
  /** m20 / (vol × √20). */
  stretchZ: number | null;
  /** m5 / (vol × √5). */
  momentumZ5: number | null;
  momentum20: number | null;
  r2: number | null;
  beta: number | null;
  /** Trading sessions until the next confirmed earnings; null when none is known. */
  eventSessions: number | null;
  earningsRhythm: number | null;
  earningsDueDay: string | null;
  screen: Map<GaugeScreenPattern, GaugeScreenFinding>;
};

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function zScore(value: number | null | undefined, vol: number | null | undefined, days: number): number | null {
  if (!finite(value) || !finite(vol) || !(vol > 0)) return null;
  return value / (vol * Math.sqrt(days));
}

export function buildSetupView(inputs: GaugeInputs, config: GaugeConfig): SetupView {
  const q = inputs.quant;
  const vol = q?.daily_vol ?? null;
  const screen = new Map<GaugeScreenPattern, GaugeScreenFinding>();
  for (const f of inputs.screen ?? []) if (!screen.has(f.pattern)) screen.set(f.pattern, f);
  const due = inputs.next_earnings?.due_at ? new Date(inputs.next_earnings.due_at) : null;
  return {
    inputs,
    config,
    regime: q?.vol_regime ?? null,
    volumeRatio: q?.volume_ratio ?? null,
    stretchZ: zScore(q?.momentum_20d ?? null, vol, 20),
    momentumZ5: zScore(q?.momentum_5d ?? null, vol, 5),
    momentum20: q?.momentum_20d ?? null,
    r2: q?.r2 ?? null,
    beta: q?.beta ?? null,
    eventSessions: finite(inputs.next_earnings?.sessions_until) ? inputs.next_earnings!.sessions_until : null,
    earningsRhythm: q?.earnings_rhythm ?? null,
    earningsDueDay: due && !Number.isNaN(due.getTime()) ? nyYmd(due) : null,
    screen,
  };
}

// ---------------------------------------------------------------------------
// Recognisers
// ---------------------------------------------------------------------------

/** What a matched setup contributes before the state layer runs. */
type Match = {
  read: string;
  direction: GaugeSignedDirection | null;
  values: Record<string, GaugeValue>;
  patterns: GaugeScreenPattern[];
};

type Recogniser = (v: SetupView) => Match | null;

/** §3 base state per setup, before readability and context are applied. */
export const SETUP_BASE_STATE: Record<GaugeSetupKey, GaugeDecisionState> = {
  coiled: "actionable",
  coiled_event_ahead: "wait",
  quiet_drift: "wait",
  confirmed_drift: "actionable",
  accumulation: "actionable",
  move_spent: "nothing_here",
  divergence: "actionable",
  regime_break: "unreadable",
  unreadable: "unreadable",
  event_wall: "wait",
  no_setup: "nothing_here",
};

function screenDirection(f: GaugeScreenFinding | undefined): GaugeSignedDirection | null {
  if (!f) return null;
  if (f.direction === "up" || f.direction === "down") return f.direction;
  if (f.direction === "buy") return "up";
  if (f.direction === "sell") return "down";
  return null;
}

function num(v: GaugeValue | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The instantaneous compression structure — range, volume and extension only. */
function coiledStructure(v: SetupView): boolean {
  const t = v.config.setups.coiled;
  return finite(v.regime) && v.regime <= t.regimeMax && finite(v.volumeRatio) && v.volumeRatio < t.volumeRatioMax && finite(v.stretchZ) && Math.abs(v.stretchZ) <= t.stretchZMax;
}

function eventWithin(v: SetupView, sessions: number): boolean {
  return finite(v.eventSessions) && v.eventSessions >= 0 && v.eventSessions <= sessions;
}

function rhythmText(v: SetupView): string {
  return finite(v.earningsRhythm) ? fmtPct(v.earningsRhythm) : fill(v.config.templates, "event_rhythm_unavailable");
}

const RECOGNISERS: Record<GaugeSetupKey, Recogniser> = {
  // 2 — compressed, but an event will resolve it rather than the tape
  coiled_event_ahead: (v) => {
    if (!coiledStructure(v) || !eventWithin(v, v.config.setups.eventWall.waitSessions)) return null;
    const evt = v.eventSessions!;
    return {
      read: fill(v.config.templates, "setup_read_coiled_event_ahead", { evt, s: plural(evt) }),
      direction: null,
      values: { vol_regime: v.regime, volume_ratio: v.volumeRatio, stretch_z: v.stretchZ, event_sessions: evt, earnings_rhythm: v.earningsRhythm },
      patterns: v.screen.has("compression") ? ["compression"] : [],
    };
  },

  // 10 — a binary event about to overwrite everything else
  event_wall: (v) => {
    if (!eventWithin(v, v.config.setups.eventWall.waitSessions)) return null;
    const evt = v.eventSessions!;
    return {
      read: fill(v.config.templates, "setup_read_event_wall", { evt, s: plural(evt), rhythm: rhythmText(v) }),
      direction: null,
      values: { event_sessions: evt, earnings_rhythm: v.earningsRhythm, due_at: v.inputs.next_earnings?.due_at ?? null, fiscal_period: v.inputs.next_earnings?.fiscal_period ?? null },
      patterns: [],
    };
  },

  // 8 — the volatility regime itself broke; structure is not measurable
  regime_break: (v) => {
    if (!finite(v.regime) || v.regime <= v.config.setups.regimeBreak.regimeMin) return null;
    return {
      read: fill(v.config.templates, "setup_read_regime_break", { ratio: fmtRatio(v.regime) }),
      direction: null,
      values: { vol_regime: v.regime, regime_min: v.config.setups.regimeBreak.regimeMin, daily_vol: v.inputs.quant?.daily_vol ?? null },
      patterns: [],
    };
  },

  // 6 — the move already happened, on participation
  move_spent: (v) => {
    const t = v.config.setups.moveSpent;
    if (!finite(v.stretchZ) || Math.abs(v.stretchZ) <= t.stretchZMin) return null;
    if (!finite(v.volumeRatio) || v.volumeRatio <= t.volumeRatioMin) return null;
    // The "there was news/an event" gate reads the detectors, never the raw
    // article count: this universe is news-saturated, so a count-based gate
    // would be true for every name and carry no information (Tracker T6).
    if (!v.inputs.news.burst_active && !v.inputs.news.event_in_window) return null;
    return {
      read: fill(v.config.templates, "setup_read_move_spent", { z: fmtZ(Math.abs(v.stretchZ)), vr: fmtRatio(v.volumeRatio) }),
      // The direction describes a move already delivered, not pressure now, so
      // it is deliberately not exposed for the contradiction test (§2).
      direction: null,
      values: {
        stretch_z: v.stretchZ,
        move_direction: v.stretchZ > 0 ? "up" : "down",
        volume_ratio: v.volumeRatio,
        momentum_20d: v.momentum20,
        news_burst: v.inputs.news.burst_active,
        event_in_window: v.inputs.news.event_in_window,
      },
      patterns: [],
    };
  },

  // 7 — insider flow against the tape (Screen owns the multi-session test)
  divergence: (v) => {
    const f = v.screen.get("insider_divergence");
    if (!f) return null;
    const side = f.direction === "buy" || f.direction === "sell" ? f.direction : null;
    if (!side) return null;
    const m20 = num(f.values.momentum_20d) ?? v.momentum20;
    return {
      read: fill(v.config.templates, side === "buy" ? "setup_read_divergence_buy" : "setup_read_divergence_sell", { m20: finite(m20) ? fmtSignedPct(m20) : "—" }),
      direction: side === "buy" ? "up" : "down",
      values: {
        insider_direction: side,
        insider_count: f.values.insider_count ?? null,
        momentum_20d: m20,
        momentum_20d_z: f.values.momentum_20d_z ?? null,
        day_count: f.day_count,
      },
      patterns: ["insider_divergence"],
    };
  },

  // 5 — volume arriving while price stays flat
  accumulation: (v) => {
    const f = v.screen.get("quiet_accumulation");
    if (!f) return null;
    if (!finite(v.momentumZ5) || Math.abs(v.momentumZ5) >= v.config.setups.accumulation.momentumZMax) return null;
    const n = num(f.values.sessions_qualifying) ?? f.day_count;
    return {
      read: fill(v.config.templates, "setup_read_accumulation", { n }),
      direction: null,
      values: {
        sessions_qualifying: n,
        avg_volume_ratio: f.values.avg_volume_ratio ?? null,
        momentum_5d_z: v.momentumZ5,
        day_count: f.day_count,
      },
      patterns: ["quiet_accumulation"],
    };
  },

  // 4 — the independent move, with participation building
  confirmed_drift: (v) => {
    const f = v.screen.get("independent_tape");
    if (!f) return null;
    const t = v.config.setups.confirmedDrift;
    if (!finite(v.volumeRatio) || v.volumeRatio < t.volumeRatioMin || v.volumeRatio > t.volumeRatioMax) return null;
    if (!finite(v.stretchZ) || Math.abs(v.stretchZ) > t.stretchZMax) return null;
    const dir = screenDirection(f);
    const n = num(f.values.sessions_qualifying) ?? f.day_count;
    return {
      read: fill(v.config.templates, dir === "down" ? "setup_read_confirmed_drift_down" : "setup_read_confirmed_drift_up", { n, vr: fmtRatio(v.volumeRatio) }),
      direction: dir,
      values: { sessions_qualifying: n, volume_ratio: v.volumeRatio, stretch_z: v.stretchZ, net_residual_z: f.values.net_residual_z ?? null, day_count: f.day_count },
      patterns: ["independent_tape"],
    };
  },

  // 3 — the independent move, with nobody looking yet
  quiet_drift: (v) => {
    const f = v.screen.get("independent_tape");
    if (!f) return null;
    if (!finite(v.volumeRatio) || v.volumeRatio >= v.config.setups.quietDrift.volumeRatioMax) return null;
    // "No news" means no active news_burst, not zero articles (Tracker T6).
    if (v.inputs.news.burst_active) return null;
    const dir = screenDirection(f);
    const n = num(f.values.sessions_qualifying) ?? f.day_count;
    return {
      read: fill(v.config.templates, dir === "down" ? "setup_read_quiet_drift_down" : "setup_read_quiet_drift_up", { n }),
      direction: dir,
      values: { sessions_qualifying: n, volume_ratio: v.volumeRatio, net_residual_z: f.values.net_residual_z ?? null, day_count: f.day_count },
      patterns: ["independent_tape"],
    };
  },

  // 1 — the coiled range
  coiled: (v) => {
    if (!coiledStructure(v)) return null;
    // Redundant while `coiled_event_ahead` is ordered first, kept explicit so a
    // re-ordered table can never call a name coiled with earnings tomorrow.
    if (eventWithin(v, v.config.setups.eventWall.waitSessions)) return null;
    const compression = v.screen.get("compression");
    const evt = finite(v.eventSessions) ? v.eventSessions : null;
    const values: Record<string, GaugeValue> = {
      vol_regime: v.regime,
      volume_ratio: v.volumeRatio,
      stretch_z: v.stretchZ,
      event_sessions: evt,
    };
    if (compression) {
      const ratio = num(compression.values.range_ratio);
      values.range_ratio = ratio;
      values.range = compression.values.range ?? null;
      values.compression_days = compression.day_count;
      return {
        // Screen's own binding condition for compression is the regime, not the
        // range ratio (its range bound is a generous 1.5× implied), so the
        // reading cites the regime and Screen's persistence — the ratio stays
        // in the raw values.
        read: fill(v.config.templates, "setup_read_coiled_confirmed", {
          n: compression.day_count,
          regime: finite(v.regime) ? fmtRatio(v.regime) : "—",
          evt: evt ?? "—",
        }),
        direction: null,
        values,
        patterns: ["compression"],
      };
    }
    return {
      read: fill(v.config.templates, "setup_read_coiled", { evt: evt ?? "—" }),
      direction: null,
      values,
      patterns: [],
    };
  },

  // 9 — the measurement itself, when no structure stands above it
  unreadable: (v) => {
    if (finite(v.r2) && v.r2 >= v.inputs.r2_floor) return null;
    const values: Record<string, GaugeValue> = { r2: v.r2, beta: v.beta, r2_floor: v.inputs.r2_floor };
    if (!finite(v.r2)) {
      return { read: fill(v.config.templates, "setup_read_unreadable_na"), direction: null, values, patterns: [] };
    }
    return {
      read: fill(v.config.templates, "setup_read_unreadable", { beta: finite(v.beta) ? fmtRatio(v.beta) : "—", r2: fmtRatio(v.r2) }),
      direction: null,
      values,
      patterns: [],
    };
  },

  // 11 — the honest empty answer
  no_setup: (v) => ({
    read: fill(v.config.templates, "setup_read_no_setup"),
    direction: null,
    values: { vol_regime: v.regime, volume_ratio: v.volumeRatio, stretch_z: v.stretchZ, r2: v.r2, event_sessions: v.eventSessions },
    patterns: [],
  }),
};

// ---------------------------------------------------------------------------
// Missing conditions (§3) — always a measured threshold and where it stands
// ---------------------------------------------------------------------------

function missingFor(key: GaugeSetupKey, v: SetupView): GaugeMissing {
  const T = v.config.templates;
  switch (key) {
    case "quiet_drift":
      return {
        label: fill(T, "setup_missing_volume_label"),
        detail: fill(T, "setup_missing_volume", {
          vr: finite(v.volumeRatio) ? fmtRatio(v.volumeRatio) : "—",
          min: fmtRatio(v.config.setups.confirmedDrift.volumeRatioMin),
        }),
      };
    case "coiled_event_ahead":
    case "event_wall": {
      const evt = v.eventSessions ?? 0;
      return {
        label: fill(T, "setup_missing_event_label", { evt, s: plural(evt) }),
        detail: fill(T, "setup_missing_event", { evt, s: plural(evt), due: v.earningsDueDay ?? "—" }),
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

export type SetupResult = {
  setup: GaugeSetup;
  state: GaugeDecisionState;
  missing: GaugeMissing;
  readable: boolean;
  readability_note: string | null;
  /** The sentence explaining a non-obvious state (contradiction); null otherwise. */
  state_line: string | null;
};

/**
 * Residual reads are usable when the market model fits (r² ≥ Tracker's floor)
 * and the vol regime is intact. A false here never hides the structure — range
 * and volume are measurable without a market fit (§B4b) — it qualifies it.
 */
export function isReadable(v: SetupView): boolean {
  if (!finite(v.r2) || v.r2 < v.inputs.r2_floor) return false;
  if (finite(v.regime) && v.regime > v.config.setups.regimeBreak.regimeMin) return false;
  return true;
}

export function recognizeSetup(inputs: GaugeInputs, config: GaugeConfig, context: GaugeContext | null): SetupResult {
  const v = buildSetupView(inputs, config);
  const T = config.templates;

  let key: GaugeSetupKey = "no_setup";
  let match: Match | null = null;
  for (const candidate of config.setups.order) {
    const recognise = RECOGNISERS[candidate];
    if (!recognise) continue;
    const result = recognise(v);
    if (result) {
      key = candidate;
      match = result;
      break;
    }
  }
  if (!match) match = RECOGNISERS.no_setup(v)!;

  const screenProvenance = match.patterns
    .map((p) => v.screen.get(p))
    .filter((f): f is GaugeScreenFinding => Boolean(f))
    .map((f) => ({ pattern: f.pattern, day_count: f.day_count, read: f.read }));

  const setup: GaugeSetup = {
    key,
    name: fill(T, `setup_name_${key}`),
    read: match.read,
    direction: match.direction,
    values: match.values,
    screen: screenProvenance,
  };

  let state = SETUP_BASE_STATE[key];
  let missing = state === "wait" ? missingFor(key, v) : null;

  // Readability qualifies a structural setup rather than replacing it; when the
  // setup IS the readability statement, its own reading already says so.
  const readable = isReadable(v);
  let readability_note: string | null = null;
  if (!readable && key !== "unreadable" && key !== "regime_break") {
    readability_note = finite(v.regime) && v.regime > config.setups.regimeBreak.regimeMin
      ? fill(T, "setup_readability_regime", { ratio: fmtRatio(v.regime) })
      : fill(T, "setup_readability_low_r2", { beta: finite(v.beta) ? fmtRatio(v.beta) : "—", r2: finite(v.r2) ? fmtRatio(v.r2) : "—" });
  }

  // §2 context mode: a directional setup running against the thesis is the most
  // valuable thing this engine can say, so it takes over the state.
  let state_line: string | null = null;
  const expected = context?.expected_direction ?? null;
  if (expected && setup.direction && setup.direction !== expected) {
    state = "contradicted_setup";
    missing = null;
    state_line = fill(T, "setup_contradicted", { setup: setup.name, dir: setup.direction, expected });
  }

  return { setup, state, missing, readable, readability_note, state_line };
}
