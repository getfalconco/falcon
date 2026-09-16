import { BrowserWindow, Notification } from "electron";
import type { MaterialNewsEvent } from "../../shared/news-events.js";

/** Bring the app window back to the foreground when a notification is clicked. */
function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function directionMark(dir: MaterialNewsEvent["direction_on_primary"]): string {
  if (dir === "positive") return "▲";
  if (dir === "negative") return "▼";
  return "•";
}

function eventLine(e: MaterialNewsEvent): string {
  return `${directionMark(e.direction_on_primary)} ${e.affected_ticker} — ${e.summary}`;
}

/**
 * Show a native desktop notification summarizing newly detected material events.
 * No-op when notifications are unsupported (e.g. headless CI) so a poll never fails.
 */
export function notifyNewEvents(events: MaterialNewsEvent[]): void {
  if (events.length === 0) return;
  if (!Notification.isSupported()) return;

  const count = events.length;
  const title =
    count === 1
      ? `Falcon — new market event`
      : `Falcon — ${count} new market events`;

  const shown = events.slice(0, 3).map(eventLine);
  if (count > shown.length) {
    shown.push(`+${count - shown.length} more`);
  }

  try {
    const notification = new Notification({
      title,
      body: shown.join("\n"),
      silent: false,
    });
    notification.on("click", focusMainWindow);
    notification.show();
  } catch (err) {
    console.warn(
      "[events] notification failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
