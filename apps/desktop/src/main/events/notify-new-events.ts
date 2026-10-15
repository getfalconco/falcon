import type { MaterialNewsEvent } from "../../shared/news-events.js";
import { notify } from "../notifications/notifier";
import { mt, mtCount } from "../i18n";

function directionMark(dir: MaterialNewsEvent["direction_on_primary"]): string {
  if (dir === "positive") return "▲";
  if (dir === "negative") return "▼";
  return "•";
}

function eventLine(e: MaterialNewsEvent): string {
  return `${directionMark(e.direction_on_primary)} ${e.affected_ticker}: ${e.summary}`;
}

/**
 * Show a native desktop notification summarizing newly detected material events.
 * Goes through the notifier, so the reader's settings (Market events, quiet
 * hours, sound) apply, and it stays a no-op where notifications are
 * unsupported (e.g. headless CI) so a poll never fails.
 */
export function notifyNewEvents(events: MaterialNewsEvent[]): void {
  if (events.length === 0) return;

  const count = events.length;
  const title = mtCount("notify.events.titleOne", "notify.events.titleOther", count);

  const shown = events.slice(0, 3).map(eventLine);
  if (count > shown.length) {
    shown.push(mt("notify.more", { count: count - shown.length }));
  }

  notify("marketEvents", { title, body: shown.join("\n") });
}
