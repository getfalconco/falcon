/**
 * Backtest orchestration — assembling the environment once and running a
 * strategy against it.
 *
 * Loading is separated from running because a backtest is re-run constantly
 * (that is what the variant counter counts), and the environment — 76 series,
 * the graph, the filing history — is expensive and identical every time. One
 * load, many runs.
 */

import fs from "node:fs";
import path from "node:path";
import { loadGraphIndexSync, type GraphIndex } from "../propagation/engine/graph.js";
import { edgeDisclosedAt } from "./graph-asof.js";
import { DEFAULT_GAUGE_CONFIG, mergeGaugeConfig, type GaugeConfig } from "../gauge/config.js";
import { ScreenConfigStore } from "../screen/store.js";
import type { ScreenConfig } from "../screen/config.js";
import { TrackerStore } from "../tracker/store.js";
import type { TickerState } from "../tracker/types.js";
import { TradingCalendar } from "./calendar.js";
import type { QuantLabConfig } from "./config.js";
import { buildEarningsHistory, buildFilingEvents, type FilingEvent } from "./filings.js";
import { buildSectorIndex, type ReturnContext } from "./returns.js";
import { assembleReport } from "./report.js";
import { generateSignals } from "./signals.js";
import { QuantLabConfigStore, ResultStore, SeriesStore } from "./store.js";
import { SCREEN_ASOF_APPROXIMATIONS } from "./screen-asof.js";
import { unavailableComponents } from "./strategy.js";
import type { BacktestReport, QuantSeries, Strategy } from "./types.js";

export type BacktestEnvironment = {
  config: QuantLabConfig;
  screenConfig: ScreenConfig;
  gaugeConfig: GaugeConfig;
  r2Floor: number;
  calendar: TradingCalendar;
  ctx: ReturnContext;
  graph: GraphIndex;
  filingsByTicker: Map<string, FilingEvent[]>;
  earningsByTicker: Map<string, FilingEvent[]>;
  universe: string[];
  /** Full span the backfilled data covers. */
  span: { from: string; to: string };
};

export type LoadEnvironmentOptions = {
  seriesStore?: SeriesStore;
  trackerStore?: TrackerStore;
  configStore?: QuantLabConfigStore;
  graphPath?: string;
  /** Restrict the universe (tests, or a strategy with an explicit ticker list). */
  tickers?: string[];
};

function readSectorRows(trackerDataDir: string): Array<{ ticker: string; sector: string | null }> {
  // The classifier owns this file; Quant Lab reads it and never writes it.
  const file = path.join(path.dirname(trackerDataDir), "classifier", "company-metadata.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      rows?: Record<string, { ticker?: string; sector?: string | null }>;
    };
    return Object.entries(parsed.rows ?? {}).map(([ticker, row]) => ({
      ticker: (row?.ticker ?? ticker).toUpperCase(),
      sector: row?.sector ?? null,
    }));
  } catch {
    return [];
  }
}

export function loadEnvironment(options: LoadEnvironmentOptions = {}): BacktestEnvironment {
  const configStore = options.configStore ?? new QuantLabConfigStore();
  const config = configStore.load();
  const seriesStore = options.seriesStore ?? new SeriesStore();
  const trackerStore = options.trackerStore ?? new TrackerStore();
  const trackerConfig = trackerStore.loadConfig();
  const screenConfig = new ScreenConfigStore().load();
  const gaugeConfig = mergeGaugeConfig(null);

  const seriesByTicker = new Map<string, QuantSeries>();
  for (const ticker of seriesStore.list()) {
    if (options.tickers && !options.tickers.includes(ticker) && ticker !== config.data.benchmark) continue;
    const series = seriesStore.load(ticker);
    if (series && series.snapshots.length > 0) seriesByTicker.set(ticker, series);
  }

  const bench = seriesByTicker.get(config.data.benchmark);
  if (!bench) {
    throw new Error(
      `no ${config.data.benchmark} series in ${seriesStore.seriesDir} — run \`quantlab-backfill.ts series\` first`,
    );
  }
  const calendar = TradingCalendar.fromBars(
    bench.snapshots.map((s) => ({ d: s.d, o: s.open, h: s.close, l: s.close, c: s.close, v: s.volume })),
  );

  const { sectorOf, sectorMembers } = buildSectorIndex(readSectorRows(trackerStore.dataDir));
  const ctx: ReturnContext = {
    calendar,
    seriesByTicker,
    benchmark: config.data.benchmark,
    sectorOf,
    sectorMembers,
    minSectorPeers: config.data.minSectorPeers,
  };

  const universe = [...seriesByTicker.keys()].filter((t) => t !== config.data.benchmark).sort();
  const filingsByTicker = new Map<string, FilingEvent[]>();
  const earningsByTicker = new Map<string, FilingEvent[]>();
  for (const ticker of universe) {
    let state: TickerState | null = null;
    try {
      state = trackerStore.loadTickerState(ticker);
    } catch {
      state = null;
    }
    if (!state) continue;
    filingsByTicker.set(ticker, buildFilingEvents(state, calendar));
    earningsByTicker.set(ticker, buildEarningsHistory(state, calendar));
  }

  const graphPath = options.graphPath ?? process.env.FALCON_GRAPH_PATH ?? path.join(path.dirname(trackerStore.dataDir), "graph.json");
  let graph: GraphIndex;
  try {
    graph = loadGraphIndexSync(graphPath);
  } catch {
    // A missing graph disables graph strategies but must not stop a pattern or
    // setup backtest from running.
    graph = loadEmptyGraph();
  }

  return {
    config,
    screenConfig,
    gaugeConfig,
    r2Floor: trackerConfig.thresholds.lowR2Fallback,
    calendar,
    ctx,
    graph,
    filingsByTicker,
    earningsByTicker,
    universe,
    span: { from: calendar.first ?? "", to: calendar.last ?? "" },
  };
}

/** Earliest date on which any edge in the graph had been disclosed. */
export function earliestEdgeDisclosure(graph: GraphIndex): string | null {
  let earliest: string | null = null;
  for (const edge of graph.edges) {
    const disclosed = edgeDisclosedAt(edge);
    if (disclosed && (earliest == null || disclosed < earliest)) earliest = disclosed;
  }
  return earliest;
}

function loadEmptyGraph(): GraphIndex {
  return {
    version: { generatedAt: "unavailable", pipelineVersion: 0 },
    edges: [],
    forward: new Map(),
    reverse: new Map(),
    labels: new Map(),
    roots: new Set(),
  };
}

export type RunBacktestOptions = {
  /** Overrides the window; defaults to the configured years back from the last session. */
  from?: string;
  to?: string;
  /** Injected for determinism in tests. */
  now?: string;
  reportId?: string;
  variantNumber?: number;
};

export function defaultWindow(env: BacktestEnvironment): { from: string; to: string } {
  const sessions = env.calendar.sessions();
  const to = sessions[sessions.length - 1];
  const wanted = env.config.backtest.windowYears * env.config.backtest.sessionsPerYear;
  const from = sessions[Math.max(0, sessions.length - wanted)];
  return { from, to };
}

export function runBacktest(
  strategy: Strategy,
  env: BacktestEnvironment,
  options: RunBacktestOptions = {},
): BacktestReport {
  const window = { ...defaultWindow(env), ...(options.from ? { from: options.from } : {}), ...(options.to ? { to: options.to } : {}) };
  const now = options.now ?? new Date().toISOString();

  const universe =
    strategy.universe.tickers === "tracked"
      ? env.universe
      : env.universe.filter((t) => (strategy.universe.tickers as string[]).map((x) => x.toUpperCase()).includes(t));

  const generated = generateSignals({
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
    universe,
    from: window.from,
    to: window.to,
  });

  const extraCaveats: string[] = [];
  for (const component of unavailableComponents(strategy, env.config.unavailableHistorically)) {
    extraCaveats.push(`${component.component}: ${component.reason}`);
  }
  // A graph strategy cannot fire before the graph knew anything. Every edge
  // carries the filing that disclosed it, and the graph is built from each
  // company's most recent 10-K, so the earliest disclosure is usually FAR
  // inside the nominal window. Saying so is what stops an empty in-sample
  // period from looking like a broken backtest.
  if (strategy.trigger.graph?.edge_from_event_ticker) {
    const earliest = earliestEdgeDisclosure(env.graph);
    extraCaveats.push(
      earliest
        ? `Graph coverage: the earliest edge disclosure is ${earliest}. Sessions before it have no edges by construction, so this rule is only testable from ${earliest} onward — ${env.graph.edges.length} edges total.`
        : "Graph coverage: no dated edges are available, so no graph-triggered signal can fire.",
    );
  }
  if (generated.entry_timing_rejected > 0) {
    extraCaveats.push(
      `${generated.entry_timing_rejected} candidate(s) dropped: the triggering filing was accepted after the close, so a signal_close entry was not available. Switch entry to next_open to include them.`,
    );
  }
  // A directional rule whose trigger never supplies a direction is a long-only
  // rule with a misleading name. COILED, for instance, is deliberately
  // direction-symmetric, so a `pattern_direction` variant of it is vacuous —
  // and without this line it would report as a second, independent result.
  if (strategy.direction.kind !== "long_only" && generated.signals.length > 0) {
    if (generated.direction_from_trigger === 0) {
      extraCaveats.push(
        `Direction is vacuous: the trigger supplied no direction on ANY of the ${generated.signals.length} signals, so every one defaulted to long. This rule is identical to its long_only form.`,
      );
    } else if (generated.direction_fallback_long > 0) {
      extraCaveats.push(
        `Direction resolved from the trigger on ${generated.direction_from_trigger} signals; ${generated.direction_fallback_long} defaulted to long.`,
      );
    }
  }
  const rejectionSummary = Object.entries(generated.filter_rejections)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${kind} ${n}`)
    .join(", ");
  if (rejectionSummary) extraCaveats.push(`Filter rejections — ${rejectionSummary}.`);
  if (SCREEN_ASOF_APPROXIMATIONS.news_burst === "inactive" && strategy.trigger.pattern?.names.includes("quiet_accumulation")) {
    extraCaveats.push(
      "quiet_accumulation ran with its news-burst veto disabled, so this signal count is an upper bound on what would have fired live.",
    );
  }

  return assembleReport({
    reportId: options.reportId ?? `${strategy.strategy_id}-v${strategy.version}-${now.replace(/[:.]/g, "-")}`,
    strategy,
    config: env.config,
    calendar: env.calendar,
    ctx: env.ctx,
    signals: generated.signals,
    window,
    excluded: generated.excluded,
    variantNumber: options.variantNumber ?? 1,
    extraCaveats,
    now,
  });
}

/** Runs a backtest and persists the report, incrementing the family's variant count. */
export function runAndStore(
  strategy: Strategy,
  env: BacktestEnvironment,
  resultStore: ResultStore,
  options: RunBacktestOptions = {},
): BacktestReport {
  const variantNumber = options.variantNumber ?? resultStore.nextVariantNumber(strategy.strategy_id);
  const report = runBacktest(strategy, env, { ...options, variantNumber });
  resultStore.save(report);
  return report;
}

export { DEFAULT_GAUGE_CONFIG };
