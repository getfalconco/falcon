/**
 * Desktop notifications, as the renderer and the main process agree on them.
 *
 * The settings live in main (main/notifications), because main is what fires
 * a notification: the renderer may not even be open. Everything here is plain
 * data and pure functions, so the store and the gate can be tested without
 * Electron.
 */

/** Every kind of notification Falcon can send, one switch each. */
export const NOTIFICATION_CATEGORIES = ["secondOrderSignals", "marketEvents", "appUpdates", "agents"] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * The categories the reader can switch off. The rest are always on: they are
 * part of what Falcon is for, so the pane shows no switch for them and a value
 * stored by an older version is read as on.
 */
export const SWITCHABLE_NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = ["agents"];

export function isSwitchableCategory(key: NotificationCategory): boolean {
  return SWITCHABLE_NOTIFICATION_CATEGORIES.includes(key);
}

/** "HH:MM", 24-hour, local time. */
export type ClockTime = string;

export type NotificationSettings = {
  /** The master switch. Off, nothing is sent, whatever the categories say. */
  enabled: boolean;
  categories: Record<NotificationCategory, boolean>;
  /** Off, notifications arrive without the system sound. */
  sound: boolean;
  /** A daily window in which nothing is sent. May wrap past midnight. */
  quietHours: { enabled: boolean; start: ClockTime; end: ClockTime };
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  categories: { secondOrderSignals: true, marketEvents: true, appUpdates: true, agents: true },
  sound: true,
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
};

/** Whether a category can fire on this install today, and why not. */
export type NotificationSourceState = { available: boolean; note: string | null };

/** What the Notifications pane reads: the settings and what the machine allows. */
export type NotificationsState = {
  settings: NotificationSettings;
  /** False where the OS has no notification service Electron can reach. */
  supported: boolean;
  /** True where the app can open the OS page that governs its notifications. */
  canOpenSystemSettings: boolean;
  sources: Record<NotificationCategory, NotificationSourceState>;
};

/** A partial update from the pane; anything left out keeps its value. */
export type NotificationSettingsPatch = {
  enabled?: boolean;
  categories?: Partial<Record<NotificationCategory, boolean>>;
  sound?: boolean;
  quietHours?: Partial<NotificationSettings["quietHours"]>;
};

export type TestNotificationResult =
  | { ok: true; shown: boolean }
  | { ok: false; error: string };

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isClockTime(value: unknown): value is ClockTime {
  return typeof value === "string" && CLOCK.test(value);
}

/** Minutes since local midnight for "HH:MM". */
export function clockMinutes(value: ClockTime): number {
  const [h, m] = value.split(":").map((n) => Number.parseInt(n, 10));
  return h * 60 + m;
}

/**
 * Settings from anything — a file someone edited by hand, an old version, a
 * renderer bug. Every field falls back to its default on its own, so one bad
 * value never costs the reader the rest of their choices.
 */
export function normalizeNotificationSettings(raw: unknown): NotificationSettings {
  const d = DEFAULT_NOTIFICATION_SETTINGS;
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const cats = src.categories && typeof src.categories === "object" ? (src.categories as Record<string, unknown>) : {};
  const quiet = src.quietHours && typeof src.quietHours === "object" ? (src.quietHours as Record<string, unknown>) : {};
  const categories = {} as Record<NotificationCategory, boolean>;
  for (const key of NOTIFICATION_CATEGORIES)
    categories[key] = isSwitchableCategory(key) ? bool(cats[key], d.categories[key]) : true;
  return {
    enabled: bool(src.enabled, d.enabled),
    categories,
    sound: bool(src.sound, d.sound),
    quietHours: {
      enabled: bool(quiet.enabled, d.quietHours.enabled),
      start: isClockTime(quiet.start) ? quiet.start : d.quietHours.start,
      end: isClockTime(quiet.end) ? quiet.end : d.quietHours.end,
    },
  };
}

/** The settings with a patch laid over them, normalized again. */
export function applyNotificationPatch(
  current: NotificationSettings,
  patch: NotificationSettingsPatch | null | undefined,
): NotificationSettings {
  const p = patch && typeof patch === "object" ? patch : {};
  return normalizeNotificationSettings({
    ...current,
    ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
    ...(p.sound !== undefined ? { sound: p.sound } : {}),
    categories: { ...current.categories, ...(p.categories ?? {}) },
    quietHours: { ...current.quietHours, ...(p.quietHours ?? {}) },
  });
}

/**
 * Inside the quiet window at `now` (local time). The window runs from start
 * up to, not including, end, and wraps midnight when end is earlier than
 * start. Equal start and end is an empty window, never a whole day.
 */
export function isQuietTime(quiet: NotificationSettings["quietHours"], now: Date): boolean {
  if (!quiet.enabled) return false;
  const start = clockMinutes(quiet.start);
  const end = clockMinutes(quiet.end);
  if (start === end) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** The one gate every notification passes: master switch, category, quiet hours. */
export function shouldNotify(settings: NotificationSettings, category: NotificationCategory, now: Date): boolean {
  if (!settings.enabled) return false;
  if (!settings.categories[category]) return false;
  return !isQuietTime(settings.quietHours, now);
}
