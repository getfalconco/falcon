import { useSyncExternalStore } from "react";

/**
 * "Important" or "All": one choice for every calendar surface (the Calendar
 * tab and the dashboard's calendar card), remembered in this browser. A
 * change made on one is drawn on the other at once.
 *
 * Every read and write is wrapped: storage can be missing or refuse, and the
 * calendar draws the same with or without it. Safe to import from node tests.
 */

export type CalendarScope = "important" | "all";

export const CALENDAR_SCOPE_KEY = "falcon.ui.calendar.scope";
/** Where the Calendar tab kept the choice before it was shared. */
const LEGACY_PREFS_KEY = "falcon.ui.calendar.v1";

type Reader = Pick<Storage, "getItem">;

function defaultStorage(): Reader | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readCalendarScope(storage: Reader | null = defaultStorage()): CalendarScope {
  try {
    const raw = storage?.getItem(CALENDAR_SCOPE_KEY);
    if (raw === "all" || raw === "important") return raw;
    const legacy = storage?.getItem(LEGACY_PREFS_KEY);
    if (legacy && (JSON.parse(legacy) as { scope?: unknown }).scope === "all") return "all";
  } catch {
    /* storage is not always there */
  }
  return "important";
}

let current: CalendarScope | null = null;
const listeners = new Set<() => void>();

export function writeCalendarScope(scope: CalendarScope): void {
  try {
    localStorage.setItem(CALENDAR_SCOPE_KEY, scope);
  } catch {
    /* holds for this session */
  }
  current = scope;
  for (const fn of listeners) fn();
}

function snapshot(): CalendarScope {
  if (current === null) current = readCalendarScope();
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== CALENDAR_SCOPE_KEY) return;
    current = readCalendarScope();
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

/** The choice in force, following changes from any calendar surface. */
export function useCalendarScope(): CalendarScope {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
