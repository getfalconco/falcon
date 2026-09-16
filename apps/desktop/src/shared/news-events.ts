export const EVENT_TYPES = [
  "earnings",
  "guidance",
  "supply_disruption",
  "product_launch",
  "regulatory",
  "partnership",
  "acquisition",
  "litigation",
  "management_change",
  "other",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EventDirection = "positive" | "negative" | "unclear";

export type MaterialNewsEvent = {
  id: string;
  article_id: number;
  ticker: string;
  headline: string;
  source_url: string;
  article_datetime: number;
  classified_at: string;
  is_material_event: true;
  event_type: EventType;
  affected_ticker: string;
  direction_on_primary: EventDirection;
  summary: string;
  confidence: number;
};

export type DailyEventsFile = {
  date: string;
  events: MaterialNewsEvent[];
};

export type EventsPollStatus = {
  running: boolean;
  lastPollAt: string | null;
  lastError: string | null;
  lastNewEvents: number;
  articlesChecked: number;
  /** Human-readable result for UI, e.g. "3 events (42 articles checked)" */
  lastSummary: string | null;
  currentTicker: string | null;
  tickersCompleted: number;
  totalTickers: number;
};
