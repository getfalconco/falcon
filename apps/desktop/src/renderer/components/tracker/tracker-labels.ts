import type { MessageKey, TFunction } from "@/lib/i18n";
import type { TrackerMessageType } from "../../../shared/tracker-types";

/**
 * The chip a Tracker message type reads as, in the reader's language. The
 * shared contract keeps its English TRACKER_TYPE_LABELS for main-side logs;
 * the panels (Tracker stream, Base incident rows) go through here instead.
 * An unknown type shows as itself, as it did before.
 */
const TYPE_KEYS: Record<TrackerMessageType, MessageKey> = {
  news_item: "instruments.tracker.type.news_item",
  filing_item: "instruments.tracker.type.filing_item",
  insider_filing: "instruments.tracker.type.insider_filing",
  scheduled_event: "instruments.tracker.type.scheduled_event",
  gap_event: "instruments.tracker.type.gap_event",
  volume_anomaly: "instruments.tracker.type.volume_anomaly",
  silence_anomaly: "instruments.tracker.type.silence_anomaly",
  filing_overdue: "instruments.tracker.type.filing_overdue",
  unexplained_move: "instruments.tracker.type.unexplained_move",
  drift_event: "instruments.tracker.type.drift_event",
  news_burst: "instruments.tracker.type.news_burst",
  insider_cluster: "instruments.tracker.type.insider_cluster",
};

export function trackerTypeLabel(t: TFunction, type: TrackerMessageType): string {
  const key = TYPE_KEYS[type];
  return key ? t(key) : type;
}
