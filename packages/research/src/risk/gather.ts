/**
 * Input gathering — turns the stores the Risk Engine may read (Tracker state,
 * the Propagation graph index, Base's incident replay) into `RiskInputs`.
 * Electron-free so the desktop host and the replay script share one path:
 * the host feeds the live Tracker engine, the script feeds the on-disk store.
 */

import { addDueAt, replayBase, type BaseConfig, type EarningsCalendar, type IncidentIdFactory, type VerdictLookup } from "../base/index.js";
import type { GraphIndex } from "../propagation/engine/graph.js";
import { nyYmd, tradingDaysBetween } from "../tracker/calendar.js";
import { median, robustVol, simpleReturns } from "../tracker/math.js";
import type { TrackerEngine } from "../tracker/engine.js";
import type { TrackerStore } from "../tracker/store.js";
import type { DailyBar, TickerState, TrackerMessage } from "../tracker/types.js";
import type { RiskBar } from "./sharpe.js";
import type { RiskAccountInput, RiskAnomaly, RiskInputs, RiskLiveInput, RiskOpenIncident, RiskQuantInput, RiskScheduledEarnings } from "./types.js";

/** The slice of the Tracker the engine reads. */
export type RiskTrackerSource = {
  /** Tracked universe (for the median-vol substitute). */
  tickers(): string[];
  state(ticker: string): TickerState | null;
  messages(options?: { limit?: number; ticker?: string }): TrackerMessage[];
  benchmarkBars(): DailyBar[];
};

export function engineTrackerSource(engine: TrackerEngine): RiskTrackerSource {
  return {
    tickers: () => engine.getStatus().tickers.map((t) => t.ticker),
    state: (ticker) => engine.getTickerState(ticker),
    messages: (options) => engine.listMessages(options),
    benchmarkBars: () => engine.getBenchmarkBars().bars,
  };
}

/** On-disk Tracker store (scripts); `tickers` comes from the state directory listing. */
export function fileTrackerSource(store: TrackerStore, listTickers: () => string[]): RiskTrackerSource {
  return {
    tickers: listTickers,
    state: (ticker) => store.loadTickerState(ticker),
    messages: (options) => store.readMessages(options),
    benchmarkBars: () => store.loadBenchmarkBars().bars,
  };
}

export type GatherRiskDeps = {
  tracker: RiskTrackerSource;
  graph: GraphIndex | null;
  baseConfig: BaseConfig;
  verdictLookup?: VerdictLookup;
  makeIncidentId?: IncidentIdFactory;
  /** Messages fed to the Base replay (newest first from the store). */
  replayLimit?: number;
  /** Robust-vol window for the benchmark (matches Tracker's volShortDays). */
  volWindow?: number;
  /** Sessions of closes to carry per held ticker for §3.6 (default 90). */
  sharpeWindow?: number;
};

export type GatheredRisk = {
  inputs: RiskInputs;
  held: string[];
  /** Close-run marker per held ticker (quantAsOf, else lastCloseComputedFor). */
  closeDay: Record<string, string | null>;
  /** Non-fatal problems met while gathering (the snapshot still computes). */
  errors: string[];
};

export function heldTickersOf(account: RiskAccountInput | null): string[] {
  return [...new Set((account?.positions ?? []).filter((p) => Math.abs(p.shares) > 1e-9).map((p) => p.ticker.trim().toUpperCase()))].sort();
}

export function quantFromState(state: TickerState | null): RiskQuantInput | null {
  if (!state) return null;
  const q = state.quant ?? null;
  const lastBar = state.bars?.length ? state.bars[state.bars.length - 1] : null;
  return {
    beta: q?.beta_90d ?? null,
    r2: q?.r_squared ?? null,
    daily_vol: q?.daily_vol_30d ?? null,
    earnings_rhythm: q?.earnings_rhythm ?? null,
    last_price: q?.last_price ?? lastBar?.c ?? null,
  };
}

/** Anomaly states for one held ticker from its detector block (+ the latest cluster message for direction). */
export function anomaliesFromState(state: TickerState, latestCluster: TrackerMessage | undefined): RiskAnomaly[] {
  const out: RiskAnomaly[] = [];
  const ticker = state.ticker.toUpperCase();
  const d = state.detectors;
  if (!d) return out;
  if (d.insiderCluster?.active) {
    const direction = latestCluster && latestCluster.payload && "direction" in latestCluster.payload ? (latestCluster.payload as { direction?: string }).direction : undefined;
    if (direction === "sell") out.push({ ticker, kind: "insider_cluster" });
  }
  if (d.drift?.active) out.push({ ticker, kind: "drift" });
  if (d.filingOverdue?.active) out.push({ ticker, kind: "filing_overdue" });
  // unexplained_move is a snapshot detector: "active" = fired on the last close-run day.
  if (d.unexplained?.lastFiredDay && state.lastCloseComputedFor && d.unexplained.lastFiredDay === state.lastCloseComputedFor) {
    out.push({ ticker, kind: "unexplained_move" });
  }
  return out;
}

/** Confirmed scheduled earnings with trading sessions until due (−1 when already past). */
export function earningsFromState(state: TickerState, todayYmd: string): RiskScheduledEarnings[] {
  const out: RiskScheduledEarnings[] = [];
  for (const s of state.scheduledEarnings ?? []) {
    if (!s.confirmed) continue;
    const due = new Date(s.dueAt);
    if (Number.isNaN(due.getTime())) continue;
    const dueYmd = nyYmd(due);
    const sessions = dueYmd < todayYmd ? -1 : tradingDaysBetween(todayYmd, dueYmd);
    out.push({ ticker: state.ticker.toUpperCase(), due_at: s.dueAt, sessions_until: sessions, fiscal_period: s.fiscalPeriod ?? null });
  }
  return out;
}

export function gatherRiskInputs(account: RiskAccountInput, now: string, deps: GatherRiskDeps): GatheredRisk {
  const errors: string[] = [];
  const held = heldTickersOf(account);
  const quant: Record<string, RiskQuantInput | null> = {};
  const closeDay: Record<string, string | null> = {};
  const bars: Record<string, RiskBar[]> = {};
  const states = new Map<string, TickerState | null>();
  // One session more than the Sharpe window: n returns need n + 1 closes.
  const barsWanted = (deps.sharpeWindow ?? 90) + 1;
  for (const t of held) {
    const state = deps.tracker.state(t);
    states.set(t, state);
    quant[t] = quantFromState(state);
    closeDay[t] = state?.quantAsOf ?? state?.lastCloseComputedFor ?? null;
    const series = state?.bars ?? [];
    if (series.length > 0) {
      bars[t] = series.slice(Math.max(0, series.length - barsWanted)).map((b) => ({ d: b.d, c: b.c }));
    }
  }

  let spyVol: number | null = null;
  try {
    spyVol = robustVol(simpleReturns(deps.tracker.benchmarkBars().map((b) => b.c)), deps.volWindow ?? 30);
  } catch (err) {
    errors.push(`benchmark: ${err instanceof Error ? err.message : String(err)}`);
  }

  const vols: number[] = [];
  try {
    for (const t of deps.tracker.tickers()) {
      const v = deps.tracker.state(t)?.quant?.daily_vol_30d;
      if (v != null && Number.isFinite(v)) vols.push(v);
    }
  } catch (err) {
    errors.push(`universe: ${err instanceof Error ? err.message : String(err)}`);
  }

  const live: RiskLiveInput = { open_incidents: [], anomalies: [], earnings: [] };
  if (held.length > 0) {
    // Incidents — the same replay the Analyst/Propagation hosts run, plus the B8 held context.
    try {
      const messages = deps.tracker.messages({ limit: deps.replayLimit ?? 1000 });
      const earningsCalendar: EarningsCalendar = new Map();
      for (const t of deps.tracker.tickers()) {
        const state = deps.tracker.state(t);
        for (const s of state?.scheduledEarnings ?? []) if (s.confirmed) addDueAt(earningsCalendar, t, s.dueAt);
      }
      const replay = replayBase(messages, {
        config: deps.baseConfig,
        now,
        userContext: { held, watchlist: [] },
        verdictLookup: deps.verdictLookup,
        earningsCalendar,
        makeIncidentId: deps.makeIncidentId,
      });
      const heldSet = new Set(held);
      const incidents: RiskOpenIncident[] = [];
      for (const r of replay.incidents) {
        const inc = r.incident;
        if (inc.window_status !== "open" || !heldSet.has(inc.ticker.toUpperCase())) continue;
        incidents.push({ ticker: inc.ticker.toUpperCase(), band: inc.priority_band, incident_id: inc.incident_id });
      }
      live.open_incidents = incidents;
    } catch (err) {
      errors.push(`replay: ${err instanceof Error ? err.message : String(err)}`);
    }

    const today = nyYmd(new Date(now));
    for (const t of held) {
      const state = states.get(t) ?? null;
      if (!state) continue;
      let latestCluster: TrackerMessage | undefined;
      if (state.detectors?.insiderCluster?.active) {
        try {
          latestCluster = deps.tracker.messages({ ticker: t, limit: 100 }).find((m) => m.type === "insider_cluster");
        } catch (err) {
          errors.push(`messages(${t}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      live.anomalies.push(...anomaliesFromState(state, latestCluster));
      live.earnings.push(...earningsFromState(state, today));
    }
  }

  return {
    inputs: {
      now,
      account,
      quant,
      spy_daily_vol: spyVol,
      universe_median_vol: median(vols),
      graph: deps.graph,
      live,
      bars,
    },
    held,
    closeDay,
    errors,
  };
}
