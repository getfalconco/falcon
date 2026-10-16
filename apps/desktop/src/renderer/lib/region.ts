import { useSyncExternalStore } from "react";
import { REGION_CHOICES } from "../../shared/economic-calendar";

/**
 * The reader's region: the country whose releases the calendar adds to the
 * major economies' (Settings, General). "auto" reads it from this machine:
 * the system time zone first (a reader in Istanbul with an English Windows is
 * in Turkey), then the region part of the system's languages. A region the
 * calendar has no flag and no coverage for reads as none.
 *
 * Kept in this browser, like the other General choices. Every read and write
 * is wrapped: storage can be missing or refuse, and the calendar must draw the
 * same with or without it. Safe to import from node-side tests.
 */

export const REGION_KEY = "falcon.ui.region";
export const REGION_CHANGED = "falcon:region-changed";

export type RegionChoice = "auto" | (typeof REGION_CHOICES)[number];

const CHOICES: ReadonlySet<string> = new Set(REGION_CHOICES);

export function isRegionCode(v: unknown): v is (typeof REGION_CHOICES)[number] {
  return typeof v === "string" && CHOICES.has(v);
}

type Reader = Pick<Storage, "getItem">;

function defaultStorage(): Reader | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readRegionChoice(storage: Reader | null = defaultStorage()): RegionChoice {
  try {
    const raw = storage?.getItem(REGION_KEY);
    if (raw && isRegionCode(raw)) return raw;
  } catch {
    /* storage is not always there */
  }
  return "auto";
}

export function writeRegionChoice(choice: RegionChoice): void {
  try {
    if (choice === "auto") localStorage.removeItem(REGION_KEY);
    else localStorage.setItem(REGION_KEY, choice);
  } catch {
    /* holds for this session through the event below */
  }
  current = choice;
  notify();
}

/**
 * The system zones that name one country plainly. A zone shared by several
 * countries (Europe/Brussels covers Belgium only, but America/Toronto and
 * America/New_York are different countries) is listed by its own.
 */
const ZONE_COUNTRY: Readonly<Record<string, string>> = {
  "Europe/Istanbul": "TR",
  "Asia/Istanbul": "TR",
  "Europe/London": "GB",
  "Europe/Berlin": "DE",
  "Europe/Paris": "FR",
  "Europe/Rome": "IT",
  "Europe/Madrid": "ES",
  "Atlantic/Canary": "ES",
  "Europe/Amsterdam": "NL",
  "Europe/Brussels": "BE",
  "Europe/Vienna": "AT",
  "Europe/Zurich": "CH",
  "Europe/Stockholm": "SE",
  "Europe/Oslo": "NO",
  "Europe/Copenhagen": "DK",
  "Europe/Helsinki": "FI",
  "Europe/Warsaw": "PL",
  "Europe/Lisbon": "PT",
  "Europe/Dublin": "IE",
  "Europe/Athens": "GR",
  "Europe/Prague": "CZ",
  "Europe/Budapest": "HU",
  "Europe/Moscow": "RU",
  "Asia/Tokyo": "JP",
  "Asia/Shanghai": "CN",
  "Asia/Hong_Kong": "HK",
  "Asia/Seoul": "KR",
  "Asia/Taipei": "TW",
  "Asia/Kolkata": "IN",
  "Asia/Calcutta": "IN",
  "Asia/Jakarta": "ID",
  "Asia/Singapore": "SG",
  "Australia/Sydney": "AU",
  "Australia/Melbourne": "AU",
  "Australia/Brisbane": "AU",
  "Australia/Perth": "AU",
  "Australia/Adelaide": "AU",
  "Pacific/Auckland": "NZ",
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "America/Edmonton": "CA",
  "America/Winnipeg": "CA",
  "America/Halifax": "CA",
  "America/Mexico_City": "MX",
  "America/Sao_Paulo": "BR",
  "Africa/Johannesburg": "ZA",
  "Asia/Riyadh": "SA",
  "Asia/Dubai": "AE",
  "Asia/Jerusalem": "IL",
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Denver": "US",
  "America/Los_Angeles": "US",
  "America/Phoenix": "US",
  "America/Anchorage": "US",
  "Pacific/Honolulu": "US",
};

/** The country this machine is in, by its zone and then its languages; null when neither names one the calendar covers. */
export function systemRegion(zone?: string, languages?: readonly string[]): (typeof REGION_CHOICES)[number] | null {
  let tz = zone;
  if (tz === undefined) {
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      tz = undefined;
    }
  }
  const byZone = tz ? ZONE_COUNTRY[tz] : undefined;
  if (byZone && isRegionCode(byZone)) return byZone;
  let langs = languages;
  if (langs === undefined) {
    try {
      langs = typeof navigator !== "undefined" ? navigator.languages : [];
    } catch {
      langs = [];
    }
  }
  for (const tag of langs ?? []) {
    let region: string | undefined;
    try {
      region = new Intl.Locale(tag).maximize().region;
    } catch {
      region = /[-_]([A-Za-z]{2})\b/.exec(tag)?.[1]?.toUpperCase();
    }
    if (region && isRegionCode(region)) return region;
  }
  return null;
}

/** The region in force: the reader's pick, or this machine's. */
export function resolveRegion(choice: RegionChoice = readRegionChoice()): (typeof REGION_CHOICES)[number] | null {
  return choice === "auto" ? systemRegion() : choice;
}

// --- Live subscription ------------------------------------------------------

let current: RegionChoice | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
  try {
    window.dispatchEvent(new CustomEvent(REGION_CHANGED));
  } catch {
    /* no window in a node test */
  }
}

function snapshot(): RegionChoice {
  if (current === null) current = readRegionChoice();
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  // Another window (or the Settings panel in this one) wrote it.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== REGION_KEY) return;
    current = readRegionChoice();
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

/** The reader's choice, following changes. */
export function useRegionChoice(): RegionChoice {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The region in force, following changes. */
export function useRegion(): (typeof REGION_CHOICES)[number] | null {
  return resolveRegion(useRegionChoice());
}
