import { DEFAULT_GAUGE_CONFIG, mergeGaugeConfig, type GaugeConfig } from "./config.js";
import type { GaugeContext, GaugeDetectorInput, GaugeInputs, GaugeNewsContext, GaugeQuantInput, GaugeScreenFinding, GaugeScreenPattern } from "./types.js";

/** Saturday 2026-08-22 23:00 UTC → NY day 2026-08-22 (no session open). */
export const NOW = "2026-08-22T23:00:00.000Z";

export function cfg(overrides?: Parameters<typeof mergeGaugeConfig>[0]): GaugeConfig {
  return overrides ? mergeGaugeConfig(overrides) : structuredClone(DEFAULT_GAUGE_CONFIG);
}

/** A calm, readable name: vol 2%/day, r² 0.4, coherent mild uptrend, normal volume, no event. */
export function quant(overrides: Partial<GaugeQuantInput> = {}): GaugeQuantInput {
  return {
    beta: 1.2,
    r2: 0.4,
    daily_vol: 0.02,
    vol_regime: 1.0,
    momentum_5d: 0.01,
    momentum_20d: 0.03,
    momentum_60d: 0.05,
    volume_ratio: 1.0,
    volume_ratio_partial: false,
    pct_from_52w_high: -0.1,
    pct_from_52w_low: 0.3,
    earnings_rhythm: 0.049,
    move_zscore: 0.2,
    residual_zscore: 0.1,
    as_of: "2026-08-21",
    ...overrides,
  };
}

export function detectors(overrides: Partial<GaugeDetectorInput> = {}): GaugeDetectorInput {
  return {
    news_burst: false,
    drift: { active: false, direction: null },
    insider_cluster: { active: false, direction: null },
    filing_overdue: false,
    unexplained_move: { active: false, direction: null },
    ...overrides,
  };
}

export function news(overrides: Partial<GaugeNewsContext> = {}): GaugeNewsContext {
  return { burst_active: false, articles: 12, event_in_window: false, lookback_sessions: 5, ...overrides };
}

/** One active Screen finding; `values` merges over the pattern defaults. */
export function finding(pattern: GaugeScreenPattern, overrides: Partial<GaugeScreenFinding> = {}): GaugeScreenFinding {
  const base: GaugeScreenFinding = {
    pattern,
    state: "continuing",
    day_count: 3,
    direction: pattern === "independent_tape" ? "up" : pattern === "insider_divergence" ? "buy" : null,
    read: `screen: ${pattern}`,
    values: {},
  };
  const defaults: Record<GaugeScreenPattern, Record<string, number | string | boolean | null>> = {
    quiet_accumulation: { sessions_qualifying: 4, avg_volume_ratio: 1.8 },
    compression: { range_ratio: 0.69, range: 0.068 },
    independent_tape: { sessions_qualifying: 4, net_residual_z: 1.4, direction: "up" },
    insider_divergence: { direction: "buy", insider_count: 3, momentum_20d: -0.09, momentum_20d_z: 1.2 },
  };
  return { ...base, ...overrides, values: { ...defaults[pattern], ...(overrides.values ?? {}) } };
}

export function inputs(overrides: Partial<GaugeInputs> = {}): GaugeInputs {
  return {
    ticker: "NVDA",
    tracked: true,
    now: NOW,
    quant: quant(),
    detectors: detectors(),
    next_earnings: null,
    incidents: [],
    r2_floor: 0.15,
    history_sessions: 300,
    screen: [],
    screen_available: true,
    news: news(),
    ...overrides,
  };
}

export function ctx(overrides: Partial<GaugeContext> = {}): GaugeContext {
  return {
    expected_direction: "up",
    event_ts: "2026-08-21T21:00:00.000Z",
    source: "manual",
    pricing_status: "open",
    sessions_since_event: 0,
    thesis_is_scheduled_event: false,
    ...overrides,
  };
}

/** A quant that reads as compressed: contracted regime, quiet volume, un-extended. */
export function coiledQuant(): GaugeQuantInput {
  return quant({ vol_regime: 0.7, volume_ratio: 0.6, momentum_20d: 0.03, daily_vol: 0.02 });
}

export function dueIn(sessions_until: number) {
  return { due_at: "2026-08-26T20:00:00.000Z", sessions_until, fiscal_period: "Q2 2027" };
}

/**
 * One inputs fixture per setup key that actually reaches that row — shared by
 * the recognition goldens and the language sweep so both cover every row.
 */
export function setupFixtures(): Record<string, GaugeInputs> {
  return {
    coiled: inputs({ quant: coiledQuant() }),
    coiled_event_ahead: inputs({ quant: coiledQuant(), next_earnings: dueIn(2) }),
    quiet_drift: inputs({ quant: quant({ volume_ratio: 0.6 }), screen: [finding("independent_tape")] }),
    confirmed_drift: inputs({ quant: quant({ volume_ratio: 1.5 }), screen: [finding("independent_tape")] }),
    accumulation: inputs({ quant: quant({ momentum_5d: 0.005 }), screen: [finding("quiet_accumulation")] }),
    move_spent: inputs({ quant: quant({ momentum_20d: 0.2, volume_ratio: 2.5 }), news: news({ event_in_window: true }) }),
    divergence: inputs({ screen: [finding("insider_divergence")] }),
    regime_break: inputs({ quant: quant({ vol_regime: 1.7 }) }),
    unreadable: inputs({ quant: quant({ r2: 0.03 }) }),
    event_wall: inputs({ next_earnings: dueIn(1) }),
    no_setup: inputs(),
  };
}
