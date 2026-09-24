import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("meridian", {
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  minimize: () => ipcRenderer.invoke("window-minimize"),
  close: () => ipcRenderer.invoke("window-close"),
  toggleMaximize: () => ipcRenderer.invoke("window-toggle-maximize"),
  enterWorkspace: () => ipcRenderer.invoke("window-enter-workspace"),
  platform: process.platform,
  searchStockSymbols: (query: string, limit?: number) =>
    ipcRenderer.invoke("stock:search-symbols", query, limit),
  getRandomStockSymbol: () => ipcRenderer.invoke("stock:get-random-symbol"),
  listBrokerages: (accessToken?: string) =>
    ipcRenderer.invoke("snaptrade:brokerages", accessToken) as Promise<
      | {
          ok: true;
          configured: true;
          brokerages: import("../shared/snaptrade").SnaptradeBrokerage[];
        }
      | { ok: false; configured: boolean; error: string }
    >,
  connectBrokerage: (options?: { broker?: string; accessToken?: string }) =>
    ipcRenderer.invoke("snaptrade:connect", options) as Promise<
      | { ok: true; configured: true; url: string }
      | { ok: false; configured: boolean; error: string }
    >,
  getBrokerageNetWorth: (accessToken?: string) =>
    ipcRenderer.invoke("snaptrade:networth", accessToken) as Promise<
      | { ok: true; networth: import("../shared/snaptrade").BrokerageNetWorth }
      | { ok: false; error: string }
    >,
  getStockPanelData: (symbol: string, timeframe: string) =>
    ipcRenderer.invoke("stock:get-panel-data", symbol, timeframe),
  getStockQuote: (symbol: string) => ipcRenderer.invoke("stock:get-quote", symbol),
  getLiveQuote: (symbol: string) =>
    ipcRenderer.invoke("stock:get-live-quote", symbol) as Promise<
      | { ok: true; quote: import("../shared/stock-types").LiveQuote }
      | { ok: false; error: string }
    >,
  getStockChart: (symbol: string, timeframe: string) =>
    ipcRenderer.invoke("stock:get-chart", symbol, timeframe),
  getStockKeyStats: (symbol: string) => ipcRenderer.invoke("stock:get-key-stats", symbol),
  getStockOverview: (symbol: string, timeframe: string, intervalOverride?: string) =>
    ipcRenderer.invoke("stock:get-overview", symbol, timeframe, intervalOverride),
  getStockChartRange: (symbol: string, startSec: number, endSec: number) =>
    ipcRenderer.invoke("stock:get-chart-range", symbol, startSec, endSec),
  getStockNews: (symbol: string) => ipcRenderer.invoke("stock:get-news", symbol),
  getPriceMoveSince: (payload: {
    rootTicker: string;
    terminalTicker: string;
    sinceSec: number;
  }) =>
    ipcRenderer.invoke("stock:move-since", payload) as Promise<
      | {
          ok: true;
          root: import("../shared/stock-types").PriceMoveSince | null;
          terminal: import("../shared/stock-types").PriceMoveSince | null;
        }
      | { ok: false; error: string }
    >,
  startStep1Research: (
    ticker: string,
    options?: { force?: boolean; accessToken?: string },
  ) =>
    ipcRenderer.invoke("research-step1:start", ticker, options) as Promise<
      | { ok: true; jobId: string; fromCache?: boolean; via?: "worker" | "local" }
      | { ok: false; error: string; code?: string }
    >,
  getStep1ResearchQuota: (accessToken?: string) =>
    ipcRenderer.invoke("research-step1:quota", accessToken) as Promise<
      | { ok: true; quota: { limit: number; used: number; remaining: number; resetAt: string | null; retryAfterSeconds: number | null; allowed: boolean } }
      | { ok: false }
    >,
  getStep1ResearchStatus: (jobId: string, accessToken?: string) =>
    ipcRenderer.invoke("research-step1:status", jobId, accessToken) as Promise<
      | {
          ok: true;
          jobId: string;
          stage: string;
          progress: { current: number; total: number } | null;
          done: boolean;
          error: string | null;
          code?: string | null;
        }
      | { ok: false; error: string; code?: string }
    >,
  getStep1ResearchResult: (ticker: string, accessToken?: string) =>
    ipcRenderer.invoke("research-step1:result", ticker, accessToken) as Promise<
      | { ok: true; result: import("../shared/step1-research").Step1Result }
      | { ok: false; error: string; code?: string }
    >,
  getGraphData: () =>
    ipcRenderer.invoke("graph:load") as Promise<
      | { ok: true; graph: import("../shared/graph-types").GraphFile; path: string }
      | { ok: false; error: string }
    >,
  listNewsEvents: (options?: { days?: number; ticker?: string }) =>
    ipcRenderer.invoke("events:list", options) as Promise<
      | { ok: true; events: import("../shared/news-events").MaterialNewsEvent[] }
      | { ok: false; error: string }
    >,
  getNewsFeed: (options?: { days?: number; limit?: number }) =>
    ipcRenderer.invoke("news:feed", options) as Promise<
      import("../shared/news-feed").NewsFeedResult
    >,
  getNewsEventsStatus: () =>
    ipcRenderer.invoke("events:status") as Promise<
      { ok: true; status: import("../shared/news-events").EventsPollStatus } | { ok: false; error: string }
    >,
  pollNewsEventsNow: () =>
    ipcRenderer.invoke("events:poll-now") as Promise<
      | { ok: true; status: import("../shared/news-events").EventsPollStatus }
      | { ok: false; error: string }
    >,
  setSession: (payload: {
    supabaseUrl?: string | null;
    anonKey?: string | null;
    accessToken?: string | null;
  }) => ipcRenderer.invoke("auth:session", payload) as Promise<{ ok: true; hasToken: boolean }>,
  syncPortfolioHoldings: (symbols: string[]) =>
    ipcRenderer.invoke("portfolio:sync-holdings", symbols) as Promise<
      import("../shared/portfolio-coverage").PortfolioSyncResult | { ok: false; error: string }
    >,
  getPortfolioCoverage: () =>
    ipcRenderer.invoke("portfolio:coverage") as Promise<{
      ok: true;
      coverage: import("../shared/portfolio-coverage").PortfolioCoverageSnapshot;
    }>,
  getTrackerStatus: () =>
    ipcRenderer.invoke("tracker:status") as Promise<{
      ok: true;
      status: import("../shared/tracker-types").TrackerStatus;
    }>,
  getTrackerMessages: (options?: { limit?: number; ticker?: string }) =>
    ipcRenderer.invoke("tracker:messages", options) as Promise<
      | { ok: true; messages: import("../shared/tracker-types").TrackerMessage[] }
      | { ok: false; error: string }
    >,
  getTrackerConfig: () => ipcRenderer.invoke("tracker:config"),
  getTrackerTickerState: (ticker: string) =>
    ipcRenderer.invoke("tracker:ticker-state", ticker) as Promise<
      | {
          ok: true;
          state: import("../shared/tracker-types").TrackerTickerState;
          dataDir: string;
        }
      | { ok: false; error: string }
    >,
  getTrackerBenchmarkBars: () =>
    ipcRenderer.invoke("tracker:benchmark-bars") as Promise<{
      ok: true;
      benchmark: {
        symbol: string;
        bars: import("../shared/tracker-types").TrackerDailyBar[];
        asOf: string | null;
      };
    }>,
  getTrackerQuant: (ticker: string) =>
    ipcRenderer.invoke("tracker:quant", ticker) as Promise<
      | { ok: true; quant: import("../shared/tracker-types").TrackerQuantContext }
      | { ok: false; error: string }
    >,
  addTrackerTicker: (ticker: string) =>
    ipcRenderer.invoke("tracker:add-ticker", ticker) as Promise<
      | { ok: true; status: import("../shared/tracker-types").TrackerStatus }
      | { ok: false; error: string }
    >,
  removeTrackerTicker: (ticker: string) =>
    ipcRenderer.invoke("tracker:remove-ticker", ticker) as Promise<{
      ok: true;
      status: import("../shared/tracker-types").TrackerStatus;
    }>,
  runTrackerCycle: () =>
    ipcRenderer.invoke("tracker:run-cycle") as Promise<
      | { ok: true; status: import("../shared/tracker-types").TrackerStatus }
      | { ok: false; error: string }
    >,
  // Base Engine (§9 replay). Read-only: nothing is dispatched from here.
  runBaseReplay: (options?: {
    limit?: number;
    ticker?: string;
    held?: string[];
    watchlist?: string[];
  }) =>
    ipcRenderer.invoke("base:replay", options) as Promise<
      | { ok: true; result: import("../shared/base-types").BaseReplayResult }
      | { ok: false; error: string }
    >,
  getBaseConfig: () =>
    ipcRenderer.invoke("base:config") as Promise<
      | { ok: true; config: import("../shared/base-types").BaseConfigSummary }
      | { ok: false; error: string }
    >,
  // Classifier (spec §12 observability + Phase A/B switches).
  getClassifierStatus: () =>
    ipcRenderer.invoke("classifier:status") as Promise<
      | { ok: true; status: import("../shared/classifier-types").ClassifierStatus }
      | { ok: false; error: string }
    >,
  listClassifierVerdicts: (options?: { limit?: number }) =>
    ipcRenderer.invoke("classifier:verdicts", options) as Promise<
      | { ok: true; verdicts: import("../shared/classifier-types").ClassifierVerdict[] }
      | { ok: false; error: string }
    >,
  runClassifierCycle: (options?: { limit?: number; dryRun?: boolean; maxRequests?: number }) =>
    ipcRenderer.invoke("classifier:run-cycle", options) as Promise<
      | {
          ok: true;
          run: import("../shared/classifier-types").ClassifierRunSummary;
          status: import("../shared/classifier-types").ClassifierStatus;
        }
      | { ok: false; error: string }
    >,
  setClassifierEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("classifier:set-enabled", enabled) as Promise<
      | { ok: true; status: import("../shared/classifier-types").ClassifierStatus }
      | { ok: false; error: string }
    >,
  setClassifierRescore: (enabled: boolean) =>
    ipcRenderer.invoke("classifier:set-rescore", enabled) as Promise<
      | { ok: true; status: import("../shared/classifier-types").ClassifierStatus }
      | { ok: false; error: string }
    >,
  refreshClassifierMetadata: (force?: boolean) =>
    ipcRenderer.invoke("classifier:refresh-metadata", force) as Promise<
      | {
          ok: true;
          refreshed: number;
          failed: number;
          status: import("../shared/classifier-types").ClassifierStatus;
        }
      | { ok: false; error: string }
    >,
  runClassifierEval: (file: string) =>
    ipcRenderer.invoke("classifier:eval", file) as Promise<
      | { ok: true; report: import("../shared/classifier-types").ClassifierEvalReport }
      | { ok: false; error: string }
    >,
  // Screen S1 emit channel: the renderer owns the watchlist, main gates on it.
  pushScreenWatchlist: (tickers: string[]) =>
    ipcRenderer.invoke("screen:set-watchlist", tickers) as Promise<{ ok: true } | { ok: false; error: string }>,
  listScreenEmitted: (options?: { limit?: number; ticker?: string }) =>
    ipcRenderer.invoke("screen:emitted", options) as Promise<
      | { ok: true; messages: import("../shared/screen-types").ScreenEmittedMessage[] }
      | { ok: false; error: string }
    >,
  // Analyst (spec §9 panel + §11 observability + Phase A switch). Log-only.
  getAnalystStatus: () =>
    ipcRenderer.invoke("analyst:status") as Promise<
      | { ok: true; status: import("../shared/analyst-types").AnalystStatus }
      | { ok: false; error: string }
    >,
  listAnalystOutputs: (options?: {
    limit?: number;
    status?: "ok" | "failed";
    kind?: import("../shared/analyst-types").AnalystRequestKind;
    cause?: import("../shared/analyst-types").AnalystCause;
    edge_status?: import("../shared/analyst-types").AnalystEdgeStatus;
    ticker?: string;
    currentOnly?: boolean;
  }) =>
    ipcRenderer.invoke("analyst:outputs", options) as Promise<
      | { ok: true; outputs: import("../shared/analyst-types").AnalystOutput[] }
      | { ok: false; error: string }
    >,
  getAnalystOutputDetail: (incidentId: string, requestId: string) =>
    ipcRenderer.invoke("analyst:output-detail", incidentId, requestId) as Promise<
      | { ok: true; detail: import("../shared/analyst-types").AnalystOutputDetail }
      | { ok: false; error: string }
    >,
  runAnalystCycle: (options?: { limit?: number; dryRun?: boolean; maxRequests?: number }) =>
    ipcRenderer.invoke("analyst:run-cycle", options) as Promise<
      | {
          ok: true;
          run: import("../shared/analyst-types").AnalystRunSummary;
          status: import("../shared/analyst-types").AnalystStatus;
        }
      | { ok: false; error: string }
    >,
  setAnalystEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("analyst:set-enabled", enabled) as Promise<
      | { ok: true; status: import("../shared/analyst-types").AnalystStatus }
      | { ok: false; error: string }
    >,
  // Propagation (spec §8 Shift+P ripple view + §11 observability + Phase A switch).
  getPropagationStatus: () =>
    ipcRenderer.invoke("propagation:status") as Promise<
      | { ok: true; status: import("../shared/propagation-run-types").PropagationStatus }
      | { ok: false; error: string }
    >,
  listPropagationRuns: (options?: {
    limit?: number;
    status?: import("../shared/propagation-run-types").PropagationRunStatus;
    ticker?: string;
    currentOnly?: boolean;
    openOnly?: boolean;
    synthetic?: "exclude" | "only" | "all";
  }) =>
    ipcRenderer.invoke("propagation:runs", options) as Promise<
      | { ok: true; runs: import("../shared/propagation-run-types").PropagationRunListItem[] }
      | { ok: false; error: string }
    >,
  getPropagationAbsorption: (runId: string, targetKey: string) =>
    ipcRenderer.invoke("propagation:absorption", runId, targetKey) as Promise<
      | { ok: true; curve: import("../shared/propagation-run-types").AbsorptionPoint[] }
      | { ok: false; error: string }
    >,
    getPropagationRun: (runId: string) =>
    ipcRenderer.invoke("propagation:run", runId) as Promise<
      | {
          ok: true;
          run: import("../shared/propagation-run-types").PropagationRun;
          chain: import("../shared/propagation-run-types").PropagationRunListItem[];
        }
      | { ok: false; error: string }
    >,
  runPropagationCycle: (options?: { limit?: number; dryRun?: boolean; maxRequests?: number; stage2?: boolean }) =>
    ipcRenderer.invoke("propagation:run-cycle", options) as Promise<
      | {
          ok: true;
          run: import("../shared/propagation-run-types").PropagationRunCycleSummary;
          status: import("../shared/propagation-run-types").PropagationStatus;
        }
      | { ok: false; error: string }
    >,
  explainSelection: (request: { selection: string; context?: string; ticker?: string }) =>
    ipcRenderer.invoke("gloss:explain", request) as Promise<
      | {
          ok: true;
          cached: boolean;
          gloss: {
            kind: "term" | "passage";
            term: string;
            english: string;
            in_context: string;
            finance_specific: boolean;
          };
        }
      | { ok: false; error: string }
    >,
  askInsightChat: (request: import("../shared/insight-chat").InsightChatRequest) =>
    ipcRenderer.invoke("insight:chat", request) as Promise<
      import("../shared/insight-chat").InsightChatResult
    >,
  getPairExplanation: (
    request: import("../shared/pair-explanation").PairExplanationRequest,
  ) =>
    ipcRenderer.invoke("insight:pair-explanation", request) as Promise<
      import("../shared/pair-explanation").PairExplanationResult
    >,
  getPropagationPairHistory: (options: { root: string; target: string }) =>
    ipcRenderer.invoke("propagation:pair-history", options) as Promise<
      import("../shared/propagation-pair").PropagationPairHistoryResult
    >,
  getInsightExplanation: (
    request: import("../shared/insight-explanation").InsightExplanationRequest,
  ) =>
    ipcRenderer.invoke("insight:explanation", request) as Promise<
      import("../shared/insight-explanation").InsightExplanationResult
    >,
  translateGloss: (request: { term: string; english: string }) =>
    ipcRenderer.invoke("gloss:translate", request) as Promise<
      { ok: true; cached: boolean; turkish: string } | { ok: false; error: string }
    >,
  setPropagationSurfacing: (enabled: boolean) =>
    ipcRenderer.invoke("propagation:set-surfacing", enabled) as Promise<
      | { ok: true; status: import("../shared/propagation-run-types").PropagationStatus }
      | { ok: false; error: string }
    >,
  setPropagationEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("propagation:set-enabled", enabled) as Promise<
      | { ok: true; status: import("../shared/propagation-run-types").PropagationStatus }
      | { ok: false; error: string }
    >,
  // Risk Engine (spec §7 Shift+R panel, §8 card contract, §5 account push).
  getRiskStatus: () =>
    ipcRenderer.invoke("risk:status") as Promise<
      | { ok: true; status: import("../shared/risk-types").RiskStatus }
      | { ok: false; error: string }
    >,
  getRiskLatest: () =>
    ipcRenderer.invoke("risk:latest") as Promise<
      | ({ ok: true } & import("../shared/risk-types").RiskLatest)
      | { ok: false; error: string }
    >,
  getRiskHistory: (options?: { limit?: number }) =>
    ipcRenderer.invoke("risk:history", options) as Promise<
      | { ok: true; history: import("../shared/risk-types").RiskHistoryItem[] }
      | { ok: false; error: string }
    >,
  recomputeRisk: () =>
    ipcRenderer.invoke("risk:recompute") as Promise<
      | ({ ok: true; status: import("../shared/risk-types").RiskStatus } & import("../shared/risk-types").RiskLatest)
      | { ok: false; error: string }
    >,
  updateRiskAccount: (push: import("../shared/risk-types").RiskAccountPush) =>
    ipcRenderer.invoke("risk:account-update", push) as Promise<{ ok: true } | { ok: false; error: string }>,
  setRiskCardEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("risk:set-card-enabled", enabled) as Promise<
      | { ok: true; status: import("../shared/risk-types").RiskStatus }
      | { ok: false; error: string }
    >,
  onRiskSnapshot: (callback: (payload: import("../shared/risk-types").RiskLatest) => void) => {
    const handler = (_: IpcRendererEvent, payload: import("../shared/risk-types").RiskLatest) => callback(payload);
    ipcRenderer.on("risk:snapshot", handler);
    return () => {
      ipcRenderer.removeListener("risk:snapshot", handler);
    };
  },
  // Handover briefing: the pre-open window, the report, and the model narrative asked for after it.
  getBriefingWindow: () =>
    ipcRenderer.invoke("briefing:window") as Promise<import("../shared/briefing-types").BriefingWindowResult>,
  getBriefing: (request: import("../shared/briefing-types").BriefingRequest) =>
    ipcRenderer.invoke("briefing:get", request) as Promise<import("../shared/briefing-types").BriefingGetResult>,
  getBriefingNarrative: (request: import("../shared/briefing-types").BriefingNarrativeRequest) =>
    ipcRenderer.invoke("briefing:narrative", request) as Promise<
      import("../shared/briefing-types").BriefingNarrativeResult
    >,
  // Gauge (spec §8: Shift+F panel, Propagation drawer block, stock page block). Compute-on-read.
  getGaugeReadout: (req: import("../shared/gauge-types").GaugeReadoutRequest) =>
    ipcRenderer.invoke("gauge:readout", req) as Promise<
      | ({ ok: true } & import("../shared/gauge-types").GaugeReadoutResponse)
      | { ok: false; error: string }
    >,
  getGaugeStatus: () =>
    ipcRenderer.invoke("gauge:status") as Promise<
      | { ok: true; status: import("../shared/gauge-types").GaugeStatusInfo }
      | { ok: false; error: string }
    >,
  getGaugeTickers: () =>
    ipcRenderer.invoke("gauge:tickers") as Promise<{ ok: true; tickers: string[] } | { ok: false; error: string }>,
  reloadGaugeConfig: () =>
    ipcRenderer.invoke("gauge:reload-config") as Promise<
      | { ok: true; status: import("../shared/gauge-types").GaugeStatusInfo }
      | { ok: false; error: string }
    >,
  // Diagnostics (Shift+H panel): env/routing snapshot + live provider pings.
  getDiagnosticsEnv: () =>
    ipcRenderer.invoke("diagnostics:env") as Promise<
      | { ok: true; env: import("../shared/diagnostics-types").DiagnosticsEnvInfo }
      | { ok: false; error: string }
    >,
  runDiagnosticsProviders: () =>
    ipcRenderer.invoke("diagnostics:providers") as Promise<
      | { ok: true; results: import("../shared/diagnostics-types").ProviderCheckResult[] }
      | { ok: false; error: string }
    >,
  // Screen (spec §7 Shift+S panel). Findings store reads + a manual rescan of the last completed session.
  getScreenStatus: () =>
    ipcRenderer.invoke("screen:status") as Promise<
      | { ok: true; status: import("../shared/screen-types").ScreenStatus }
      | { ok: false; error: string }
    >,
  getScreenFindings: () =>
    ipcRenderer.invoke("screen:findings") as Promise<
      | ({ ok: true } & import("../shared/screen-types").ScreenFindingsPayload)
      | { ok: false; error: string }
    >,
  rescanScreen: () =>
    ipcRenderer.invoke("screen:rescan") as Promise<
      | ({ ok: true; scan: import("../shared/screen-types").ScreenScan | null } & import("../shared/screen-types").ScreenFindingsPayload)
      | { ok: false; error: string }
    >,

  // Quant Lab (§10 Shift+Q panel). Developer surface: reads, plus running a
  // backtest, toggling live evaluation and sweeping the ledger.
  getQuantLabStatus: () =>
    ipcRenderer.invoke("quantlab:status") as Promise<
      | { ok: true; status: import("../shared/quantlab-types").QuantLabStatus }
      | { ok: false; error: string }
    >,
  getQuantLabStrategies: () =>
    ipcRenderer.invoke("quantlab:strategies") as Promise<
      | { ok: true; strategies: import("../shared/quantlab-types").StrategyRow[] }
      | { ok: false; error: string }
    >,
  getQuantLabReports: (strategyId?: string) =>
    ipcRenderer.invoke("quantlab:reports", strategyId) as Promise<
      | { ok: true; reports: import("../shared/quantlab-types").BacktestReport[] }
      | { ok: false; error: string }
    >,
  runQuantLabBacktest: (options: { strategyId: string; from?: string; to?: string }) =>
    ipcRenderer.invoke("quantlab:backtest", options) as Promise<
      | { ok: true; report: import("../shared/quantlab-types").BacktestReport }
      | { ok: false; error: string }
    >,
  setQuantLabLive: (options: { strategyId: string; version: number; enabled: boolean }) =>
    ipcRenderer.invoke("quantlab:set-live", options) as Promise<
      | { ok: true; strategies: import("../shared/quantlab-types").StrategyRow[] }
      | { ok: false; error: string }
    >,
  getQuantLabLedger: (strategyId?: string) =>
    ipcRenderer.invoke("quantlab:ledger", strategyId) as Promise<
      | { ok: true; signals: import("../shared/quantlab-types").LiveSignal[] }
      | { ok: false; error: string }
    >,
  sweepQuantLabLedger: () =>
    ipcRenderer.invoke("quantlab:sweep") as Promise<
      { ok: true; recorded: number; filled: number } | { ok: false; error: string }
    >,
  reloadQuantLab: () =>
    ipcRenderer.invoke("quantlab:reload") as Promise<
      | { ok: true; status: import("../shared/quantlab-types").QuantLabStatus }
      | { ok: false; error: string }
    >,
  onQuantLabBacktest: (callback: (progress: import("../shared/quantlab-types").BacktestProgress) => void) => {
    const handler = (_: IpcRendererEvent, progress: import("../shared/quantlab-types").BacktestProgress) =>
      callback(progress);
    ipcRenderer.on("quantlab:backtest", handler);
    return () => {
      ipcRenderer.removeListener("quantlab:backtest", handler);
    };
  },
  onScreenScan: (callback: (scan: import("../shared/screen-types").ScreenScan) => void) => {
    const handler = (_: IpcRendererEvent, scan: import("../shared/screen-types").ScreenScan) => callback(scan);
    ipcRenderer.on("screen:scan", handler);
    return () => {
      ipcRenderer.removeListener("screen:scan", handler);
    };
  },
  /** A run produced by the fast lane, pushed the moment it exists. */
  onPropagationEvent: (
    callback: (run: import("../shared/propagation-run-types").PropagationRunListItem) => void,
  ) => {
    const handler = (
      _: IpcRendererEvent,
      run: import("../shared/propagation-run-types").PropagationRunListItem,
    ) => callback(run);
    ipcRenderer.on("propagation:event", handler);
    return () => {
      ipcRenderer.removeListener("propagation:event", handler);
    };
  },
  onTrackerEvent: (
    callback: (message: import("../shared/tracker-types").TrackerMessage) => void,
  ) => {
    const handler = (
      _: IpcRendererEvent,
      message: import("../shared/tracker-types").TrackerMessage,
    ) => callback(message);
    ipcRenderer.on("tracker:event", handler);
    return () => {
      ipcRenderer.removeListener("tracker:event", handler);
    };
  },
  /** Fires when runs arrive from the server mirror; the Insight card re-lists. */
  onPropagationRunsChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("propagation:runs-changed", handler);
    return () => {
      ipcRenderer.removeListener("propagation:runs-changed", handler);
    };
  },
  /** Fires once the tracker has loaded its state; cards that asked earlier re-ask. */
  onTrackerReady: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("tracker:ready", handler);
    return () => {
      ipcRenderer.removeListener("tracker:ready", handler);
    };
  },
  submitOnboardingSurvey: (payload: {
    answers: import("../shared/onboarding-survey").OnboardingSurveyAnswers;
    accessToken: string;
  }) =>
    ipcRenderer.invoke("onboarding:submit-survey", payload) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  getWaitlistMembership: (email: string) =>
    ipcRenderer.invoke("waitlist:membership", email) as Promise<{
      found: boolean;
      name: string | null;
      memberNumber: number | null;
      grantedAt: string | null;
      approved: boolean;
    }>,
  applyToWaitlist: (payload: {
    name: string;
    email: string;
    password?: string;
    phone?: string;
    application?: Record<string, string>;
  }) =>
    ipcRenderer.invoke("waitlist:apply", payload) as Promise<
      | { ok: true; status: "created" | "updated"; memberNumber: number | null }
      | { ok: false; error: string }
    >,
  getUpdateStatus: () =>
    ipcRenderer.invoke("update:get-status") as Promise<import("../shared/update-types").UpdateStatus>,
  onUpdateStatus: (
    listener: (status: import("../shared/update-types").UpdateStatus) => void,
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: import("../shared/update-types").UpdateStatus) =>
      listener(status);
    ipcRenderer.on("update:status", handler);
    return () => ipcRenderer.removeListener("update:status", handler);
  },
  installUpdate: () =>
    ipcRenderer.invoke("update:install") as Promise<{ ok: true } | { ok: false; error: string }>,
});
