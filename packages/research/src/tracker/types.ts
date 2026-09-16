/**
 * Tracker (Engine1) contracts — spec v1.4.
 * Fully deterministic monitoring engine: no LLM calls, no interpretation.
 */

import type { SessionKind } from "./calendar.js";

export const TRACKER_SCHEMA_VERSION = 1;

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

export type ContextFlag = "earnings_window";

/**
 * §3 live quant state as embedded in every message (§4).
 * Any field not computable under the insufficient-history rule (§3.11) is
 * null — downstream treats null as "not computable", never zero.
 */
export type QuantContext = {
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
  session: SessionKind;
};

export type NewsItemPayload = {
  headline: string;
  source: string;
  url: string;
  published_at: string;
  article_id: string;
  summary: string;
};

export type FilingItemPayload = {
  form_type: string;
  accession_number: string;
  filed_at: string;
  item_codes: string[];
  filing_url: string;
};

export type InsiderFilingPayload = {
  insider_name: string;
  role: string;
  transaction_code: string;
  is_10b5_1_plan: boolean;
  shares: number | null;
  value: number | null;
  /** Trade execution date from the ownership XML — filings lag it by up to
   * two business days, so window logic anchors here (null if unparseable). */
  transaction_date: string | null;
  filed_at: string;
  filing_url: string;
};

export type ScheduledEventPayload = {
  event_type: "earnings";
  due_at: string;
  fiscal_period: string;
  earnings_rhythm: number | null;
  rescheduled: boolean;
  previous_due_at: string | null;
};

export type GapEventPayload = {
  gap_pct: number;
  gap_z: number;
  direction: "up" | "down";
  prev_close: number;
  open_price: number;
};

export type VolumeAnomalyPayload = {
  volume_ratio: number;
  threshold_crossed: number;
  /** Emitted by a catch-up run after the measured session's own NY day. */
  catch_up: boolean;
};

export type SilenceAnomalyPayload = {
  expected_daily_article_rate: number;
  trading_days_silent: number;
  next_earnings_due_at: string | null;
  catch_up: boolean;
};

export type FilingOverduePayload = {
  expected_form: string;
  expected_by_date: string;
  business_days_overdue: number;
  historical_median_lag_days: number;
  catch_up: boolean;
};

export type UnexplainedMovePayload = {
  residual_zscore: number;
  /** "residual_zscore" normally; "move_zscore" under the low-R² fallback (§5.5). */
  measure_used: "residual_zscore" | "move_zscore";
  direction: "up" | "down";
  volume_ratio: number | null;
  news_items_since_prev_close: number;
  catch_up: boolean;
};

export type DriftEventPayload = {
  momentum_5d: number;
  drift_z: number;
  direction: "up" | "down";
  news_items_last_5d: number;
  catch_up: boolean;
};

export type NewsBurstPayload = {
  articles_last_24h: number;
  baseline_daily_rate: number;
  burst_multiple: number;
};

export type InsiderClusterTransaction = {
  insider_name: string;
  transaction_code: string;
  is_10b5_1_plan: boolean;
  /** Execution date the cluster window is anchored on (filed_at fallback). */
  transaction_date: string | null;
  filed_at: string;
  /**
   * Notional in USD. Never null on a counted transaction: the §5.8 notional
   * filter excludes any transaction whose value is not computable, so
   * everything that reaches the cluster carries one.
   */
  value: number;
};

export type InsiderClusterPayload = {
  window_business_days: number;
  insider_count: number;
  direction: "buy" | "sell";
  /** Sum of the counted transactions' notionals — conviction, not just headcount. */
  total_notional: number;
  transactions: InsiderClusterTransaction[];
};

export type TrackerPayload =
  | NewsItemPayload
  | FilingItemPayload
  | InsiderFilingPayload
  | ScheduledEventPayload
  | GapEventPayload
  | VolumeAnomalyPayload
  | SilenceAnomalyPayload
  | FilingOverduePayload
  | UnexplainedMovePayload
  | DriftEventPayload
  | NewsBurstPayload
  | InsiderClusterPayload;

/** §4 message envelope. */
export type TrackerMessage = {
  id: string;
  schema_version: number;
  type: TrackerMessageType;
  ticker: string;
  timestamp: string;
  source_engine: "tracker";
  context_flags: ContextFlag[];
  quant_context: QuantContext;
  payload: TrackerPayload;
};

// ---------------------------------------------------------------------------
// Persisted per-ticker state
// ---------------------------------------------------------------------------

export type DailyBar = {
  /** NY trading date "YYYY-MM-DD". */
  d: string;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Split-adjusted volume. */
  v: number;
};

export type FilingRecord = {
  form: string;
  accessionNumber: string;
  filedAt: string; // "YYYY-MM-DD"
  /** EDGAR acceptance timestamp (ISO) — resolves bmo/amc for earnings 8-Ks. */
  acceptedAt: string | null;
  reportDate: string | null; // period end "YYYY-MM-DD"
  /** 8-K item codes, straight from the submissions index (e.g. ["2.02","9.01"]). */
  items: string[];
  primaryDocument: string | null;
};

export type EarningsRecord = {
  date: string; // announcement date "YYYY-MM-DD"
  fiscalPeriod: string;
  hour: string | null; // "bmo" | "amc" | "dmh" | null
};

export type InsiderTxnRecord = {
  accessionNumber: string;
  insiderName: string;
  role: string;
  transactionCode: string;
  is10b51Plan: boolean;
  shares: number | null;
  value: number | null;
  /** Trade execution date "YYYY-MM-DD" (cluster window anchor); null if the
   * XML carried none — filedAt then stands in. */
  transactionDate: string | null;
  filedAt: string; // ISO
  direction: "buy" | "sell" | null;
};

/** Edge-triggered detector state (§5 firing model). */
export type EdgeDetectorState = {
  active: boolean;
  lastFiredAt: string | null;
  /**
   * The value that triggered the last fire. Persisted across a reset — the
   * 1.5x escalation rule compares against it, so clearing it on re-arm would
   * silently disable escalation for the next episode.
   */
  lastFiredValue: number | null;
  /** news_burst hysteresis: day the condition last went false. */
  falseSinceDay: string | null;
};

/**
 * insider_cluster carries the membership of the reported cluster, since it
 * re-fires only when a new insider joins (§5.8). No other detector has a
 * concept of members, so the field lives on this type alone.
 */
export type InsiderClusterDetectorState = EdgeDetectorState & {
  lastClusterInsiders: string[];
};

/** Snapshot detector state: once per trading day unless escalation (§5). */
export type SnapshotDetectorState = {
  lastFiredDay: string | null;
  lastFiredValue: number | null;
};

export type ChannelHealth = {
  last_success_at: string | null;
  last_error: string | null;
};

export type TickerState = {
  ticker: string;
  addedAt: string;
  backfilledAt: string | null;
  /**
   * Form 4 detail parsing is a second, slower backfill phase (one SEC request
   * per filing), run in the background so the core subsystems of every ticker
   * go live first. Null until that phase completes for this ticker.
   */
  insiderBackfilledAt: string | null;
  /**
   * Form 4 ingest tally: how many filings were fetched, how many the XML
   * parser understood, and how many survived the open-market P/S filter.
   * `kept` is far below `parsed` by design — most Form 4s are grants (A),
   * tax withholding (F), gifts (G) or option exercises (M).
   */
  insiderParse: { attempted: number; parsed: number; kept: number };
  /**
   * Accession numbers of Form 4s already fetched, including those the
   * open-market filter discarded. Without this the dropped ones look unseen
   * and get re-downloaded on every cycle, forever.
   */
  insiderScanned: string[];
  cik: string | null;
  bars: DailyBar[]; // trailing ≥ 252 adjusted daily bars
  barsAsOf: string | null; // last trading day covered
  filings: FilingRecord[];
  insiderTxns: InsiderTxnRecord[];
  earnings: EarningsRecord[]; // past announcements (most recent last)
  /**
   * Upcoming earnings from the calendar. Only the nearest few dates are
   * company-announced; anything further out is the provider's own projection
   * off the historical cadence, so it carries `confirmed: false` and never
   * produces a scheduled_event (§2.3).
   */
  scheduledEarnings: Array<{ dueAt: string; fiscalPeriod: string; confirmed: boolean }>;
  /**
   * (ticker, due_at) pairs a scheduled_event has been emitted for (§2.3
   * dedupe). Tracked explicitly rather than by diffing against the previous
   * calendar snapshot: the initial backfill writes the snapshot without
   * emitting, so a diff-based rule never announced the first-loaded dates.
   */
  scheduledEmitted: Array<{ fiscalPeriod: string; dueAt: string }>;
  /** article counts per trading day (baseline window), keyed by "YYYY-MM-DD". */
  newsCounts: Record<string, number>;
  seenArticleIds: string[];
  /** ISO timestamps of accepted news items (for burst / since-close counts). */
  newsTimestamps: string[];
  detectors: {
    gap: SnapshotDetectorState;
    volume: SnapshotDetectorState;
    unexplained: SnapshotDetectorState;
    silence: EdgeDetectorState;
    filingOverdue: EdgeDetectorState;
    drift: EdgeDetectorState;
    newsBurst: EdgeDetectorState;
    insiderCluster: InsiderClusterDetectorState;
  };
  health: {
    news: ChannelHealth;
    filings: ChannelHealth;
    calendar: ChannelHealth;
    price: ChannelHealth;
  };
  /**
   * The §3 quant state as of the last close-run, persisted so the stored state
   * is self-describing: without it the numbers exist only inside emitted
   * messages and have to be recomputed to be read at all.
   */
  quant: QuantContext | null;
  /** Trading day `quant` describes. */
  quantAsOf: string | null;
  lastCloseComputedFor: string | null; // trading day of last close-run
  lastGapCheckedFor: string | null;
  /** Per-ticker channel cursors so a sweep can resume across cycles (§2). */
  lastNewsPollAt: string | null;
  lastFilingCheckAt: string | null;
};

/** T7 — per-channel HTTP 429 count for one ET day. */
export type RateLimitTally = {
  day: string; // NY "YYYY-MM-DD"
  news: number;
  calendar: number;
  filings: number;
  price: number;
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
    health: TickerState["health"];
  }>;
  messagesEmitted: number;
  lastMessageAt: string | null;
  /** Today's 429 tally per channel (resets at ET midnight). */
  rateLimits: RateLimitTally;
};
