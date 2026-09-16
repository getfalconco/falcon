/// <reference types="vite/client" />

import type {
  ChartTimeframe,
  LiveQuote,
  OverviewChartTimeframe,
  PricePoint,
  StockKeyStat,
  StockNewsItem,
  StockOverviewData,
  StockQuote,
} from "../shared/stock-types";
import type { StockCatalogEntry } from "../shared/stock-catalog";

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export type StockPanelData = {
  quote: StockQuote;
  series: PricePoint[];
  keyStats: StockKeyStat[];
};

interface MeridianBridge {
  openExternal: (url: string) => Promise<void>;
  minimize: () => Promise<void>;
  close: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  enterWorkspace: () => Promise<void>;
  platform: NodeJS.Platform;
  searchStockSymbols: (query: string, limit?: number) => Promise<StockCatalogEntry[]>;
  getRandomStockSymbol: () => Promise<string>;
  getStockPanelData: (symbol: string, timeframe: ChartTimeframe) => Promise<StockPanelData>;
  getStockQuote: (symbol: string) => Promise<StockQuote>;
  getLiveQuote: (
    symbol: string,
  ) => Promise<{ ok: true; quote: LiveQuote } | { ok: false; error: string }>;
  getStockChart: (symbol: string, timeframe: ChartTimeframe) => Promise<PricePoint[]>;
  getStockKeyStats: (symbol: string) => Promise<StockKeyStat[]>;
  getStockOverview: (
    symbol: string,
    timeframe: OverviewChartTimeframe,
    intervalOverride?: string,
  ) => Promise<StockOverviewData>;
  getStockChartRange: (
    symbol: string,
    startSec: number,
    endSec: number,
  ) => Promise<PricePoint[]>;
  getStockNews: (symbol: string) => Promise<StockNewsItem[]>;
  getPriceMoveSince: (payload: {
    rootTicker: string;
    terminalTicker: string;
    sinceSec: number;
  }) => Promise<
    | {
        ok: true;
        root: import("../shared/stock-types").PriceMoveSince | null;
        terminal: import("../shared/stock-types").PriceMoveSince | null;
      }
    | { ok: false; error: string }
  >;
  startStep1Research: (
    ticker: string,
    options?: { force?: boolean; accessToken?: string },
  ) => Promise<
    | { ok: true; jobId: string; fromCache?: boolean; via?: "worker" | "local" }
    | { ok: false; error: string; code?: string }
  >;
  getStep1ResearchQuota?: (accessToken?: string) => Promise<
    | {
        ok: true;
        quota: {
          limit: number;
          used: number;
          remaining: number;
          resetAt: string | null;
          retryAfterSeconds: number | null;
          allowed: boolean;
        };
      }
    | { ok: false }
  >;
  getStep1ResearchStatus: (
    jobId: string,
    accessToken?: string,
  ) => Promise<
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
  >;
  getStep1ResearchResult: (
    ticker: string,
    accessToken?: string,
  ) => Promise<
    | { ok: true; result: import("../shared/step1-research").Step1Result }
    | { ok: false; error: string; code?: string }
  >;
  getGraphData: () => Promise<
    | { ok: true; graph: import("../shared/graph-types").GraphFile; path: string }
    | { ok: false; error: string }
  >;
  listNewsEvents: (options?: {
    days?: number;
    ticker?: string;
  }) => Promise<
    | { ok: true; events: import("../shared/news-events").MaterialNewsEvent[] }
    | { ok: false; error: string }
  >;
  getNewsEventsStatus: () => Promise<
    | { ok: true; status: import("../shared/news-events").EventsPollStatus }
    | { ok: false; error: string }
  >;
  pollNewsEventsNow: () => Promise<
    | { ok: true; status: import("../shared/news-events").EventsPollStatus }
    | { ok: false; error: string }
  >;
  listBrokerages: (accessToken?: string) => Promise<
    | {
        ok: true;
        configured: true;
        brokerages: import("../shared/snaptrade").SnaptradeBrokerage[];
      }
    | { ok: false; configured: boolean; error: string }
  >;
  connectBrokerage: (options?: { broker?: string; accessToken?: string }) => Promise<
    | { ok: true; configured: true; url: string }
    | { ok: false; configured: boolean; error: string }
  >;
  getBrokerageNetWorth: (accessToken?: string) => Promise<
    | { ok: true; networth: import("../shared/snaptrade").BrokerageNetWorth }
    | { ok: false; error: string }
  >;
  submitOnboardingSurvey: (payload: {
    answers: import("../shared/onboarding-survey").OnboardingSurveyAnswers;
    accessToken: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  getWaitlistMembership: (email: string) => Promise<{
    found: boolean;
    name: string | null;
    memberNumber: number | null;
    grantedAt: string | null;
    approved: boolean;
  }>;
  applyToWaitlist: (payload: {
    name: string;
    email: string;
    password?: string;
    phone?: string;
    application?: Record<string, string>;
  }) => Promise<
    | { ok: true; status: "created" | "updated"; memberNumber: number | null }
    | { ok: false; error: string }
  >;
  setSession: (payload: {
    supabaseUrl?: string | null;
    anonKey?: string | null;
    accessToken?: string | null;
  }) => Promise<{ ok: true; hasToken: boolean }>;
  syncPortfolioHoldings: (
    symbols: string[],
  ) => Promise<
    import("../shared/portfolio-coverage").PortfolioSyncResult | { ok: false; error: string }
  >;
  getPortfolioCoverage: () => Promise<{
    ok: true;
    coverage: import("../shared/portfolio-coverage").PortfolioCoverageSnapshot;
  }>;
  getTrackerStatus: () => Promise<{
    ok: true;
    status: import("../shared/tracker-types").TrackerStatus;
  }>;
  getTrackerMessages: (options?: { limit?: number; ticker?: string }) => Promise<
    | { ok: true; messages: import("../shared/tracker-types").TrackerMessage[] }
    | { ok: false; error: string }
  >;
  getTrackerConfig: () => Promise<{ ok: true; config: unknown }>;
  getTrackerTickerState: (
    ticker: string,
  ) => Promise<
    | {
        ok: true;
        state: import("../shared/tracker-types").TrackerTickerState;
        dataDir: string;
      }
    | { ok: false; error: string }
  >;
  getTrackerBenchmarkBars: () => Promise<{
    ok: true;
    benchmark: {
      symbol: string;
      bars: import("../shared/tracker-types").TrackerDailyBar[];
      asOf: string | null;
    };
  }>;
  getTrackerQuant: (
    ticker: string,
  ) => Promise<
    | { ok: true; quant: import("../shared/tracker-types").TrackerQuantContext }
    | { ok: false; error: string }
  >;
  addTrackerTicker: (
    ticker: string,
  ) => Promise<
    | { ok: true; status: import("../shared/tracker-types").TrackerStatus }
    | { ok: false; error: string }
  >;
  removeTrackerTicker: (ticker: string) => Promise<{
    ok: true;
    status: import("../shared/tracker-types").TrackerStatus;
  }>;
  runTrackerCycle: () => Promise<
    | { ok: true; status: import("../shared/tracker-types").TrackerStatus }
    | { ok: false; error: string }
  >;
  // Risk Engine
  getRiskStatus: () => Promise<
    | { ok: true; status: import("../shared/risk-types").RiskStatus }
    | { ok: false; error: string }
  >;
  getRiskLatest: () => Promise<
    | ({ ok: true } & import("../shared/risk-types").RiskLatest)
    | { ok: false; error: string }
  >;
  getRiskHistory: (options?: { limit?: number }) => Promise<
    | { ok: true; history: import("../shared/risk-types").RiskHistoryItem[] }
    | { ok: false; error: string }
  >;
  recomputeRisk: () => Promise<
    | ({ ok: true; status: import("../shared/risk-types").RiskStatus } & import("../shared/risk-types").RiskLatest)
    | { ok: false; error: string }
  >;
  updateRiskAccount: (
    push: import("../shared/risk-types").RiskAccountPush,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  setRiskCardEnabled: (enabled: boolean) => Promise<
    | { ok: true; status: import("../shared/risk-types").RiskStatus }
    | { ok: false; error: string }
  >;
  onRiskSnapshot: (callback: (payload: import("../shared/risk-types").RiskLatest) => void) => () => void;
  // Gauge
  getGaugeReadout: (req: import("../shared/gauge-types").GaugeReadoutRequest) => Promise<
    | ({ ok: true } & import("../shared/gauge-types").GaugeReadoutResponse)
    | { ok: false; error: string }
  >;
  getGaugeStatus: () => Promise<
    | { ok: true; status: import("../shared/gauge-types").GaugeStatusInfo }
    | { ok: false; error: string }
  >;
  getGaugeTickers: () => Promise<{ ok: true; tickers: string[] } | { ok: false; error: string }>;
  reloadGaugeConfig: () => Promise<
    | { ok: true; status: import("../shared/gauge-types").GaugeStatusInfo }
    | { ok: false; error: string }
  >;
  // Diagnostics (Shift+H panel)
  getDiagnosticsEnv: () => Promise<
    | { ok: true; env: import("../shared/diagnostics-types").DiagnosticsEnvInfo }
    | { ok: false; error: string }
  >;
  runDiagnosticsProviders: () => Promise<
    | { ok: true; results: import("../shared/diagnostics-types").ProviderCheckResult[] }
    | { ok: false; error: string }
  >;
  // Screen (spec §7 Shift+S panel).
  getScreenStatus: () => Promise<
    | { ok: true; status: import("../shared/screen-types").ScreenStatus }
    | { ok: false; error: string }
  >;
  getScreenFindings: () => Promise<
    | ({ ok: true } & import("../shared/screen-types").ScreenFindingsPayload)
    | { ok: false; error: string }
  >;
  rescanScreen: () => Promise<
    | ({ ok: true; scan: import("../shared/screen-types").ScreenScan | null } & import("../shared/screen-types").ScreenFindingsPayload)
    | { ok: false; error: string }
  >;
  onScreenScan: (callback: (scan: import("../shared/screen-types").ScreenScan) => void) => () => void;

  // Quant Lab (§10 Shift+Q panel).
  getQuantLabStatus: () => Promise<
    | { ok: true; status: import("../shared/quantlab-types").QuantLabStatus }
    | { ok: false; error: string }
  >;
  getQuantLabStrategies: () => Promise<
    | { ok: true; strategies: import("../shared/quantlab-types").StrategyRow[] }
    | { ok: false; error: string }
  >;
  getQuantLabReports: (strategyId?: string) => Promise<
    | { ok: true; reports: import("../shared/quantlab-types").BacktestReport[] }
    | { ok: false; error: string }
  >;
  runQuantLabBacktest: (options: { strategyId: string; from?: string; to?: string }) => Promise<
    | { ok: true; report: import("../shared/quantlab-types").BacktestReport }
    | { ok: false; error: string }
  >;
  setQuantLabLive: (options: { strategyId: string; version: number; enabled: boolean }) => Promise<
    | { ok: true; strategies: import("../shared/quantlab-types").StrategyRow[] }
    | { ok: false; error: string }
  >;
  getQuantLabLedger: (strategyId?: string) => Promise<
    | { ok: true; signals: import("../shared/quantlab-types").LiveSignal[] }
    | { ok: false; error: string }
  >;
  sweepQuantLabLedger: () => Promise<
    { ok: true; recorded: number; filled: number } | { ok: false; error: string }
  >;
  reloadQuantLab: () => Promise<
    | { ok: true; status: import("../shared/quantlab-types").QuantLabStatus }
    | { ok: false; error: string }
  >;
  onQuantLabBacktest: (
    callback: (progress: import("../shared/quantlab-types").BacktestProgress) => void,
  ) => () => void;
  onTrackerEvent: (
    callback: (message: import("../shared/tracker-types").TrackerMessage) => void,
  ) => () => void;
  /** Fires once the tracker has loaded its state into memory. */
  onTrackerReady: (callback: () => void) => () => void;
  /** Fires when propagation runs arrive from the server mirror. */
  onPropagationRunsChanged: (callback: () => void) => () => void;
  runBaseReplay: (options?: {
    limit?: number;
    ticker?: string;
    held?: string[];
    watchlist?: string[];
  }) => Promise<
    | { ok: true; result: import("../shared/base-types").BaseReplayResult }
    | { ok: false; error: string }
  >;
  getBaseConfig: () => Promise<
    | { ok: true; config: import("../shared/base-types").BaseConfigSummary }
    | { ok: false; error: string }
  >;
  pushScreenWatchlist: (tickers: string[]) => Promise<{ ok: true } | { ok: false; error: string }>;
  listScreenEmitted: (options?: { limit?: number; ticker?: string }) => Promise<
    | { ok: true; messages: import("../shared/screen-types").ScreenEmittedMessage[] }
    | { ok: false; error: string }
  >;
  getAnalystStatus: () => Promise<
    | { ok: true; status: import("../shared/analyst-types").AnalystStatus }
    | { ok: false; error: string }
  >;
  listAnalystOutputs: (options?: {
    limit?: number;
    status?: "ok" | "failed";
    kind?: import("../shared/analyst-types").AnalystRequestKind;
    cause?: import("../shared/analyst-types").AnalystCause;
    edge_status?: import("../shared/analyst-types").AnalystEdgeStatus;
    ticker?: string;
    currentOnly?: boolean;
  }) => Promise<
    | { ok: true; outputs: import("../shared/analyst-types").AnalystOutput[] }
    | { ok: false; error: string }
  >;
  getAnalystOutputDetail: (incidentId: string, requestId: string) => Promise<
    | { ok: true; detail: import("../shared/analyst-types").AnalystOutputDetail }
    | { ok: false; error: string }
  >;
  runAnalystCycle: (options?: { limit?: number; dryRun?: boolean; maxRequests?: number }) => Promise<
    | {
        ok: true;
        run: import("../shared/analyst-types").AnalystRunSummary;
        status: import("../shared/analyst-types").AnalystStatus;
      }
    | { ok: false; error: string }
  >;
  setAnalystEnabled: (enabled: boolean) => Promise<
    | { ok: true; status: import("../shared/analyst-types").AnalystStatus }
    | { ok: false; error: string }
  >;
  getPropagationStatus: () => Promise<
    | { ok: true; status: import("../shared/propagation-run-types").PropagationStatus }
    | { ok: false; error: string }
  >;
  listPropagationRuns: (options?: {
    limit?: number;
    status?: import("../shared/propagation-run-types").PropagationRunStatus;
    ticker?: string;
    currentOnly?: boolean;
    openOnly?: boolean;
    synthetic?: "exclude" | "only" | "all";
  }) => Promise<
    | { ok: true; runs: import("../shared/propagation-run-types").PropagationRunListItem[] }
    | { ok: false; error: string }
  >;
  getPropagationAbsorption: (runId: string, targetKey: string) => Promise<
    | { ok: true; curve: import("../shared/propagation-run-types").AbsorptionPoint[] }
    | { ok: false; error: string }
  >;
  getPropagationRun: (runId: string) => Promise<
    | {
        ok: true;
        run: import("../shared/propagation-run-types").PropagationRun;
        chain: import("../shared/propagation-run-types").PropagationRunListItem[];
      }
    | { ok: false; error: string }
  >;
  runPropagationCycle: (options?: { limit?: number; dryRun?: boolean; maxRequests?: number; stage2?: boolean }) => Promise<
    | {
        ok: true;
        run: import("../shared/propagation-run-types").PropagationRunCycleSummary;
        status: import("../shared/propagation-run-types").PropagationStatus;
      }
    | { ok: false; error: string }
  >;
  /** What a highlighted word or passage means, in its market sense. */
  explainSelection: (request: {
    selection: string;
    context?: string;
    ticker?: string;
  }) => Promise<
    | {
        ok: true;
        cached: boolean;
        gloss: import("../shared/gloss-types").Gloss;
      }
    | { ok: false; error: string }
  >;
  /** Turkish for an explanation already on screen. */
  askInsightChat: (
    request: import("../shared/insight-chat").InsightChatRequest,
  ) => Promise<import("../shared/insight-chat").InsightChatResult>;
  getPairExplanation: (
    request: import("../shared/pair-explanation").PairExplanationRequest,
  ) => Promise<import("../shared/pair-explanation").PairExplanationResult>;
  getPropagationPairHistory: (options: {
    root: string;
    target: string;
  }) => Promise<import("../shared/propagation-pair").PropagationPairHistoryResult>;
  getInsightExplanation: (
    request: import("../shared/insight-explanation").InsightExplanationRequest,
  ) => Promise<import("../shared/insight-explanation").InsightExplanationResult>;
  translateGloss: (request: { term: string; english: string }) => Promise<
    { ok: true; cached: boolean; turkish: string } | { ok: false; error: string }
  >;
  setPropagationSurfacing: (enabled: boolean) => Promise<
    | { ok: true; status: import("../shared/propagation-run-types").PropagationStatus }
    | { ok: false; error: string }
  >;
  setPropagationEnabled: (enabled: boolean) => Promise<
    | { ok: true; status: import("../shared/propagation-run-types").PropagationStatus }
    | { ok: false; error: string }
  >;
  onPropagationEvent: (
    callback: (run: import("../shared/propagation-run-types").PropagationRunListItem) => void,
  ) => () => void;
  getClassifierStatus: () => Promise<
    | { ok: true; status: import("../shared/classifier-types").ClassifierStatus }
    | { ok: false; error: string }
  >;
  listClassifierVerdicts: (options?: { limit?: number }) => Promise<
    | { ok: true; verdicts: import("../shared/classifier-types").ClassifierVerdict[] }
    | { ok: false; error: string }
  >;
  runClassifierCycle: (options?: { limit?: number; dryRun?: boolean; maxRequests?: number }) => Promise<
    | {
        ok: true;
        run: import("../shared/classifier-types").ClassifierRunSummary;
        status: import("../shared/classifier-types").ClassifierStatus;
      }
    | { ok: false; error: string }
  >;
  setClassifierEnabled: (enabled: boolean) => Promise<
    | { ok: true; status: import("../shared/classifier-types").ClassifierStatus }
    | { ok: false; error: string }
  >;
  setClassifierRescore: (enabled: boolean) => Promise<
    | { ok: true; status: import("../shared/classifier-types").ClassifierStatus }
    | { ok: false; error: string }
  >;
  refreshClassifierMetadata: (force?: boolean) => Promise<
    | {
        ok: true;
        refreshed: number;
        failed: number;
        status: import("../shared/classifier-types").ClassifierStatus;
      }
    | { ok: false; error: string }
  >;
  runClassifierEval: (file: string) => Promise<
    | { ok: true; report: import("../shared/classifier-types").ClassifierEvalReport }
    | { ok: false; error: string }
  >;
  getUpdateStatus: () => Promise<import("../shared/update-types").UpdateStatus>;
  onUpdateStatus: (
    listener: (status: import("../shared/update-types").UpdateStatus) => void,
  ) => () => void;
  installUpdate: () => Promise<{ ok: true } | { ok: false; error: string }>;
}

declare global {
  interface Window {
    meridian?: MeridianBridge;
  }
}

export {};
