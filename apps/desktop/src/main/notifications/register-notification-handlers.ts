import { registerIpcHandler } from "../ipc-register";
import { resolveDataRoot } from "../data-root";
import { onUpdateStatusChange, updateChecksEnabled } from "../update/update-service";
import type { NotificationSettingsPatch, NotificationsState } from "../../shared/notification-settings";
import { writeNotificationSettings } from "./notification-settings-store";
import {
  getNotificationsState,
  notify,
  openSystemNotificationSettings,
  sendTestNotification,
  setNotificationSource,
} from "./notifier";
import { startSignalWatcher } from "./signal-watcher";
import { mt } from "../i18n";

function failure(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/** Settings → Notifications: read the state, change a setting, test, open the OS page. */
export function registerNotificationHandlers(): void {
  registerIpcHandler("notifications:get-state", (): { ok: true; state: NotificationsState } | { ok: false; error: string } => {
    try {
      return { ok: true, state: getNotificationsState() };
    } catch (err) {
      return failure(err);
    }
  });

  registerIpcHandler(
    "notifications:update",
    (_event, patch: NotificationSettingsPatch): { ok: true; state: NotificationsState } | { ok: false; error: string } => {
      try {
        writeNotificationSettings(resolveDataRoot(), patch ?? {});
        return { ok: true, state: getNotificationsState() };
      } catch (err) {
        return failure(err);
      }
    },
  );

  registerIpcHandler("notifications:test", () => sendTestNotification());

  registerIpcHandler("notifications:open-system-settings", async () => {
    try {
      return (await openSystemNotificationSettings())
        ? { ok: true as const }
        : { ok: false as const, error: mt("notify.systemSettingsMissing") };
    } catch (err) {
      return failure(err);
    }
  });
}

/**
 * "A newer Falcon is ready" as a notification, once per version: the update
 * pill only helps a reader who is looking at the window. Electron-updater can
 * report the same download again on a later re-check, hence the set.
 */
function startUpdateNotifications(): void {
  if (!updateChecksEnabled()) return;
  setNotificationSource("appUpdates", { available: true, note: null });
  const announced = new Set<string>();
  onUpdateStatusChange((status) => {
    if (status.kind === "idle") return;
    const key = `${status.kind}:${status.version}`;
    if (announced.has(key)) return;
    announced.add(key);
    notify(
      "appUpdates",
      status.kind === "ready"
        ? { title: mt("notify.update.readyTitle"), body: mt("notify.update.readyBody", { version: status.version }) }
        : { title: mt("notify.update.availableTitle"), body: mt("notify.update.availableBody", { version: status.version }) },
    );
  });
}

/** The notification sources that live outside any one engine. Call once the app is ready. */
export function bootstrapNotifications(): void {
  startUpdateNotifications();
  startSignalWatcher();
}
