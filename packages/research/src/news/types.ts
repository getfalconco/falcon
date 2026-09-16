import type {
  EventDirection,
  EventType,
  DailyEventsFile,
} from "../propagation/event-types.js";
import type { MaterialNewsEvent } from "../propagation/types.js";

export { EVENT_TYPES } from "../propagation/event-types.js";
export type { EventDirection, EventType, DailyEventsFile, MaterialNewsEvent };

/** Live status of the news poll, surfaced to the desktop UI / worker logs. */
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
