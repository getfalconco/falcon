/**
 * The daily batch (spec §5): evaluate every enabled pattern × every tracked
 * ticker for one completed session, fold the evaluations through the
 * lifecycle reducer, record the scan. Pure over its inputs — the store and the
 * close-run hook live around it (store.ts, hook.ts).
 */

import type { DailyBar } from "../tracker/types.js";
import { enabledPatterns, type ScreenConfig } from "./config.js";
import { applyEvaluations, pruneState } from "./lifecycle.js";
import { evaluatePattern, type PatternContext } from "./patterns.js";
import { buildSeriesView } from "./series.js";
import { fill } from "./templates.js";
import {
  SCREEN_SCHEMA_VERSION,
  type ScreenDegraded,
  type ScreenEvaluation,
  type ScreenScan,
  type ScreenScanTrigger,
  type ScreenSeriesView,
  type ScreenStoreState,
  type ScreenTickerInput,
} from "./types.js";

export type ScanInput = {
  /** Completed trading session the scan describes (bars after it are ignored). */
  session: string;
  /** Wall-clock instant of the scan (ISO). */
  now: string;
  trigger: ScreenScanTrigger;
  inputs: ScreenTickerInput[];
  benchBars: DailyBar[];
  r2Floor: number;
  config: ScreenConfig;
  state: ScreenStoreState;
  /** Non-fatal gathering errors to carry on the scan record. */
  errors?: string[];
};

export type ScanResult = {
  scan: ScreenScan;
  state: ScreenStoreState;
  evaluations: ScreenEvaluation[];
  views: Record<string, ScreenSeriesView>;
};

/** Evaluate one ticker: its series view + one evaluation per enabled pattern (all n_a when bars lag the session). */
export function evaluateTicker(input: ScreenTickerInput, benchBars: DailyBar[], session: string, config: ScreenConfig, r2Floor: number): { view: ScreenSeriesView; evaluations: ScreenEvaluation[]; degraded: ScreenDegraded[] } {
  const view = buildSeriesView({ ticker: input.ticker, bars: input.bars, benchBars, session, windows: config.windows });
  const ctx: PatternContext = { session, config, r2Floor, news_burst: input.news_burst, insider_cluster: input.insider_cluster };
  const degraded: ScreenDegraded[] = [];
  const patterns = enabledPatterns(config);

  let blanket: string | null = null;
  if (view.as_of == null) blanket = fill(config.templates, "na_no_bars");
  else if (view.as_of < session) blanket = fill(config.templates, "na_bars_lag", { as_of: view.as_of, session });

  if (blanket) {
    degraded.push({ ticker: input.ticker, pattern: "all", reason: blanket, history_sessions: view.history_sessions });
    const evaluations = patterns.map<ScreenEvaluation>((pattern) => ({
      ticker: input.ticker,
      pattern,
      session,
      status: "n_a",
      na_reason: blanket,
      values: { history_sessions: view.history_sessions, as_of: view.as_of },
      modifiers: [],
      qualifying_sessions: [],
      sessions_view: view.sessions,
      read: null,
    }));
    return { view, evaluations, degraded };
  }

  const evaluations = patterns.map((pattern) => evaluatePattern(pattern, view, ctx));
  for (const e of evaluations) {
    if (e.status === "n_a") degraded.push({ ticker: input.ticker, pattern: e.pattern, reason: e.na_reason ?? "not evaluable", history_sessions: view.history_sessions });
  }
  return { view, evaluations, degraded };
}

export function runScreenScan(input: ScanInput): ScanResult {
  const { session, config } = input;
  const evaluations: ScreenEvaluation[] = [];
  const degraded: ScreenDegraded[] = [];
  const views: Record<string, ScreenSeriesView> = {};
  const errors = [...(input.errors ?? [])];
  let scanned = 0;

  const tickers = [...new Set(input.inputs.map((i) => i.ticker.toUpperCase()))];
  for (const tickerInput of input.inputs) {
    try {
      const result = evaluateTicker({ ...tickerInput, ticker: tickerInput.ticker.toUpperCase() }, input.benchBars, session, config, input.r2Floor);
      views[result.view.ticker] = result.view;
      evaluations.push(...result.evaluations);
      degraded.push(...result.degraded);
      scanned++;
    } catch (err) {
      errors.push(`${tickerInput.ticker}: ${err instanceof Error ? err.message : String(err)}`);
      degraded.push({ ticker: tickerInput.ticker.toUpperCase(), pattern: "all", reason: `evaluation error: ${err instanceof Error ? err.message : String(err)}`, history_sessions: null });
    }
  }

  const lifecycle = applyEvaluations({ state: input.state, evaluations, session, universe: tickers, config });
  const scan: ScreenScan = {
    schema_version: SCREEN_SCHEMA_VERSION,
    session,
    scanned_at: input.now,
    trigger: input.trigger,
    tickers_scanned: scanned,
    tickers_total: input.inputs.length,
    evaluations: evaluations.length,
    new: lifecycle.new,
    continuing: lifecycle.continuing,
    ended: lifecycle.ended,
    degraded,
    errors,
  };
  // One scan record per session: a re-run replaces the earlier record (idempotent).
  const scans = [...lifecycle.state.scans.filter((s) => s.session !== session), scan].sort((a, b) => a.session.localeCompare(b.session));
  const nowYmd = input.now.slice(0, 10);
  const state = pruneState({ ...lifecycle.state, scans }, nowYmd, config.retentionDays);
  return { scan, state, evaluations, views };
}
