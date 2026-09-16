/**
 * Live signal ledger (§8).
 *
 * A forward, out-of-sample-by-construction record. After a few months this is
 * the only performance evidence in the system that CANNOT be overfit — nobody
 * can rerun it with a different threshold — and it is worth more than any
 * backtest.
 *
 * It records what the rule said and what happened. Nothing else: no orders, no
 * sizing, no execution, no advice.
 *
 * Enabling is gated. A strategy with no out-of-sample result, or with fewer
 * signals than the floor, cannot be enabled — otherwise the ledger fills up
 * with rules nobody ever measured, and its one virtue (that its contents were
 * committed to in advance) is gone.
 */

import type { QuantLabConfig } from "./config.js";
import type { TradingCalendar } from "./calendar.js";
import { computeHorizonReturn, resolveWindow, type ReturnContext } from "./returns.js";
import { generateSignals, type SignalGenDeps } from "./signals.js";
import { snapshotAt } from "./series.js";
import type { BacktestReport, LiveSignal, Strategy } from "./types.js";

export type EnableDecision = { ok: true } | { ok: false; reason: string };

/**
 * Whether a strategy may be enabled for live evaluation.
 *
 * Reads the strategy's OWN version's reports. A v4 cannot inherit v2's
 * out-of-sample evidence: it is a different rule, and letting it borrow the
 * result would make the gate meaningless the moment anyone edited a threshold.
 */
export function canEnable(
  strategy: Strategy,
  reports: BacktestReport[],
  config: QuantLabConfig,
): EnableDecision {
  const own = reports.filter(
    (r) => r.strategy_id === strategy.strategy_id && r.strategy_version === strategy.version,
  );
  if (own.length === 0) {
    return {
      ok: false,
      reason: `no backtest has been run for ${strategy.strategy_id} v${strategy.version} — an out-of-sample result is required before live evaluation`,
    };
  }
  const best = own.reduce((a, r) => (bestOosN(r) > bestOosN(a) ? r : a));
  const n = bestOosN(best);
  if (n === 0) {
    return { ok: false, reason: "the backtest produced no out-of-sample signals — nothing has been tested forward" };
  }
  if (n < config.backtest.minSignals) {
    return {
      ok: false,
      reason: `out-of-sample n=${n}, below the ${config.backtest.minSignals}-signal floor — not enough evidence to justify tracking it live`,
    };
  }
  return { ok: true };
}

function bestOosN(report: BacktestReport): number {
  return Math.max(0, ...report.out_of_sample.horizons.map((h) => h.n));
}

/** Deterministic id, so re-evaluating a session never duplicates a signal. */
export function liveSignalId(strategy: Strategy, ticker: string, session: string): string {
  return `${strategy.strategy_id}:${strategy.version}:${ticker}:${session}`;
}

export type EvaluateLiveDeps = Omit<SignalGenDeps, "from" | "to"> & {
  session: string;
  now: string;
  /**
   * Set when `session` is not the latest close — the row is a replay and is
   * marked as such rather than passed off as a forward record.
   */
  backfilled?: boolean;
};

/**
 * Evaluates one enabled strategy on one session and returns the live signals it
 * produced, with forward returns left empty for the fill pass.
 */
export function evaluateLive(deps: EvaluateLiveDeps): LiveSignal[] {
  const generated = generateSignals({ ...deps, from: deps.session, to: deps.session });
  return generated.signals.map((signal) => ({
    id: liveSignalId(deps.strategy, signal.ticker, signal.session),
    strategy_id: deps.strategy.strategy_id,
    strategy_version: deps.strategy.version,
    ticker: signal.ticker,
    session: signal.session,
    entry_session: signal.entry_session,
    entry_price: signal.entry_price,
    sign: signal.sign,
    sector: signal.sector,
    reason: signal.reason,
    recorded_at: deps.now,
    // Forward returns are unknowable now by definition; the fill pass supplies
    // them as each horizon matures.
    returns: deps.strategy.hold.sessions.map((sessions) => ({
      sessions,
      exit_session: null,
      exit_price: null,
      raw: null,
      market_adjusted: null,
      sector_relative: null,
      degraded: ["pending"],
    })),
    complete: false,
    backfilled: deps.backfilled ?? false,
  }));
}

/**
 * Forward-only rows — the ones that actually constitute out-of-sample
 * evidence. Any scoring of the ledger must run on these.
 */
export function forwardSignals(signals: LiveSignal[]): LiveSignal[] {
  return signals.filter((s) => !s.backfilled);
}

export type FillDeps = {
  ctx: ReturnContext;
  calendar: TradingCalendar;
  strategiesById: Map<string, Strategy>;
};

/**
 * Fills realised returns for every horizon that has now matured.
 *
 * Idempotent: a horizon already carrying a return is left untouched, so the
 * sweep can run on every close without rewriting history. A horizon whose exit
 * session has not arrived stays pending.
 */
export function fillForwardReturns(signals: LiveSignal[], deps: FillDeps): { updated: LiveSignal[]; filled: number } {
  let filled = 0;
  const updated = signals.map((signal) => {
    if (signal.complete) return signal;
    const strategy = deps.strategiesById.get(`${signal.strategy_id}:${signal.strategy_version}`);
    const when = strategy?.entry.when ?? "signal_close";
    const series = deps.ctx.seriesByTicker.get(signal.ticker);
    if (!series) return signal;
    const signalSnap = snapshotAt(series, signal.session);

    const returns = signal.returns.map((ret) => {
      if (ret.raw != null) return ret;
      const window = resolveWindow(deps.calendar, signal.session, when, ret.sessions);
      // The horizon has not matured yet, or the exit session has not printed.
      if (!window?.exit || !snapshotAt(series, window.exit)) return ret;
      const computed = computeHorizonReturn(deps.ctx, {
        ticker: signal.ticker,
        window,
        holdSessions: ret.sessions,
        sign: signal.sign,
        beta: signalSnap?.beta ?? null,
      });
      if (computed.raw == null) return ret;
      filled++;
      return computed;
    });

    return { ...signal, returns, complete: returns.every((r) => r.raw != null) };
  });
  return { updated, filled };
}

/** Ledger rows for one strategy family, newest first. */
export function forStrategy(signals: LiveSignal[], strategyId: string): LiveSignal[] {
  return signals
    .filter((s) => s.strategy_id === strategyId)
    .sort((a, b) => b.session.localeCompare(a.session) || a.ticker.localeCompare(b.ticker));
}

/** Signals whose every horizon has resolved — the only ones worth scoring. */
export function completeSignals(signals: LiveSignal[]): LiveSignal[] {
  return signals.filter((s) => s.complete);
}
