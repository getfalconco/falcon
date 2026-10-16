import { useSyncExternalStore } from "react";

/**
 * The reader's time zone (Settings, General): "system" follows this machine,
 * anything else is an IANA zone the reader picked. The Calendar tab places
 * every event, and groups every day, in this zone; the dashboard's calendar
 * card prints its times in it.
 *
 * Kept in this browser, like the other General choices. Safe to import from
 * node-side tests: storage and window are reached only inside try/catch.
 */

export const TIME_ZONE_KEY = "falcon.ui.timeZone";

export type TimeZoneChoice = "system" | string;

type Reader = Pick<Storage, "getItem">;

function defaultStorage(): Reader | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Whether the runtime knows the zone by that name. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function readTimeZoneChoice(storage: Reader | null = defaultStorage()): TimeZoneChoice {
  try {
    const raw = storage?.getItem(TIME_ZONE_KEY);
    if (raw && isTimeZone(raw)) return raw;
  } catch {
    /* storage is not always there */
  }
  return "system";
}

export function writeTimeZoneChoice(choice: TimeZoneChoice): void {
  const next = choice !== "system" && isTimeZone(choice) ? choice : "system";
  try {
    if (next === "system") localStorage.removeItem(TIME_ZONE_KEY);
    else localStorage.setItem(TIME_ZONE_KEY, next);
  } catch {
    /* holds for this session */
  }
  current = next;
  for (const fn of listeners) fn();
}

/** The zone in force, as an IANA name: the reader's pick, or this machine's. */
export function resolveTimeZone(choice: TimeZoneChoice = readTimeZoneChoice()): string {
  return choice === "system" ? systemTimeZone() : choice;
}

// --- The list the picker shows ------------------------------------------------

/** The zones the runtime knows, or a short list of the common ones when it cannot say. */
export function allTimeZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    if (Array.isArray(list) && list.length > 0) return list.includes("UTC") ? list : [...list, "UTC"];
  } catch {
    /* an older runtime */
  }
  return [
    "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
    "America/Toronto", "America/Sao_Paulo", "UTC", "Europe/London", "Europe/Dublin", "Europe/Lisbon", "Europe/Paris", "Europe/Berlin",
    "Europe/Madrid", "Europe/Rome", "Europe/Zurich", "Europe/Amsterdam", "Europe/Stockholm", "Europe/Warsaw", "Europe/Athens",
    "Europe/Istanbul", "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Shanghai",
    "Asia/Tokyo", "Asia/Seoul", "Australia/Sydney", "Pacific/Auckland",
  ];
}

/** "UTC+3", "UTC-4", "UTC+5:30", "UTC" for a zone at an instant. */
export function utcOffsetLabel(zone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    const m = part ? /([+-])(\d{1,2})(?::(\d{2}))?/.exec(part) : null;
    if (!m) return "UTC";
    return `UTC${m[1]}${Number(m[2])}${m[3] && m[3] !== "00" ? `:${m[3]}` : ""}`;
  } catch {
    return "UTC";
  }
}

/** The offset in minutes, for sorting the list west to east. */
export function utcOffsetMinutes(zone: string, at: Date = new Date()): number {
  const label = utcOffsetLabel(zone, at);
  const m = /^UTC([+-])(\d+)(?::(\d{2}))?$/.exec(label);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** "Istanbul", "New York", "Buenos Aires": the city part of the zone's name. */
export function zoneCity(zone: string): string {
  if (zone === "UTC" || zone === "Etc/UTC") return "UTC";
  const last = zone.split("/").pop() ?? zone;
  return last.replace(/_/g, " ");
}

/** "Eastern Time", "Türkiye Saati": the zone's own name in the reader's language, when the runtime has one. */
export function zoneLongName(zone: string, locale: string, at: Date = new Date()): string | null {
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "longGeneric" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    // A runtime with no name of its own prints the offset back ("GMT+03:00"): that adds nothing to the city.
    return part && !/^(GMT|UTC)([+-]|$)/.test(part) ? part : null;
  } catch {
    return null;
  }
}

export type ZoneOption = { zone: string; city: string; offset: string; offsetMinutes: number; name: string | null };

/** Every zone with its labels, west to east, then by city. */
export function zoneOptions(locale: string, at: Date = new Date()): ZoneOption[] {
  return allTimeZones()
    .map((zone) => ({ zone, city: zoneCity(zone), offset: utcOffsetLabel(zone, at), offsetMinutes: utcOffsetMinutes(zone, at), name: zoneLongName(zone, locale, at) }))
    .sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.city.localeCompare(b.city, locale));
}

/** Folds case and accents, so "sao paulo" finds São Paulo and "istanbul" İstanbul. */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .toLowerCase();
}

export function matchesZone(option: ZoneOption, query: string): boolean {
  const q = foldText(query.trim());
  if (!q) return true;
  return [option.zone, option.city, option.offset, option.name ?? ""].some((s) => foldText(s).includes(q));
}

// --- Live subscription ------------------------------------------------------

let current: TimeZoneChoice | null = null;
const listeners = new Set<() => void>();

function snapshot(): TimeZoneChoice {
  if (current === null) current = readTimeZoneChoice();
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== TIME_ZONE_KEY) return;
    current = readTimeZoneChoice();
    fn();
  };
  try {
    window.addEventListener("storage", onStorage);
  } catch {
    /* no window */
  }
  return () => {
    listeners.delete(fn);
    try {
      window.removeEventListener("storage", onStorage);
    } catch {
      /* no window */
    }
  };
}

export function useTimeZoneChoice(): TimeZoneChoice {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The zone in force (an IANA name), following changes. */
export function useTimeZone(): string {
  return resolveTimeZone(useTimeZoneChoice());
}
