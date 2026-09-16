/**
 * Quant Lab host — the main-process side of the Shift+Q developer surface.
 *
 * Unlike the other engine hosts this one has NO loop. Quant Lab does nothing
 * on a timer except the live-ledger sweep; a backtest runs only when someone
 * asks for one, because every stored run increments the family's variant
 * counter and a background process quietly inflating that number would corrupt
 * the one guard that measures how much searching happened.
 *
 * The backtest environment (76 series, the graph, the filing history) is
 * cached: it is identical between runs and expensive to build.
 */

import { BrowserWindow } from "electron";
import {
  canEnable,
  evaluateLive,
  fillForwardReturns,
  isBacktestable,
  loadEnvironment,
  missingSeeds,
  runBacktest,
  unavailableComponents,
  validateStrategy,
  LedgerStore,
  QuantLabConfigStore,
  ResultStore,
  SeriesStore,
  StrategyStore,
  type BacktestEnvironment,
} from "@meridian/research/quantlab";
import type {
  BacktestReport,
  LiveSignal,
  QuantLabStatus,
  Strategy,
  StrategyRow,
} from "../../shared/quantlab-types";

export class QuantLabHost {
  readonly configStore = new QuantLabConfigStore();
  readonly seriesStore = new SeriesStore();
  readonly strategyStore = new StrategyStore();
  readonly resultStore = new ResultStore();
  readonly ledgerStore = new LedgerStore();

  private env: BacktestEnvironment | null = null;
  private lastError: string | null = null;
  private running = false;

  /** Seeds the §9 library once, so a fresh install has something to test. */
  start(): void {
    try {
      const existing = new Set(this.strategyStore.all().map((s) => s.strategy_id));
      for (const strategy of missingSeeds(existing)) {
        if (validateStrategy(strategy).ok) this.strategyStore.append(strategy);
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * The cached environment. Rebuilt on demand — a backfill written while the
   * app is open would otherwise stay invisible until a restart.
   */
  private environment(force = false): BacktestEnvironment {
    if (!this.env || force) this.env = loadEnvironment();
    return this.env;
  }

  reload(): void {
    this.env = null;
    this.strategyStore.reload();
  }

  status(): QuantLabStatus {
    const config = this.configStore.load();
    const coverage = this.seriesStore.coverage();
    const withData = coverage.filter((c) => c.sessions > 0);
    const from = withData.map((c) => c.from).filter((d): d is string => d != null).sort()[0] ?? null;
    const to = withData.map((c) => c.to).filter((d): d is string => d != null).sort().pop() ?? null;
    return {
      dataDir: this.configStore.dataDir,
      configFile: this.configStore.configFile,
      seriesDir: this.seriesStore.seriesDir,
      strategiesFile: this.strategyStore.file,
      ledgerFile: this.ledgerStore.file,
      seriesCount: coverage.length,
      seriesFrom: from,
      seriesTo: to,
      benchmark: config.data.benchmark,
      universeSize: Math.max(0, coverage.length - 1),
      strategyCount: this.strategyStore.heads().length,
      reportCount: this.resultStore.list().length,
      ledgerCount: this.ledgerStore.read().length,
      lastError: this.lastError,
      running: this.running,
    };
  }

  /** Every strategy family with the context the builder shows beside it. */
  strategies(): StrategyRow[] {
    const config = this.configStore.load();
    const reports = this.resultStore.list();
    return this.strategyStore.heads().map((strategy) => {
      const enable = canEnable(strategy as never, reports as never, config);
      return {
        strategy: strategy as unknown as Strategy,
        runs: reports.filter((r) => r.strategy_id === strategy.strategy_id).length,
        unavailable: unavailableComponents(strategy, config.unavailableHistorically),
        backtestable: isBacktestable(strategy, config.unavailableHistorically),
        enable_blocked_reason: enable.ok ? null : enable.reason,
        versions: this.strategyStore.versions(strategy.strategy_id).map((s) => s.version),
      };
    });
  }

  reports(strategyId?: string): BacktestReport[] {
    const all = this.resultStore.list() as unknown as BacktestReport[];
    return strategyId ? all.filter((r) => r.strategy_id === strategyId) : all;
  }

  report(reportId: string): BacktestReport | null {
    return this.resultStore.load(reportId) as unknown as BacktestReport | null;
  }

  /**
   * Runs and stores a backtest. Storing is the point — an unstored run would
   * not increment the variant counter, and the counter is a guard.
   */
  backtest(strategyId: string, options: { from?: string; to?: string } = {}): BacktestReport {
    this.running = true;
    try {
      const strategy = this.strategyStore.latest(strategyId);
      if (!strategy) throw new Error(`unknown strategy ${strategyId}`);
      const env = this.environment();
      const variantNumber = this.resultStore.nextVariantNumber(strategyId);
      const report = runBacktest(strategy, env, { ...options, variantNumber });
      this.resultStore.save(report);
      this.lastError = null;
      this.broadcast("quantlab:backtest", { strategy_id: strategyId, state: "done", message: report.verdict });
      return report as unknown as BacktestReport;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.broadcast("quantlab:backtest", { strategy_id: strategyId, state: "error", message: this.lastError });
      throw err;
    } finally {
      this.running = false;
    }
  }

  /** §8: refuses without an out-of-sample result. Disabling is always allowed. */
  setLiveEnabled(strategyId: string, version: number, enabled: boolean): void {
    const strategy = this.strategyStore.get(strategyId, version);
    if (!strategy) throw new Error(`unknown strategy ${strategyId} v${version}`);
    if (enabled) {
      const decision = canEnable(strategy, this.resultStore.list(), this.configStore.load());
      if (!decision.ok) throw new Error(decision.reason);
    }
    this.strategyStore.setLiveEnabled(strategyId, version, enabled);
  }

  ledger(strategyId?: string): LiveSignal[] {
    const all = this.ledgerStore.read() as unknown as LiveSignal[];
    const rows = strategyId ? all.filter((s) => s.strategy_id === strategyId) : all;
    return [...rows].sort((a, b) => b.session.localeCompare(a.session) || a.ticker.localeCompare(b.ticker));
  }

  /**
   * Evaluates every live-enabled strategy on the latest completed session and
   * fills any forward returns that have matured.
   *
   * Idempotent: live-signal ids are deterministic, and the ledger's reader
   * takes the last write per id, so running this twice on the same session
   * changes nothing.
   */
  sweepLive(now = new Date().toISOString()): { recorded: number; filled: number } {
    const env = this.environment(true);
    const session = env.calendar.last;
    if (!session) return { recorded: 0, filled: 0 };

    const enabled = this.strategyStore.all().filter((s) => s.live_enabled);
    const fresh: LiveSignal[] = [];
    for (const strategy of enabled) {
      const signals = evaluateLive({
        strategy,
        ctx: env.ctx,
        calendar: env.calendar,
        screenConfig: env.screenConfig,
        gaugeConfig: env.gaugeConfig,
        r2Floor: env.r2Floor,
        graph: env.graph,
        filingsByTicker: env.filingsByTicker,
        earningsByTicker: env.earningsByTicker,
        earningsKnowledgeHorizonSessions: env.config.data.earningsKnowledgeHorizonSessions,
        universe: env.universe,
        session,
        now,
      });
      fresh.push(...(signals as unknown as LiveSignal[]));
    }

    const known = new Map(this.ledgerStore.read().map((s) => [s.id, s]));
    const novel = fresh.filter((s) => !known.has(s.id));
    if (novel.length > 0) this.ledgerStore.append(novel as never);

    const strategiesById = new Map(this.strategyStore.all().map((s) => [`${s.strategy_id}:${s.version}`, s]));
    const { updated, filled } = fillForwardReturns(this.ledgerStore.read(), {
      ctx: env.ctx,
      calendar: env.calendar,
      strategiesById,
    });
    if (filled > 0) this.ledgerStore.compact(updated);

    this.broadcast("quantlab:ledger", { recorded: novel.length, filled });
    return { recorded: novel.length, filled };
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(channel, payload);
    }
  }
}

let host: QuantLabHost | null = null;

export function getQuantLabHost(): QuantLabHost {
  if (!host) host = new QuantLabHost();
  return host;
}
