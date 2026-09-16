/**
 * Input gathering — plucks one ticker's `GaugeInputs` out of the stores Gauge
 * may read: Tracker state (quant, detectors, the T5 earnings ledger), the
 * Tracker config (r² floor — one place), and Base's incident replay for open
 * incidents (context mode only; standalone never runs the replay). Electron-
 * free so the desktop host and the replay script share one path. Zero new
 * data: everything here is already on disk.
 */

import { addDueAt, replayBase, type BaseConfig, type EarningsCalendar, type IncidentIdFactory, type VerdictLookup } from "../base/index.js";
import type { RiskTrackerSource } from "../risk/gather.js";
import { addTradingDays, nyYmd, tradingDaysBetween } from "../tracker/calendar.js";
import type { TrackerConfig } from "../tracker/config.js";
import type { TickerState, TrackerMessage } from "../tracker/types.js";
import type {
  GaugeDetectorInput,
  GaugeEarningsInput,
  GaugeIncidentInput,
  GaugeInputs,
  GaugeNewsContext,
  GaugeQuantInput,
  GaugeScreenFinding,
  GaugeScreenPattern,
  GaugeValue,
} from "./types.js";

export type { RiskTrackerSource as GaugeTrackerSource } from "../risk/gather.js";
export { engineTrackerSource, fileTrackerSource } from "../risk/gather.js";

/**
 * The slice of Screen the setup layer reads (§4). One-way and read-only:
 * Gauge never writes a finding. `null` means Screen was not consulted or could
 * not be read — the setup pool narrows honestly rather than pretending.
 */
export type GaugeScreenSource = {
  /** Active (non-ended) findings for one ticker. */
  active(ticker: string): GaugeScreenFinding[];
};

const SCREEN_PATTERNS: readonly GaugeScreenPattern[] = ["quiet_accumulation", "compression", "independent_tape", "insider_divergence"];

type RawScreenFinding = {
  ticker: string;
  pattern: string;
  state: string;
  day_count: number;
  read: string;
  values: Record<string, unknown>;
  ended_at: string | null;
};

/**
 * Adapter over anything shaped like Screen's findings store — the desktop host
 * passes `getScreenHost().findings().active`, the replay script passes
 * `activeFindings(store.load(), config)`. Kept structural so this module never
 * imports the Screen engine itself.
 */
export function screenSourceFrom(findings: () => RawScreenFinding[]): GaugeScreenSource {
  return {
    active(ticker) {
      const symbol = ticker.trim().toUpperCase();
      const out: GaugeScreenFinding[] = [];
      for (const f of findings()) {
        if (!f || f.ended_at != null) continue;
        if ((f.ticker ?? "").toUpperCase() !== symbol) continue;
        if (!SCREEN_PATTERNS.includes(f.pattern as GaugeScreenPattern)) continue;
        const raw = (f.values ?? {}) as Record<string, unknown>;
        const dir = raw.direction;
        const values: Record<string, GaugeValue> = {};
        for (const [k, val] of Object.entries(raw)) {
          if (val == null || typeof val === "number" || typeof val === "string" || typeof val === "boolean") values[k] = (val ?? null) as GaugeValue;
        }
        out.push({
          pattern: f.pattern as GaugeScreenPattern,
          state: f.state === "new" ? "new" : "continuing",
          day_count: Number.isFinite(f.day_count) ? f.day_count : 0,
          direction: dir === "up" || dir === "down" || dir === "buy" || dir === "sell" ? dir : null,
          read: typeof f.read === "string" ? f.read : "",
          values,
        });
      }
      return out;
    },
  };
}

export type GatherGaugeDeps = {
  tracker: RiskTrackerSource;
  /** Tracker config — the r² floor is `thresholds.lowR2Fallback`. */
  trackerConfig: Pick<TrackerConfig, "thresholds">;
  /** §4 Screen findings; omit when Screen is unavailable (the pool narrows). */
  screen?: GaugeScreenSource | null;
  /** Lookback for the news/event gates, in trading sessions. */
  newsLookbackSessions?: number;
  /** Base replay inputs; only used when `includeIncidents` is set. */
  baseConfig?: BaseConfig;
  verdictLookup?: VerdictLookup;
  makeIncidentId?: IncidentIdFactory;
  replayLimit?: number;
  /** Run the Base replay for open incidents (context mode). Default false. */
  includeIncidents?: boolean;
};

export type GatheredGauge = {
  inputs: GaugeInputs;
  /** Non-fatal problems met while gathering (the readout still computes). */
  errors: string[];
};

export function quantFromState(state: TickerState): GaugeQuantInput | null {
  const q = state.quant;
  if (!q) return null;
  return {
    beta: q.beta_90d ?? null,
    r2: q.r_squared ?? null,
    daily_vol: q.daily_vol_30d ?? null,
    vol_regime: q.vol_regime ?? null,
    momentum_5d: q.momentum_5d ?? null,
    momentum_20d: q.momentum_20d ?? null,
    momentum_60d: q.momentum_60d ?? null,
    volume_ratio: q.volume_ratio ?? null,
    volume_ratio_partial: Boolean(q.volume_ratio_partial),
    pct_from_52w_high: q.pct_from_52w_high ?? null,
    pct_from_52w_low: q.pct_from_52w_low ?? null,
    earnings_rhythm: q.earnings_rhythm ?? null,
    move_zscore: q.move_zscore ?? null,
    residual_zscore: q.residual_zscore ?? null,
    as_of: state.quantAsOf ?? null,
  };
}

function latestOf(messages: TrackerMessage[], type: TrackerMessage["type"]): TrackerMessage | undefined {
  return messages.find((m) => m.type === type);
}

function payloadDirection(m: TrackerMessage | undefined): string | null {
  if (!m || !m.payload || typeof m.payload !== "object" || !("direction" in m.payload)) return null;
  const d = (m.payload as { direction?: unknown }).direction;
  return typeof d === "string" ? d : null;
}

/**
 * Detector states from the state block, directions from the latest message
 * of each type (the state block has no direction). `messages` is the
 * ticker's stream newest-first; pass [] when none is loaded.
 */
export function detectorsFromState(state: TickerState, messages: TrackerMessage[]): GaugeDetectorInput | null {
  const d = state.detectors;
  if (!d) return null;
  const unexplainedActive = Boolean(d.unexplained?.lastFiredDay && state.lastCloseComputedFor && d.unexplained.lastFiredDay === state.lastCloseComputedFor);
  const insiderDir = d.insiderCluster?.active ? payloadDirection(latestOf(messages, "insider_cluster")) : null;
  const driftDir = d.drift?.active ? payloadDirection(latestOf(messages, "drift_event")) : null;
  const unexplainedDir = unexplainedActive ? payloadDirection(latestOf(messages, "unexplained_move")) : null;
  return {
    news_burst: Boolean(d.newsBurst?.active),
    drift: { active: Boolean(d.drift?.active), direction: driftDir === "up" || driftDir === "down" ? driftDir : null },
    insider_cluster: { active: Boolean(d.insiderCluster?.active), direction: insiderDir === "buy" || insiderDir === "sell" ? insiderDir : null },
    filing_overdue: Boolean(d.filingOverdue?.active),
    unexplained_move: { active: unexplainedActive, direction: unexplainedDir === "up" || unexplainedDir === "down" ? unexplainedDir : null },
  };
}

/** Nearest confirmed upcoming earnings from the T5 ledger (sessions until due; past dates ignored). */
export function nextEarningsFromState(state: TickerState, todayYmd: string): GaugeEarningsInput | null {
  let best: GaugeEarningsInput | null = null;
  for (const s of state.scheduledEarnings ?? []) {
    if (!s.confirmed) continue;
    const due = new Date(s.dueAt);
    if (Number.isNaN(due.getTime())) continue;
    const dueYmd = nyYmd(due);
    if (dueYmd < todayYmd) continue;
    const sessions = tradingDaysBetween(todayYmd, dueYmd);
    if (!best || sessions < best.sessions_until) best = { due_at: s.dueAt, sessions_until: sessions, fiscal_period: s.fiscalPeriod ?? null };
  }
  return best;
}

/**
 * v2 news/event context over the last `lookback` trading sessions. The gates
 * read `burst_active` and `event_in_window`; `articles` is carried for the
 * panel only. A raw-count gate is deliberately not offered: the universe runs
 * ~6 articles/ticker/day, so "no news" would never be true (Tracker T6).
 */
export function newsContextFromState(state: TickerState, todayYmd: string, lookback: number): GaugeNewsContext {
  const windowStart = addTradingDays(todayYmd, -Math.max(1, lookback));
  let articles = 0;
  for (const [day, count] of Object.entries(state.newsCounts ?? {})) {
    if (day >= windowStart && day <= todayYmd && Number.isFinite(count)) articles += count;
  }
  const d = state.detectors;
  const firedInWindow = (day: string | null | undefined) => Boolean(day && day >= windowStart && day <= todayYmd);
  const gapInWindow = firedInWindow(d?.gap?.lastFiredDay);
  const unexplainedInWindow = firedInWindow(d?.unexplained?.lastFiredDay);
  const scheduledInWindow = (state.earnings ?? []).some((e) => e.date >= windowStart && e.date <= todayYmd);
  return {
    burst_active: Boolean(d?.newsBurst?.active),
    articles,
    event_in_window: gapInWindow || unexplainedInWindow || scheduledInWindow,
    lookback_sessions: lookback,
  };
}

const EMPTY_NEWS: GaugeNewsContext = { burst_active: false, articles: 0, event_in_window: false, lookback_sessions: 0 };

export function gatherGaugeInputs(ticker: string, now: string, deps: GatherGaugeDeps): GatheredGauge {
  const errors: string[] = [];
  const symbol = ticker.trim().toUpperCase();
  const r2Floor = deps.trackerConfig.thresholds.lowR2Fallback;
  const state = deps.tracker.state(symbol);
  if (!state) {
    return {
      inputs: {
        ticker: symbol,
        tracked: false,
        now,
        quant: null,
        detectors: null,
        next_earnings: null,
        incidents: [],
        r2_floor: r2Floor,
        history_sessions: null,
        screen: [],
        screen_available: Boolean(deps.screen),
        news: EMPTY_NEWS,
      },
      errors,
    };
  }

  let messages: TrackerMessage[] = [];
  const needsDirection = Boolean(state.detectors?.insiderCluster?.active || state.detectors?.drift?.active || state.detectors?.unexplained?.lastFiredDay);
  if (needsDirection) {
    try {
      messages = deps.tracker.messages({ ticker: symbol, limit: 200 });
    } catch (err) {
      errors.push(`messages(${symbol}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const incidents: GaugeIncidentInput[] = [];
  if (deps.includeIncidents && deps.baseConfig) {
    try {
      const all = deps.tracker.messages({ limit: deps.replayLimit ?? 1000 });
      const earningsCalendar: EarningsCalendar = new Map();
      for (const t of deps.tracker.tickers()) {
        const s = deps.tracker.state(t);
        for (const e of s?.scheduledEarnings ?? []) if (e.confirmed) addDueAt(earningsCalendar, t, e.dueAt);
      }
      const replay = replayBase(all, {
        config: deps.baseConfig,
        now,
        userContext: { held: [], watchlist: [] },
        verdictLookup: deps.verdictLookup,
        earningsCalendar,
        makeIncidentId: deps.makeIncidentId,
      });
      for (const r of replay.incidents) {
        const inc = r.incident;
        if (inc.window_status !== "open" || inc.ticker.toUpperCase() !== symbol) continue;
        incidents.push({ incident_id: inc.incident_id, band: inc.priority_band, tags: [...inc.composite_tags] });
      }
    } catch (err) {
      errors.push(`replay: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let screen: GaugeScreenFinding[] = [];
  let screenAvailable = false;
  if (deps.screen) {
    try {
      screen = deps.screen.active(symbol);
      screenAvailable = true;
    } catch (err) {
      errors.push(`screen(${symbol}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const today = nyYmd(new Date(now));
  return {
    inputs: {
      ticker: symbol,
      tracked: true,
      now,
      quant: quantFromState(state),
      detectors: detectorsFromState(state, messages),
      next_earnings: nextEarningsFromState(state, today),
      incidents,
      r2_floor: r2Floor,
      history_sessions: Array.isArray(state.bars) ? state.bars.length : null,
      screen,
      screen_available: screenAvailable,
      news: newsContextFromState(state, today, deps.newsLookbackSessions ?? 5),
    },
    errors,
  };
}
