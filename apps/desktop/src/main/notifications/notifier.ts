import { BrowserWindow, Notification, shell } from "electron";
import { resolveDataRoot } from "../data-root";
import {
  shouldNotify,
  type NotificationCategory,
  type NotificationSourceState,
  type NotificationsState,
  type TestNotificationResult,
} from "../../shared/notification-settings";
import { readNotificationSettings } from "./notification-settings-store";
import { mt, type MainMessageKey } from "../i18n";

/**
 * The one door every desktop notification goes through. A source asks
 * `notify(category, …)`; this checks the reader's settings (master switch,
 * the category, quiet hours, sound) and whether the OS can show one at all,
 * then shows it. No source calls `new Notification` itself, so a setting can
 * never be skipped by a code path that forgot it.
 *
 * Sources also report here whether they can fire on this install, so the
 * Notifications pane can grey out a switch that would do nothing.
 */

/**
 * Notes are kept as message keys and put into words when the pane asks, so
 * they follow a language change made after the source reported.
 */
type SourceState = { available: boolean; note: MainMessageKey | null };

const sources: Record<NotificationCategory, SourceState> = {
  secondOrderSignals: { available: false, note: "notify.source.notRunning" },
  marketEvents: { available: false, note: "notify.source.marketEvents" },
  appUpdates: { available: false, note: "notify.source.updates" },
  agents: { available: true, note: null },
};

/** A source says whether it can fire here, and if not, why. */
export function setNotificationSource(category: NotificationCategory, state: SourceState): void {
  sources[category] = state;
}

/** The OS page that governs this app's notifications, where there is one. */
function systemSettingsUrl(): string | null {
  if (process.platform === "win32") return "ms-settings:notifications";
  if (process.platform === "darwin") return "x-apple.systempreferences:com.apple.preference.notifications";
  return null;
}

export function getNotificationsState(): NotificationsState {
  return {
    settings: readNotificationSettings(resolveDataRoot()),
    supported: Notification.isSupported(),
    canOpenSystemSettings: systemSettingsUrl() !== null,
    sources: Object.fromEntries(
      Object.entries(sources).map(([category, s]) => [category, { available: s.available, note: s.note ? mt(s.note) : null }]),
    ) as Record<NotificationCategory, NotificationSourceState>,
  };
}

export async function openSystemNotificationSettings(): Promise<boolean> {
  const url = systemSettingsUrl();
  if (!url) return false;
  await shell.openExternal(url);
  return true;
}

/** Bring the app window back to the foreground when a notification is clicked. */
function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Notifications with a click action, kept alive until they close. */
const liveNotifications = new Set<Notification>();
const LIVE_NOTIFICATION_MS = 30 * 60_000;

/**
 * Show a notification if the reader's settings allow it now. Returns whether
 * one was shown. Never throws: a notification that cannot be shown must not
 * fail the poll or the update check that asked for it.
 */
export function notify(
  category: NotificationCategory,
  content: { title: string; body: string },
  /** Runs after the window is focused, e.g. to tell the renderer what to open. */
  options: { onClick?: () => void } = {},
): boolean {
  try {
    if (!Notification.isSupported()) return false;
    const settings = readNotificationSettings(resolveDataRoot());
    if (!shouldNotify(settings, category, new Date())) return false;
    const notification = new Notification({ title: content.title, body: content.body, silent: !settings.sound });
    notification.on("click", () => {
      focusMainWindow();
      try {
        options.onClick?.();
      } catch (err) {
        console.warn(`[notifications] ${category} click handler failed:`, err instanceof Error ? err.message : err);
      }
    });
    // A notification nothing references can be collected while it is still on
    // screen, and its click then goes nowhere. Hold it until it closes, or for
    // a while when the OS never says.
    if (options.onClick) {
      liveNotifications.add(notification);
      const release = () => liveNotifications.delete(notification);
      notification.on("close", release);
      setTimeout(release, LIVE_NOTIFICATION_MS).unref?.();
    }
    notification.show();
    return true;
  } catch (err) {
    console.warn(`[notifications] ${category} failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** How long the test waits for the OS to confirm it showed the notification. */
const TEST_CONFIRM_MS = 4_000;

/**
 * The pane's "Send test notification". Deliberately ignores the master switch,
 * the categories and quiet hours — the reader is asking whether the OS lets
 * Falcon through at all — but keeps the sound choice, so they hear what a
 * real one sounds like. `shown` is the OS's own answer where it gives one; a
 * notification Windows suppresses (Focus, app turned off) may still report
 * shown, which is why the pane links to the system settings either way.
 */
export function sendTestNotification(): Promise<TestNotificationResult> {
  if (!Notification.isSupported()) {
    return Promise.resolve({ ok: false, error: mt("notify.test.unsupported") });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: TestNotificationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: true, shown: false }), TEST_CONFIRM_MS);
    try {
      const settings = readNotificationSettings(resolveDataRoot());
      const notification = new Notification({
        title: "Falcon",
        body: mt("notify.test.body"),
        silent: !settings.sound,
      });
      notification.on("click", focusMainWindow);
      notification.on("show", () => finish({ ok: true, shown: true }));
      notification.on("failed", (_event, error) => finish({ ok: false, error: error || mt("notify.test.refused") }));
      notification.show();
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
