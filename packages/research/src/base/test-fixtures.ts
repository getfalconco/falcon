/**
 * Message builders for the Base Engine golden-vector tests.
 *
 * Not exported from the barrel — test support only. Every builder produces a
 * complete Tracker §4 envelope so the tests exercise the same shapes the live
 * stream carries.
 */

import { TRACKER_SCHEMA_VERSION } from "../tracker/types.js";
import type {
  ContextFlag,
  DriftEventPayload,
  FilingItemPayload,
  FilingOverduePayload,
  GapEventPayload,
  InsiderClusterPayload,
  InsiderFilingPayload,
  NewsBurstPayload,
  NewsItemPayload,
  QuantContext,
  ScheduledEventPayload,
  SilenceAnomalyPayload,
  TrackerMessage,
  TrackerMessageType,
  TrackerPayload,
  UnexplainedMovePayload,
  VolumeAnomalyPayload,
} from "../tracker/types.js";
import type { IncidentIdFactory } from "./incident.js";
import type { ScreenPattern, TapeStructureMessage, TapeStructurePayload } from "../screen/types.js";

export const TICKER = "NVDA";

/** A fully-populated quant context; override only what a test cares about. */
export function quant(overrides: Partial<QuantContext> = {}): QuantContext {
  return {
    beta_90d: 1.2,
    r_squared: 0.55,
    daily_vol_30d: 0.021,
    vol_regime: 1.1,
    move_today: 0.031,
    move_zscore: 1.4,
    residual_move: 0.028,
    residual_zscore: 1.3,
    volume_ratio: 1.6,
    volume_ratio_partial: false,
    momentum_5d: 0.02,
    momentum_20d: 0.04,
    momentum_60d: 0.09,
    pct_from_52w_high: -0.08,
    pct_from_52w_low: 0.62,
    earnings_rhythm: 91,
    prev_close: 100,
    last_price: 103.1,
    price_asof: "2026-08-21T20:00:00.000Z",
    session: "regular",
    ...overrides,
  };
}

export type MessageOptions = {
  ticker?: string;
  context_flags?: ContextFlag[];
  quant?: Partial<QuantContext>;
};

export function message(
  id: string,
  type: TrackerMessageType,
  timestamp: string,
  payload: TrackerPayload,
  options: MessageOptions = {},
): TrackerMessage {
  return {
    id,
    schema_version: TRACKER_SCHEMA_VERSION,
    type,
    ticker: options.ticker ?? TICKER,
    timestamp,
    source_engine: "tracker",
    context_flags: options.context_flags ?? [],
    quant_context: quant(options.quant),
    payload,
  };
}

// ---------------------------------------------------------------------------
// Per-type builders
// ---------------------------------------------------------------------------

export function newsItem(
  id: string,
  timestamp: string,
  payload: Partial<NewsItemPayload> = {},
  options: MessageOptions = {},
): TrackerMessage {
  return message(
    id,
    "news_item",
    timestamp,
    {
      headline: `headline ${id}`,
      source: "reuters",
      url: `https://example.test/${id}`,
      published_at: timestamp,
      article_id: `article-${id}`,
      summary: "",
      ...payload,
    },
    options,
  );
}

export function filingItem(
  id: string,
  timestamp: string,
  payload: Partial<FilingItemPayload> = {},
  options: MessageOptions = {},
): TrackerMessage {
  return message(
    id,
    "filing_item",
    timestamp,
    {
      form_type: "8-K",
      accession_number: `0000000000-26-${id}`,
      filed_at: timestamp,
      item_codes: ["2.02"],
      filing_url: `https://sec.example.test/${id}`,
      ...payload,
    },
    options,
  );
}

export function insiderFiling(
  id: string,
  timestamp: string,
  payload: Partial<InsiderFilingPayload> = {},
  options: MessageOptions = {},
): TrackerMessage {
  return message(
    id,
    "insider_filing",
    timestamp,
    {
      insider_name: "Jane Doe",
      role: "CFO",
      transaction_code: "P",
      is_10b5_1_plan: false,
      shares: 1000,
      value: 100_000,
      transaction_date: timestamp.slice(0, 10),
      filed_at: timestamp,
      filing_url: `https://sec.example.test/${id}`,
      ...payload,
    },
    options,
  );
}

export function scheduledEvent(
  id: string,
  timestamp: string,
  dueAt: string,
  payload: Partial<ScheduledEventPayload> = {},
  options: MessageOptions = {},
): TrackerMessage {
  return message(
    id,
    "scheduled_event",
    timestamp,
    {
      event_type: "earnings",
      due_at: dueAt,
      fiscal_period: "Q2 2026",
      earnings_rhythm: 91,
      rescheduled: false,
      previous_due_at: null,
      ...payload,
    },
    options,
  );
}

export function gapEvent(
  id: string,
  timestamp: string,
  payload: Partial<GapEventPayload> = {},
  options: MessageOptions = {},
): TrackerMessage {
  return message(
    id,
    "gap_event",
    timestamp,
    { gap_pct: 0.06, gap_z: 3.5, direction: "up", prev_close: 100, open_price: 106, ...payload },
    options,
  );
}

export function volumeAnomaly(
  id: string,
  timestamp: string,
  payload: Partial<VolumeAnomalyPayload> = {},
  options: MessageOptions = {},
): TrackerMessage {
  return message(
    id,
    "volume_anomaly",
    timestamp,
    { volume_ratio: 6, threshold_crossed: 3, catch_up: false, ...payload },
    options,
  );
}

export function unexplainedMove(
  id: string,
  timestamp: string,
  payload: Partial<UnexplainedMovePayload> = {},
  options: MessageOptions = {},
): TrackerMessage {
  return message(
    id,
    "unexplained_move",
    timestamp,
    {
      residual_zscore: 3.0,
      measure_used: "residual_zscore",
      direction: "up",
      volume_ratio: 2.1,
      news_items_since_prev_close: 0,
      catch_up: false,
      ...payload,
    },
    options,
  );
}

export function driftEvent(
  id: string,
  timestamp: string,
  payload: Partial<DriftEventPayload> = {},
  options: MessageOptions = {},
): TrackerMessage {
  return message(
    id,
    "drift_event",
    timestamp,
    { momentum_5d: 0.07, drift_z: 2.5, direction: "up", news_items_last_5d: 0, catch_up: false, ...payload },
    options,
  );
}

export function newsBurst(
  id: string,
  timestamp: string,
  payload: Partial<NewsBurstPayload> = {},
  options: MessageOptions = {},
): TrackerMessage {
  return message(
    id,
    "news_burst",
    timestamp,
    { articles_last_24h: 22, baseline_daily_rate: 4, burst_multiple: 5.5, ...payload },
    options,
  );
}

export function silenceAnomaly(
  id: string,
  timestamp: string,
  payload: Partial<SilenceAnomalyPayload> = {},
  options: MessageOptions = {},
): TrackerMessage {
  return message(
    id,
    "silence_anomaly",
    timestamp,
    {
      expected_daily_article_rate: 3.2,
      trading_days_silent: 4,
      next_earnings_due_at: null,
      catch_up: false,
      ...payload,
    },
    options,
  );
}

export function filingOverdue(
  id: string,
  timestamp: string,
  payload: Partial<FilingOverduePayload> = {},
  options: MessageOptions = {},
): TrackerMessage {
  return message(
    id,
    "filing_overdue",
    timestamp,
    {
      expected_form: "10-Q",
      expected_by_date: "2026-08-10",
      business_days_overdue: 7,
      historical_median_lag_days: 38,
      catch_up: false,
      ...payload,
    },
    options,
  );
}

export function insiderCluster(
  id: string,
  timestamp: string,
  payload: Partial<InsiderClusterPayload> = {},
  options: MessageOptions = {},
): TrackerMessage {
  return message(
    id,
    "insider_cluster",
    timestamp,
    {
      window_business_days: 10,
      insider_count: 3,
      direction: "buy",
      total_notional: 300_000,
      transactions: [],
      ...payload,
    },
    options,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * S1/S2: a Screen `tape_structure` message. Same envelope as the Tracker's,
 * emitted by Screen — Base treats it as a measurement message.
 */
export function tapeStructure(
  id: string,
  timestamp: string,
  payload: Partial<TapeStructurePayload> = {},
  options: MessageOptions = {},
): TapeStructureMessage {
  const pattern: ScreenPattern = payload.pattern ?? "quiet_accumulation";
  const ticker = options.ticker ?? TICKER;
  const first = payload.first_session ?? timestamp.slice(0, 10);
  return {
    id,
    schema_version: TRACKER_SCHEMA_VERSION,
    type: "tape_structure",
    ticker,
    timestamp,
    source_engine: "screen",
    context_flags: options.context_flags ?? [],
    quant_context: quant(options.quant),
    payload: {
      pattern,
      finding_id: `screen:${ticker}:${pattern}:${first}`,
      first_session: first,
      session: timestamp.slice(0, 10),
      day_count: 1,
      values: { volume_ratio_avg: 1.9 },
      modifiers: [],
      read: `${ticker} ${pattern}`,
      since_first: { covered_from: first, sessions: 1, ret: 0.004, residual_z_cum: 0.6 },
      ...payload,
    },
  };
}

/** Deterministic incident ids so golden vectors can pin them (§8). */
export const seqIds: IncidentIdFactory = (_ticker, _windowStart, index) => `inc-${index}`;

/** ISO instant `minutes` after `iso`. */
export function plusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export function plusHours(iso: string, hours: number): string {
  return plusMinutes(iso, hours * 60);
}
