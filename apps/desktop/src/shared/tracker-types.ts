/**
 * Desktop-side mirror of the Tracker (Engine1) contracts so the renderer and
 * main process don't import the Node-only research package directly.
 * Keep in sync with packages/research/src/tracker/types.ts.
 */

export const TRACKER_SCHEMA_VERSION = 1;

export type TrackerSessionKind = "regular" | "pre" | "post" | "closed";

export type TrackerMessageType =
  | "news_item"
  | "filing_item"
  | "insider_filing"
  | "scheduled_event"
  | "gap_event"
  | "volume_anomaly"
  | "silence_anomaly"
  | "filing_overdue"
  | "unexplained_move"
  | "drift_event"
  | "news_burst"
  | "insider_cluster";

export type TrackerQuantContext = {
  beta_90d: number | null;
  r_squared: number | null;
  daily_vol_30d: number | null;
  vol_regime: number | null;
  move_today: number | null;
  move_zscore: number | null;
  residual_move: number | null;
  residual_zscore: number | null;
  volume_ratio: number | null;
  volume_ratio_partial: boolean;
  momentum_5d: number | null;
  momentum_20d: number | null;
  momentum_60d: number | null;
  pct_from_52w_high: number | null;
  pct_from_52w_low: number | null;
  earnings_rhythm: number | null;
  prev_close: number | null;
  last_price: number | null;
  price_asof: string | null;
  session: TrackerSessionKind;
};

export type TrackerMessage = {
  id: string;
  schema_version: number;
  type: TrackerMessageType;
  ticker: string;
  timestamp: string;
  source_engine: "tracker";
  context_flags: string[];
  quant_context: TrackerQuantContext;
  payload: Record<string, unknown>;
};

export type TrackerChannelHealth = {
  last_success_at: string | null;
  last_error: string | null;
};

export type TrackerStatus = {
  running: boolean;
  startedAt: string | null;
  tickers: Array<{
    ticker: string;
    backfilled: boolean;
    /** Phase-2 Form 4 seeding done; until then insider_cluster is under-fed. */
    insiderSeeded: boolean;
    barsAsOf: string | null;
    health: {
      news: TrackerChannelHealth;
      filings: TrackerChannelHealth;
      calendar: TrackerChannelHealth;
      price: TrackerChannelHealth;
    };
  }>;
  messagesEmitted: number;
  lastMessageAt: string | null;
  /** Today's HTTP 429 tally per channel (ET day). */
  rateLimits: { day: string; news: number; calendar: number; filings: number; price: number };
};

export type TrackerDailyBar = {
  d: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type TrackerFilingRecord = {
  form: string;
  accessionNumber: string;
  filedAt: string;
  acceptedAt: string | null;
  reportDate: string | null;
  items: string[];
  primaryDocument: string | null;
};

export type TrackerInsiderTxn = {
  accessionNumber: string;
  insiderName: string;
  role: string;
  transactionCode: string;
  is10b51Plan: boolean;
  shares: number | null;
  value: number | null;
  /** Trade execution date (cluster window anchor); filedAt stands in when null. */
  transactionDate: string | null;
  filedAt: string;
  direction: "buy" | "sell" | null;
};

export type TrackerEarningsRecord = {
  date: string;
  fiscalPeriod: string;
  hour: string | null;
};

export type TrackerEdgeDetectorState = {
  active: boolean;
  lastFiredAt: string | null;
  lastFiredValue: number | null;
  falseSinceDay: string | null;
};

/** Only insider_cluster tracks membership — it re-fires when a member joins. */
export type TrackerInsiderClusterDetectorState = TrackerEdgeDetectorState & {
  lastClusterInsiders: string[];
};

export type TrackerSnapshotDetectorState = {
  lastFiredDay: string | null;
  lastFiredValue: number | null;
};

/** The complete persisted per-ticker state, as held by the engine. */
export type TrackerTickerState = {
  ticker: string;
  addedAt: string;
  backfilledAt: string | null;
  insiderBackfilledAt: string | null;
  /** Form 4 ingest tally: fetched / parsed / kept after the P/S filter. */
  insiderParse: { attempted: number; parsed: number; kept: number };
  /** Accessions already fetched, including those the P/S filter discarded. */
  insiderScanned: string[];
  cik: string | null;
  bars: TrackerDailyBar[];
  barsAsOf: string | null;
  filings: TrackerFilingRecord[];
  insiderTxns: TrackerInsiderTxn[];
  earnings: TrackerEarningsRecord[];
  scheduledEarnings: Array<{ dueAt: string; fiscalPeriod: string; confirmed: boolean }>;
  /** due_at values a scheduled_event has already been emitted for. */
  scheduledEmitted: Array<{ fiscalPeriod: string; dueAt: string }>;
  newsCounts: Record<string, number>;
  seenArticleIds: string[];
  newsTimestamps: string[];
  detectors: {
    gap: TrackerSnapshotDetectorState;
    volume: TrackerSnapshotDetectorState;
    unexplained: TrackerSnapshotDetectorState;
    silence: TrackerEdgeDetectorState;
    filingOverdue: TrackerEdgeDetectorState;
    drift: TrackerEdgeDetectorState;
    newsBurst: TrackerEdgeDetectorState;
    insiderCluster: TrackerInsiderClusterDetectorState;
  };
  health: {
    news: TrackerChannelHealth;
    filings: TrackerChannelHealth;
    calendar: TrackerChannelHealth;
    price: TrackerChannelHealth;
  };
  /** §3 quant state persisted at the last close-run. */
  quant: TrackerQuantContext | null;
  quantAsOf: string | null;
  lastCloseComputedFor: string | null;
  lastGapCheckedFor: string | null;
};

/** Detector message types — everything that is not a raw channel item. */
export const TRACKER_ANOMALY_TYPES: TrackerMessageType[] = [
  "gap_event",
  "volume_anomaly",
  "silence_anomaly",
  "filing_overdue",
  "unexplained_move",
  "drift_event",
  "news_burst",
  "insider_cluster",
];

export const TRACKER_TYPE_LABELS: Record<TrackerMessageType, string> = {
  news_item: "News",
  filing_item: "Filing",
  insider_filing: "Insider",
  scheduled_event: "Scheduled",
  gap_event: "Gap",
  volume_anomaly: "Volume",
  silence_anomaly: "Silence",
  filing_overdue: "Filing overdue",
  unexplained_move: "Unexplained move",
  drift_event: "Drift",
  news_burst: "News burst",
  insider_cluster: "Insider cluster",
};
