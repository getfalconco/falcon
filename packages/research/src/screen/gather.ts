/**
 * Input gathering — turns the Tracker stores Screen may read (per-ticker
 * state with its bars + detector block, the benchmark series, the message log
 * for cluster direction / burst history, the Tracker config for the r² floor)
 * into `ScreenTickerInput`s. Electron-free so the desktop host and the replay
 * script share one path: the host feeds the live Tracker engine, the script
 * feeds the on-disk store. Read-only; nothing is fetched.
 */

import { nyYmd } from "../tracker/calendar.js";
import type { TrackerConfig } from "../tracker/config.js";
import type { TrackerEngine } from "../tracker/engine.js";
import type { TrackerStore } from "../tracker/store.js";
import type { DailyBar, InsiderClusterPayload, TickerState, TrackerMessage } from "../tracker/types.js";
import type { ScreenInsiderClusterInput, ScreenNewsBurstInput, ScreenTickerInput } from "./types.js";

/** The slice of the Tracker the engine reads. */
export type ScreenTrackerSource = {
  tickers(): string[];
  state(ticker: string): TickerState | null;
  benchmarkBars(): DailyBar[];
  messages(options?: { limit?: number; ticker?: string }): TrackerMessage[];
  trackerConfig(): TrackerConfig;
};

export function engineTrackerSource(engine: TrackerEngine): ScreenTrackerSource {
  return {
    tickers: () => engine.getStatus().tickers.map((t) => t.ticker),
    state: (ticker) => engine.getTickerState(ticker),
    benchmarkBars: () => engine.getBenchmarkBars().bars,
    messages: (options) => engine.listMessages(options),
    trackerConfig: () => engine.getConfig(),
  };
}

/** On-disk Tracker store (scripts); `tickers` comes from the state directory listing. */
export function fileTrackerSource(store: TrackerStore, listTickers: () => string[]): ScreenTrackerSource {
  return {
    tickers: listTickers,
    state: (ticker) => store.loadTickerState(ticker),
    benchmarkBars: () => store.loadBenchmarkBars().bars,
    messages: (options) => store.readMessages(options),
    trackerConfig: () => store.loadConfig(),
  };
}

export type GatheredScreen = {
  inputs: ScreenTickerInput[];
  benchBars: DailyBar[];
  /** Tracker's `thresholds.lowR2Fallback`. */
  r2Floor: number;
  /** Close-run marker per ticker (lastCloseComputedFor) — the hook fingerprint. */
  closeDay: Record<string, string | null>;
  errors: string[];
};

function ymdOf(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : nyYmd(d);
}

/** Detector inputs for one ticker from its state block + its messages (newest first). */
export function detectorInputsFromState(state: TickerState, messages: TrackerMessage[]): { news_burst: ScreenNewsBurstInput | null; insider_cluster: ScreenInsiderClusterInput | null } {
  const d = state.detectors;
  if (!d) return { news_burst: null, insider_cluster: null };
  const burstDays = new Set<string>();
  let latestCluster: InsiderClusterPayload | null = null;
  for (const m of messages) {
    if (m.type === "news_burst") {
      const day = ymdOf(m.timestamp);
      if (day) burstDays.add(day);
    } else if (m.type === "insider_cluster" && !latestCluster) {
      latestCluster = m.payload as InsiderClusterPayload;
    }
  }
  const news_burst: ScreenNewsBurstInput | null = d.newsBurst
    ? { active: Boolean(d.newsBurst.active), last_fired_at: d.newsBurst.lastFiredAt ?? null, fired_days: [...burstDays].sort() }
    : null;
  const insider_cluster: ScreenInsiderClusterInput | null = d.insiderCluster
    ? {
        active: Boolean(d.insiderCluster.active),
        direction: latestCluster?.direction === "buy" || latestCluster?.direction === "sell" ? latestCluster.direction : null,
        insider_count: latestCluster?.insider_count ?? null,
        window_business_days: latestCluster?.window_business_days ?? null,
        total_notional: typeof latestCluster?.total_notional === "number" ? latestCluster.total_notional : null,
        last_fired_at: d.insiderCluster.lastFiredAt ?? null,
      }
    : null;
  return { news_burst, insider_cluster };
}

export function gatherScreenInputs(source: ScreenTrackerSource, options?: { messageLimit?: number }): GatheredScreen {
  const errors: string[] = [];
  const inputs: ScreenTickerInput[] = [];
  const closeDay: Record<string, string | null> = {};

  let benchBars: DailyBar[] = [];
  try {
    benchBars = source.benchmarkBars();
  } catch (err) {
    errors.push(`benchmark: ${err instanceof Error ? err.message : String(err)}`);
  }

  let r2Floor = 0.15;
  try {
    r2Floor = source.trackerConfig().thresholds.lowR2Fallback;
  } catch (err) {
    errors.push(`tracker config: ${err instanceof Error ? err.message : String(err)}`);
  }

  // One pass over the message log, grouped per ticker (only the two types Screen reads).
  const byTicker = new Map<string, TrackerMessage[]>();
  try {
    for (const m of source.messages({ limit: options?.messageLimit ?? 5000 })) {
      if (m.type !== "news_burst" && m.type !== "insider_cluster") continue;
      const t = m.ticker.toUpperCase();
      const list = byTicker.get(t);
      if (list) list.push(m);
      else byTicker.set(t, [m]);
    }
  } catch (err) {
    errors.push(`messages: ${err instanceof Error ? err.message : String(err)}`);
  }

  let tickers: string[] = [];
  try {
    tickers = [...new Set(source.tickers().map((t) => t.toUpperCase()))].sort();
  } catch (err) {
    errors.push(`universe: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const ticker of tickers) {
    try {
      const state = source.state(ticker);
      closeDay[ticker] = state?.lastCloseComputedFor ?? null;
      if (!state) {
        inputs.push({ ticker, bars: [], news_burst: null, insider_cluster: null });
        continue;
      }
      const detectors = detectorInputsFromState(state, byTicker.get(ticker) ?? []);
      inputs.push({ ticker, bars: state.bars ?? [], ...detectors });
    } catch (err) {
      errors.push(`${ticker}: ${err instanceof Error ? err.message : String(err)}`);
      inputs.push({ ticker, bars: [], news_burst: null, insider_cluster: null });
    }
  }

  return { inputs, benchBars, r2Floor, closeDay, errors };
}
