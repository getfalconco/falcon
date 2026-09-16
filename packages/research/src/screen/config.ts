/**
 * Screen config (spec §9). Every §3 threshold, window length, pattern enable
 * flag + panel sort priority, the retention window, the banned-word list and
 * every template string live here and are overridable from
 * `data/screen/config.json` (stored config overrides code defaults field by
 * field). The r² floor is deliberately absent: it is Tracker's
 * `thresholds.lowR2Fallback`, read from the Tracker config and passed in, so
 * the engines can never disagree on it.
 */

import { SCREEN_PATTERNS, type ScreenPattern } from "./types.js";

export type ScreenPatternConfig = {
  enabled: boolean;
  /** Panel sort tie-break after day_count (lower = first). */
  priority: number;
};

export type ScreenWindows = {
  /** The multi-session window the per-session criteria are counted over (§3.1, §3.3). */
  sessions: number;
  /** Volume baseline: median of this many prior sessions (§3.1). */
  volumeBaselineSessions: number;
  /** Compression high–low range window (§3.2). */
  compressionRangeSessions: number;
  /** Regression window for β / r² / residuals (matches Tracker betaDays). */
  betaSessions: number;
  volShortSessions: number;
  volLongSessions: number;
  momentumShort: number;
  momentumLong: number;
  week52Sessions: number;
};

export type ScreenThresholds = {
  quietAccumulation: {
    minQualifyingSessions: number;
    volumeRatioMin: number;
    /** |momentum_5d| / (daily_vol × √5) must be below this. */
    momentumZMax: number;
  };
  compression: {
    volRegimeMax: number;
    /** range ≤ multiple × daily_vol × √window. */
    rangeVolMultiple: number;
    /** Modifier only: within this fraction of a 52w extreme (0.03 = 3%). */
    near52wPct: number;
  };
  independentTape: {
    minQualifyingSessions: number;
    /** |residual_z| floor per qualifying session. */
    residualZMin: number;
    /** |Σ residual moves| ≥ multiple × daily_vol × √window. */
    netResidualVolMultiple: number;
  };
  insiderDivergence: {
    /** |momentum_20d| / (daily_vol × √20) floor. */
    momentumZMin: number;
  };
};

export type ScreenTemplates = Record<string, string>;

/**
 * S1 emit channel. Off by default: the channel spends Analyst budget
 * downstream, so it is opted into once the patterns have been watched.
 */
export type ScreenEmitConfig = {
  /** Master switch — false emits nothing at all. */
  screenEmitEnabled: boolean;
  /** Messages per ET day across every pattern and ticker. */
  dailyEmitCap: number;
  /** Which patterns keep their slot when the cap bites; first wins. */
  priority: ScreenPattern[];
};

export type ScreenConfig = {
  schemaVersion: number;
  patterns: Record<ScreenPattern, ScreenPatternConfig>;
  windows: ScreenWindows;
  thresholds: ScreenThresholds;
  /** Ended findings + scans older than this are pruned (§5). */
  retentionDays: number;
  /**
   * An open finding that could not be evaluated for this many consecutive
   * scan sessions (n_a / bars lagging) ends as `not_evaluable` instead of
   * lingering as "continuing" forever.
   */
  staleEndSessions: number;
  /** Host poll cadence for the close-run fingerprint. */
  pollIntervalMs: number;
  /** §6 — asserted against every label and template by test. Same list as Gauge. */
  bannedWords: string[];
  labels: Record<ScreenPattern, string>;
  templates: ScreenTemplates;
  /** TICKER → plural sector name, for the band card's cluster line. */
  sectors: Record<string, string>;
  /** S1 — the Screen → Base emit channel. */
  emit: ScreenEmitConfig;
};

export const DEFAULT_SCREEN_CONFIG: ScreenConfig = {
  schemaVersion: 1,
  emit: {
    screenEmitEnabled: false,
    dailyEmitCap: 5,
    // Deliberately not the panel's display priority: the emit order ranks by
    // how much a first sighting tends to be worth asking Analyst about.
    priority: ["insider_divergence", "independent_tape", "quiet_accumulation", "compression"],
  },
  patterns: {
    quiet_accumulation: { enabled: true, priority: 1 },
    independent_tape: { enabled: true, priority: 2 },
    insider_divergence: { enabled: true, priority: 3 },
    compression: { enabled: true, priority: 4 },
  },
  windows: {
    sessions: 5,
    volumeBaselineSessions: 20,
    compressionRangeSessions: 10,
    betaSessions: 90,
    volShortSessions: 30,
    volLongSessions: 90,
    momentumShort: 5,
    momentumLong: 20,
    week52Sessions: 252,
  },
  thresholds: {
    quietAccumulation: { minQualifyingSessions: 3, volumeRatioMin: 1.5, momentumZMax: 1.0 },
    compression: { volRegimeMax: 0.8, rangeVolMultiple: 1.5, near52wPct: 0.03 },
    independentTape: { minQualifyingSessions: 3, residualZMin: 1.0, netResidualVolMultiple: 1.5 },
    insiderDivergence: { momentumZMin: 0.75 },
  },
  retentionDays: 180,
  staleEndSessions: 5,
  pollIntervalMs: 60_000,
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
  ],
  labels: {
    quiet_accumulation: "Quiet accumulation",
    compression: "Compression",
    independent_tape: "Independent tape",
    insider_divergence: "Insider divergence",
  },
  templates: {
    // --- reads (one line per present finding; condition language only) ---------
    quiet_accumulation:
      "volume arriving for {n} of the last {window} sessions (avg {ratio}× its {baseline}d median) while price sits {z}σ from flat — no news burst in the window",
    compression:
      "vol regime {regime}× its 90d norm; {window}-session range {range} inside the {bound} band vol implies — coiled, no direction claimed",
    independent_tape:
      "{n} of the last {window} sessions moved {dir} on their own (|residual z| ≥ {zmin}); net residual {net} against {implied} vol-implied — market-independent pressure",
    independent_tape_dir_up: "upward",
    independent_tape_dir_down: "downward",
    insider_divergence_buy:
      "insiders accumulating ({count} insiders over {window} business days, {notional}) into a 20d decline of {m20} ({z}σ)",
    insider_divergence_sell:
      "insiders distributing ({count} insiders over {window} business days, {notional}) into a 20d advance of {m20} ({z}σ)",

    // --- modifiers --------------------------------------------------------------
    modifier_near_52w_high: "within {pct} of the 52w high",
    modifier_near_52w_low: "within {pct} of the 52w low",

    // --- n_a reasons (degraded entries, never silent skips) ---------------------
    na_history: "history window not yet full ({sessions} sessions on file, {needed} needed)",
    na_benchmark: "benchmark series unavailable — residual reads not computable",
    na_r2: "r² {r2} below the {floor} floor — residual reads unusable",
    na_cluster_direction: "insider cluster direction unavailable",
    na_detectors: "detector state unavailable — Tracker state not yet built",
    na_bars_lag: "latest bar {as_of} is behind the scan session {session}",
    na_no_bars: "no daily bars on file",

    // --- band card headlines (§ band) -------------------------------------------
    // One sentence over the band chart, chosen by the first rule that matches.
    // The hero is always drawn from tier one, so no headline can claim more
    // than the picture under it shows.
    band_compression_quietest: "{TICKER} is at its quietest in 90 days",
    band_compression_cluster:
      "{SECTOR} are coiling — {T1}, {T2} and {MORE} more below {THRESHOLD}",
    band_compression_single: "{TICKER} trading at {X} its normal volatility",
    band_compression_broad: "{N} names compressing — {TICKER} leads at {X}",
    band_compression_empty: "No unusual compression today",

    band_volume_flat: "{TICKER} — {N} days of heavy volume, price flat",
    band_volume_cluster: "Volume building across {SECTOR} — {T1}, {T2} and {MORE} more",
    band_volume_single: "{TICKER} turning {X} its usual volume",
    band_volume_empty: "No unusual volume today",

    band_residual_run: "{TICKER} {MOVE} on its own — {N} sessions running",
    band_residual_word_up: "pushing higher",
    band_residual_word_down: "sliding lower",
    band_residual_cluster: "Independent pressure in {SECTOR} — {T1}, {T2} and {MORE} more",
    band_residual_empty: "Nothing moving independently today",
  },


  /**
   * TICKER → the plural, spoken sector name the cluster line uses. Only the
   * tracked universe needs an entry; a name without one simply never clusters.
   */
  sectors: {
    AAPL: "Hardware names",
    AMD: "Semis",
    AMKR: "Semis",
    AVGO: "Semis",
    GFS: "Semis",
    INTC: "Semis",
    MU: "Semis",
    NVDA: "Semis",
    QCOM: "Semis",
    TSM: "Semis",
    UMC: "Semis",
    ACDC: "Energy names",
    CEG: "Utilities",
    COP: "Energy names",
    CVX: "Energy names",
    XOM: "Energy names",
    BA: "Defense names",
    GD: "Defense names",
    HON: "Defense names",
    LMT: "Defense names",
    NOC: "Defense names",
    RTX: "Defense names",
    CAT: "Industrials",
    AZN: "Pharma",
    BNTX: "Pharma",
    LLY: "Pharma",
    MRK: "Pharma",
    OPK: "Pharma",
    PFE: "Pharma",
    CAH: "Healthcare distributors",
    COR: "Healthcare distributors",
    MCK: "Healthcare distributors",
    UNH: "Insurers",
    BLK: "Financials",
    MSTR: "Financials",
    META: "Platforms",
    MSFT: "Platforms",
    PLTR: "Software names",
    SONY: "Consumer electronics",
    COST: "Retailers",
    WMT: "Retailers",
    MRT: "Biotech",
    ZLAB: "Biotech",
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function int(v: unknown, fallback: number, min = 1): number {
  return Math.max(min, Math.floor(num(v, fallback)));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

export function mergeScreenConfig(stored: DeepPartial<ScreenConfig> | null | undefined): ScreenConfig {
  const d = DEFAULT_SCREEN_CONFIG;
  if (!stored) return structuredClone(d);
  const s = stored;
  const patterns = {} as Record<ScreenPattern, ScreenPatternConfig>;
  for (const p of SCREEN_PATTERNS) {
    patterns[p] = {
      enabled: bool(s.patterns?.[p]?.enabled, d.patterns[p].enabled),
      priority: num(s.patterns?.[p]?.priority, d.patterns[p].priority),
    };
  }
  const w = s.windows ?? {};
  const t = s.thresholds ?? {};
  const labels = { ...d.labels };
  for (const p of SCREEN_PATTERNS) labels[p] = str(s.labels?.[p], d.labels[p]);
  const templates: ScreenTemplates = { ...d.templates };
  for (const [key, value] of Object.entries(s.templates ?? {})) if (typeof value === "string" && value.length > 0) templates[key] = value;
  const sectors: Record<string, string> = { ...d.sectors };
  for (const [key, value] of Object.entries(s.sectors ?? {})) {
    if (typeof value === "string" && value.length > 0) sectors[key.toUpperCase()] = value;
  }
  return {
    schemaVersion: d.schemaVersion,
    patterns,
    windows: {
      sessions: int(w.sessions, d.windows.sessions),
      volumeBaselineSessions: int(w.volumeBaselineSessions, d.windows.volumeBaselineSessions),
      compressionRangeSessions: int(w.compressionRangeSessions, d.windows.compressionRangeSessions),
      betaSessions: int(w.betaSessions, d.windows.betaSessions, 3),
      volShortSessions: int(w.volShortSessions, d.windows.volShortSessions, 2),
      volLongSessions: int(w.volLongSessions, d.windows.volLongSessions, 2),
      momentumShort: int(w.momentumShort, d.windows.momentumShort),
      momentumLong: int(w.momentumLong, d.windows.momentumLong),
      week52Sessions: int(w.week52Sessions, d.windows.week52Sessions),
    },
    thresholds: {
      quietAccumulation: {
        minQualifyingSessions: int(t.quietAccumulation?.minQualifyingSessions, d.thresholds.quietAccumulation.minQualifyingSessions),
        volumeRatioMin: num(t.quietAccumulation?.volumeRatioMin, d.thresholds.quietAccumulation.volumeRatioMin),
        momentumZMax: num(t.quietAccumulation?.momentumZMax, d.thresholds.quietAccumulation.momentumZMax),
      },
      compression: {
        volRegimeMax: num(t.compression?.volRegimeMax, d.thresholds.compression.volRegimeMax),
        rangeVolMultiple: num(t.compression?.rangeVolMultiple, d.thresholds.compression.rangeVolMultiple),
        near52wPct: num(t.compression?.near52wPct, d.thresholds.compression.near52wPct),
      },
      independentTape: {
        minQualifyingSessions: int(t.independentTape?.minQualifyingSessions, d.thresholds.independentTape.minQualifyingSessions),
        residualZMin: num(t.independentTape?.residualZMin, d.thresholds.independentTape.residualZMin),
        netResidualVolMultiple: num(t.independentTape?.netResidualVolMultiple, d.thresholds.independentTape.netResidualVolMultiple),
      },
      insiderDivergence: {
        momentumZMin: num(t.insiderDivergence?.momentumZMin, d.thresholds.insiderDivergence.momentumZMin),
      },
    },
    retentionDays: int(s.retentionDays, d.retentionDays),
    staleEndSessions: int(s.staleEndSessions, d.staleEndSessions),
    pollIntervalMs: Math.max(5_000, num(s.pollIntervalMs, d.pollIntervalMs)),
    bannedWords: Array.isArray(s.bannedWords) && s.bannedWords.every((x) => typeof x === "string") ? [...(s.bannedWords as string[])] : [...d.bannedWords],
    labels,
    templates,
    sectors,
    emit: mergeEmitConfig(s.emit, d.emit),
  };
}

function mergeEmitConfig(stored: DeepPartial<ScreenEmitConfig> | undefined, d: ScreenEmitConfig): ScreenEmitConfig {
  const s = stored ?? {};
  const priority = Array.isArray(s.priority)
    ? (s.priority as ScreenPattern[]).filter((p) => (SCREEN_PATTERNS as readonly string[]).includes(p))
    : [];
  // Any pattern the stored list forgot keeps a deterministic slot at the end.
  const complete = [...priority, ...d.priority.filter((p) => !priority.includes(p))];
  return {
    screenEmitEnabled: bool(s.screenEmitEnabled, d.screenEmitEnabled),
    dailyEmitCap: Math.max(0, Math.floor(num(s.dailyEmitCap, d.dailyEmitCap))),
    priority: complete,
  };
}



/** Patterns enabled in config, in panel priority order. */
export function enabledPatterns(config: ScreenConfig): ScreenPattern[] {
  return [...SCREEN_PATTERNS].filter((p) => config.patterns[p].enabled).sort((a, b) => config.patterns[a].priority - config.patterns[b].priority);
}
