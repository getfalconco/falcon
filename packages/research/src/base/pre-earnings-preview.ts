/**
 * Pre-earnings preview cap — deterministic, Base-side, no prompt change.
 *
 * The week before a release the feed fills with "what to watch" articles the
 * Classifier may label `earnings_results / high`. With the propagation loop
 * live that would mint runs off previews and dirty the rubric. Rule
 * (config.classifier.preEarningsPreview):
 *
 *   event_type ∈ eventTypes (default earnings_results)
 *   AND the ticker has a known earnings due_at with 0 ≤ due_at − published_at ≤ windowDays
 *   AND published_at < due_at
 *   → materiality capped to "low", classification carries `pre_earnings_preview: true`
 *   → never a propagation candidate; re-score contribution is the low cell.
 *
 * Fires only on a known calendar: scheduled_event messages in the stream
 * (T5's announce ledger) and/or an explicit ticker → due_at map from the
 * Tracker's persisted `scheduledEarnings`. `guidance` is not in the default
 * list — a company's own pre-announcement is a real event.
 */

import type {
  NewsItemPayload,
  ScheduledEventPayload,
} from "../tracker/types.js";
import type { MessageClassification, VerdictLookup } from "./classification.js";
import type { BaseConfig } from "./config.js";
import type { BaseMessage } from "./types.js";

/** ticker → known earnings due_at instants (ISO). */
export type EarningsCalendar = Map<string, string[]>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar from the scheduled_event messages in a stream. */
export function earningsCalendarFromMessages(messages: Iterable<BaseMessage>): EarningsCalendar {
  const out: EarningsCalendar = new Map();
  for (const m of messages) {
    if (m.type !== "scheduled_event") continue;
    const p = m.payload as Partial<ScheduledEventPayload>;
    if (typeof p.due_at !== "string" || Number.isNaN(Date.parse(p.due_at))) continue;
    addDueAt(out, m.ticker, p.due_at);
  }
  return out;
}

export function addDueAt(calendar: EarningsCalendar, ticker: string, dueAt: string): void {
  const key = ticker.toUpperCase();
  const list = calendar.get(key) ?? [];
  if (!list.includes(dueAt)) list.push(dueAt);
  calendar.set(key, list);
}

/** Merge calendars (stream-derived + explicit Tracker ledger). */
export function mergeCalendars(...calendars: Array<EarningsCalendar | null | undefined>): EarningsCalendar {
  const out: EarningsCalendar = new Map();
  for (const c of calendars) {
    if (!c) continue;
    for (const [ticker, list] of c) for (const d of list) addDueAt(out, ticker, d);
  }
  return out;
}

/** The article's publication instant: payload.published_at, else the message timestamp. */
export function publishedAtOf(message: BaseMessage): string {
  if (message.type === "news_item") {
    const p = message.payload as Partial<NewsItemPayload>;
    if (typeof p.published_at === "string" && !Number.isNaN(Date.parse(p.published_at))) return p.published_at;
  }
  return message.timestamp;
}

/**
 * The due_at that makes `publishedAt` a preview, or null: the earliest known
 * due_at strictly after publication and within the window.
 */
export function previewDueAt(
  calendar: EarningsCalendar,
  ticker: string,
  publishedAt: string,
  windowDays: number,
): string | null {
  const list = calendar.get(ticker.toUpperCase());
  if (!list || list.length === 0) return null;
  const pub = Date.parse(publishedAt);
  if (Number.isNaN(pub)) return null;
  let best: string | null = null;
  for (const due of list) {
    const d = Date.parse(due);
    if (Number.isNaN(d)) continue;
    const delta = d - pub;
    if (delta <= 0) continue; // published at/after the release → not a preview
    if (delta > windowDays * DAY_MS) continue;
    if (best === null || d < Date.parse(best)) best = due;
  }
  return best;
}

/** Apply the cap to one classification. Pure. */
export function capPreEarningsPreview(
  message: BaseMessage,
  classification: MessageClassification,
  calendar: EarningsCalendar,
  config: BaseConfig,
): MessageClassification {
  const rule = config.classifier.preEarningsPreview;
  if (!rule?.enabled) return classification;
  if (classification.state !== "classified") return classification;
  if (classification.entry.relevance === "none") return classification;
  if (!rule.eventTypes.includes(classification.verdict.event_type)) return classification;
  const due = previewDueAt(calendar, message.ticker, publishedAtOf(message), rule.windowDays);
  if (!due) return classification;
  if (classification.entry.materiality === "low" && classification.pre_earnings_preview) return classification;
  return {
    ...classification,
    entry: { ...classification.entry, materiality: "low" },
    pre_earnings_preview: true,
  };
}

/** Wrap a lookup so every classified verdict passes through the cap. */
export function withPreEarningsPreviewCap(
  lookup: VerdictLookup,
  calendar: EarningsCalendar,
  config: BaseConfig,
): VerdictLookup {
  if (!config.classifier.preEarningsPreview?.enabled || calendar.size === 0) return lookup;
  return (message) => capPreEarningsPreview(message, lookup(message), calendar, config);
}
