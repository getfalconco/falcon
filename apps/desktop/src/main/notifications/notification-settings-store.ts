import fs from "node:fs";
import path from "node:path";
import {
  applyNotificationPatch,
  normalizeNotificationSettings,
  type NotificationSettings,
  type NotificationSettingsPatch,
} from "../../shared/notification-settings";

/**
 * Notification settings on this machine, in
 * `<data root>/notifications/settings.json`. Read on every notification
 * rather than cached, so a hand edit or a second window never disagrees with
 * what fires; the file is a few hundred bytes.
 *
 * Nothing here knows about Electron, so it can be driven against a temp dir.
 */

export function notificationSettingsFile(root: string): string {
  return path.join(root, "notifications", "settings.json");
}

/** The stored settings; a missing or unreadable file reads as the defaults. */
export function readNotificationSettings(root: string): NotificationSettings {
  try {
    return normalizeNotificationSettings(JSON.parse(fs.readFileSync(notificationSettingsFile(root), "utf8")));
  } catch {
    return normalizeNotificationSettings(null);
  }
}

/** Lays a patch over the stored settings and writes them back (temp file + rename). */
export function writeNotificationSettings(root: string, patch: NotificationSettingsPatch): NotificationSettings {
  const next = applyNotificationPatch(readNotificationSettings(root), patch);
  const file = notificationSettingsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return next;
}
