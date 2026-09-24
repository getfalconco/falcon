/**
 * Handover briefing: the corporate calendar of a held name, behind a disk cache.
 *
 * Two provider reads stand behind one port answer: the forward calendar
 * (ex-dividend and earnings dates) and the recent price-history events
 * (distributions and splits). Neither changes more than a few times a quarter,
 * and the calendar read goes through the provider's crumb handshake, the most
 * fragile request the app makes. So answers are kept on disk, a good one for
 * most of a day, and a failure just long enough that a provider outage is not
 * answered with a retry per refresh per held name.
 *
 * Electron-free: the file path, the two readers and the clock are injected.
 */

import type { CorporateCalendarRaw } from "../../shared/briefing-types";
import type { CorporateCalendarRead, RecentCorporateEventsRead } from "../stock/market-data-service";
import { readJson, writeJsonAtomic } from "./json-file";
import { toCorporateCalendarRaw } from "./ports-map";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** "This fund has no calendar" is as good an answer as a date, and is kept as long. */
export const GOOD_ANSWER_TTL_MS = 18 * HOUR_MS;
export const FAILURE_TTL_MS = 30 * MINUTE_MS;

const ENTRY_MAX_AGE_MS = 14 * 24 * HOUR_MS;
const CACHE_SCHEMA_VERSION = 1;
const FLUSH_DELAY_MS = 250;

/** `value` null records a request that failed at `at`. */
type Half<T> = { at: number; value: T | null };

type Entry = {
  calendar?: Half<CorporateCalendarRead>;
  events?: Half<RecentCorporateEventsRead>;
};

type CacheFile = { schema_version: number; symbols: Record<string, Entry> };

export type CorporateActionsDeps = {
  file: string;
  fetchCalendar: (symbol: string) => Promise<CorporateCalendarRead>;
  fetchEvents: (symbol: string) => Promise<RecentCorporateEventsRead>;
  now?: () => number;
};

export type CorporateActionsOptions = {
  /**
   * The open of the session being handed over to, epoch ms. Chart events are
   * stamped with the open of their ex-date, so a read taken the evening before
   * cannot contain that day's split or distribution however fresh it is. Once
   * this instant has passed, an events answer from before it is read again.
   */
  eventsNotBeforeMs?: number;
};

function halfFresh<T>(half: Half<T> | undefined, nowMs: number): half is Half<T> {
  if (!half || typeof half.at !== "number" || !Number.isFinite(half.at)) return false;
  const age = nowMs - half.at;
  return age >= 0 && age < (half.value === null ? FAILURE_TTL_MS : GOOD_ANSWER_TTL_MS);
}

export function createCorporateActions(deps: CorporateActionsDeps): {
  get(symbol: string, options?: CorporateActionsOptions): Promise<CorporateCalendarRaw>;
  flush(): void;
} {
  const now = deps.now ?? Date.now;
  let cache: CacheFile | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const inFlight = new Map<string, Promise<CorporateCalendarRaw>>();

  const load = (): CacheFile => {
    if (cache) return cache;
    const file = readJson<CacheFile>(deps.file);
    cache =
      file && file.schema_version === CACHE_SCHEMA_VERSION && file.symbols !== null && typeof file.symbols === "object"
        ? file
        : { schema_version: CACHE_SCHEMA_VERSION, symbols: {} };
    return cache;
  };

  const flush = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!cache) return;
    const nowMs = now();
    for (const [symbol, entry] of Object.entries(cache.symbols)) {
      const newest = Math.max(entry.calendar?.at ?? 0, entry.events?.at ?? 0);
      // A name that left the book stops being refreshed and ages out here.
      if (nowMs - newest > ENTRY_MAX_AGE_MS) delete cache.symbols[symbol];
    }
    try {
      writeJsonAtomic(deps.file, cache);
    } catch (err) {
      // The in-memory copy still serves this run; only the next launch pays.
      console.warn("[briefing] corporate-actions cache write failed:", err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * A build resolves every held name within the same second. One rename per
   * name would be twenty renames of one file back to back, which on Windows is
   * the pattern most prone to a scanner holding the file, so writes are
   * gathered into one.
   */
  const scheduleFlush = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
    // A pending cache write is no reason to keep the process alive.
    flushTimer.unref?.();
  };

  const read = async (symbol: string, options: CorporateActionsOptions): Promise<CorporateCalendarRaw> => {
    const store = load();
    const nowMs = now();
    const entry: Entry = store.symbols[symbol] ?? {};

    const gate = options.eventsNotBeforeMs;
    const eventsPredateOpen =
      typeof gate === "number" && Number.isFinite(gate) && nowMs >= gate && entry.events !== undefined && entry.events.at < gate;

    const calendarCached = halfFresh(entry.calendar, nowMs);
    const eventsCached = halfFresh(entry.events, nowMs) && !eventsPredateOpen;

    const [calendar, events] = await Promise.all([
      calendarCached ? entry.calendar!.value : deps.fetchCalendar(symbol).catch(() => null),
      eventsCached ? entry.events!.value : deps.fetchEvents(symbol).catch(() => null),
    ]);

    if (!calendarCached || !eventsCached) {
      store.symbols[symbol] = {
        calendar: calendarCached ? entry.calendar : { at: nowMs, value: calendar },
        events: eventsCached ? entry.events : { at: nowMs, value: events },
      };
      scheduleFlush();
    }

    // The two halves do not fail alike. Without the calendar the report still
    // stands: the symbol is listed among those the provider returned nothing
    // for. Without the price-history events nothing on the page would show
    // that the split check did not run, so that failure is raised and the
    // assembly marks the section degraded for this name.
    if (events === null) throw new Error("corporate events unavailable");
    return toCorporateCalendarRaw(symbol, calendar, events);
  };

  return {
    get(rawSymbol, options = {}) {
      const symbol = rawSymbol.trim().toUpperCase();
      const pending = inFlight.get(symbol);
      if (pending) return pending;
      const task = read(symbol, options).finally(() => inFlight.delete(symbol));
      inFlight.set(symbol, task);
      return task;
    },
    flush,
  };
}
