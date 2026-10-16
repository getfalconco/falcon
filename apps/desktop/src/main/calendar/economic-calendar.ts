import { readJson, writeJsonAtomic } from "../briefing/json-file";
import {
  fillTraits,
  seriesKey,
  parseForexFactoryAnswer,
  parseTradingViewAnswer,
  type EconomicCalendarRequest,
  type EconomicCalendarResult,
  type EconomicEvent,
  type EconomicSourceStatus,
  type SeriesTraits,
} from "../../shared/economic-calendar";

/**
 * Calendar tab: the economic calendar of the major economies and the reader's
 * region, read from two free, keyless sources behind a disk cache.
 *
 * TradingView's calendar is asked one calendar month (UTC) at a time, for the
 * whole set of countries in one request, so the month view's six weeks cost
 * two or three reads and a week view usually one. A month near today is kept
 * for a quarter of an hour (actual figures arrive through the day), one
 * further out for hours, a past one for a day. When it does not answer, the
 * last good read of that month is served (marked stale); with none on hand,
 * Forex Factory's weekly file stands in for this week (marked partial). Each
 * source fails on its own: one that is down never blanks the other.
 *
 * Every read runs under a deadline. Nothing a provider says crosses to the
 * renderer except the parsed rows: an error is logged here and answered with
 * a fixed code.
 *
 * Electron-free: the file path, the fetch and the clock are injected.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A month within this distance of today is "current": read again every quarter hour. */
const NEAR_MS = 10 * DAY_MS;
export const NEAR_TTL_MS = 15 * MINUTE_MS;
export const FUTURE_TTL_MS = 3 * HOUR_MS;
export const PAST_TTL_MS = DAY_MS;
/** After a failed read, the source is not asked about that month again for this long. */
export const FAILURE_RETRY_MS = 5 * MINUTE_MS;
/** A stale month is still served for this long when the source keeps failing. */
export const STALE_LIMIT_MS = 14 * DAY_MS;
export const FALLBACK_TTL_MS = HOUR_MS;
export const FALLBACK_FAILURE_RETRY_MS = 15 * MINUTE_MS;
export const REQUEST_TIMEOUT_MS = 12_000;
/** Months kept on disk; the oldest reads go first. */
const MAX_KEPT = 10;
const SCHEMA_VERSION = 1;
const FLUSH_DELAY_MS = 400;

export const TRADINGVIEW_URL = "https://economic-calendar.tradingview.com/events";
export const FOREX_FACTORY_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TRADINGVIEW_HEADERS = { "User-Agent": BROWSER_UA, Origin: "https://www.tradingview.com", Referer: "https://www.tradingview.com/", Accept: "application/json" };
const FOREX_FACTORY_HEADERS = { "User-Agent": BROWSER_UA, Accept: "application/json" };

export type FetchJson = (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<unknown>;

export type EconomicCalendarDeps = {
  file: string;
  fetchJson?: FetchJson;
  now?: () => number;
};

type MonthEntry = { at: number; events: EconomicEvent[] };
/** `traits`: each series' unit and scale as its released rows print them, by `seriesKey`. */
type CacheFile = { schema_version: number; months: Record<string, MonthEntry>; traits?: Record<string, SeriesTraits> };

/** One GET under a deadline, body included; a non-2xx status throws. */
export const fetchJsonWithTimeout: FetchJson = async (url, headers, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`status ${response.status}`);
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error("timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

/** "2026-10" for every month the range touches, in order. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** A month's reach in instants: its first day, to the first day of the next. */
function monthBounds(month: string): { start: number; end: number } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return { start: Date.UTC(y, m - 1, 1), end: Date.UTC(y, m, 1) };
}

function ttlFor(month: string, nowMs: number): number {
  const { start, end } = monthBounds(month);
  if (nowMs >= start - NEAR_MS && nowMs < end + NEAR_MS) return NEAR_TTL_MS;
  return end <= nowMs ? PAST_TTL_MS : FUTURE_TTL_MS;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createEconomicCalendar(deps: EconomicCalendarDeps) {
  const fetchJson = deps.fetchJson ?? fetchJsonWithTimeout;
  const now = deps.now ?? Date.now;
  let cache: CacheFile | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const failedAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<MonthEntry>>();
  let fallback: MonthEntry | null = null;
  let fallbackFailedAt = 0;
  let fallbackInFlight: Promise<MonthEntry> | null = null;

  const load = (): CacheFile => {
    if (cache) return cache;
    const file = readJson<CacheFile>(deps.file);
    cache =
      file && file.schema_version === SCHEMA_VERSION && file.months && typeof file.months === "object"
        ? file
        : { schema_version: SCHEMA_VERSION, months: {} };
    return cache;
  };

  const flush = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!cache) return;
    // Only the newest reads are worth a place on disk.
    const keys = Object.keys(cache.months).sort((a, b) => cache!.months[b]!.at - cache!.months[a]!.at);
    for (const key of keys.slice(MAX_KEPT)) delete cache.months[key];
    try {
      writeJsonAtomic(deps.file, cache);
    } catch (err) {
      console.warn("[calendar] economic cache write failed:", errorText(err));
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
    flushTimer.unref?.();
  };

  const readMonth = async (month: string, countries: string[]): Promise<MonthEntry> => {
    const { start, end } = monthBounds(month);
    // A day either side, so a release late on the last evening or early on the first morning in any zone is there.
    const from = new Date(start - DAY_MS).toISOString();
    const to = new Date(end + DAY_MS).toISOString();
    const url = `${TRADINGVIEW_URL}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&countries=${countries.join(",")}`;
    const answer = await fetchJson(url, TRADINGVIEW_HEADERS, REQUEST_TIMEOUT_MS);
    const events = parseTradingViewAnswer(answer);
    if (!events) throw new Error("unreadable answer");
    const wanted = new Set(countries);
    return { at: now(), events: events.filter((e) => wanted.has(e.country)) };
  };

  /** A month's rows: fresh from cache, read now, or a stale copy when the read fails. */
  const month = async (key: string, month: string, countries: string[]): Promise<{ entry: MonthEntry | null; fresh: boolean; ok: boolean }> => {
    const store = load();
    const nowMs = now();
    const held = store.months[key];
    if (held && nowMs - held.at >= 0 && nowMs - held.at < ttlFor(month, nowMs)) return { entry: held, fresh: true, ok: true };
    const failed = failedAt.get(key);
    const usableStale = held && nowMs - held.at < STALE_LIMIT_MS ? held : null;
    if (failed !== undefined && nowMs - failed < FAILURE_RETRY_MS) return { entry: usableStale, fresh: false, ok: false };
    let task = inFlight.get(key);
    if (!task) {
      task = readMonth(month, countries).finally(() => inFlight.delete(key));
      inFlight.set(key, task);
    }
    try {
      const entry = await task;
      store.months[key] = entry;
      learn(entry.events);
      failedAt.delete(key);
      scheduleFlush();
      return { entry, fresh: true, ok: true };
    } catch (err) {
      failedAt.set(key, now());
      console.warn(`[calendar] economic calendar read failed for ${month}:`, errorText(err));
      return { entry: usableStale, fresh: false, ok: false };
    }
  };

  /** Remembers the unit and scale of every series a read printed them for. */
  const learn = (events: readonly EconomicEvent[]): void => {
    const store = load();
    const traits = (store.traits ??= {});
    for (const e of events) if (e.unit !== null || e.scale !== null) traits[seriesKey(e)] = { unit: e.unit, scale: e.scale };
  };

  /** Forex Factory's week, for when the main source has nothing for a month. */
  const thisWeek = async (): Promise<MonthEntry | null> => {
    const nowMs = now();
    if (fallback && nowMs - fallback.at < FALLBACK_TTL_MS) return fallback;
    if (nowMs - fallbackFailedAt < FALLBACK_FAILURE_RETRY_MS) return fallback && nowMs - fallback.at < STALE_LIMIT_MS ? fallback : null;
    if (!fallbackInFlight) {
      fallbackInFlight = (async () => {
        const events = parseForexFactoryAnswer(await fetchJson(FOREX_FACTORY_URL, FOREX_FACTORY_HEADERS, REQUEST_TIMEOUT_MS));
        if (!events) throw new Error("unreadable answer");
        return { at: now(), events };
      })().finally(() => {
        fallbackInFlight = null;
      });
    }
    try {
      fallback = await fallbackInFlight;
      return fallback;
    } catch (err) {
      fallbackFailedAt = now();
      console.warn("[calendar] economic calendar fallback failed:", errorText(err));
      return null;
    }
  };

  return {
    async get(request: EconomicCalendarRequest): Promise<EconomicCalendarResult> {
      const countries = [...request.countries].sort();
      const months = monthsBetween(request.from, request.to);
      const results = await Promise.all(months.map((m) => month(`${m}|${countries.join(",")}`, m, countries)));

      const byId = new Map<string, EconomicEvent>();
      let stale = false;
      let partial = false;
      const sources: EconomicSourceStatus[] = [{ id: "tradingview", ok: results.every((r) => r.ok) }];
      for (const r of results) {
        if (r.entry) for (const e of r.entry.events) byId.set(e.id, e);
        if (r.entry && !r.fresh) stale = true;
      }
      if (results.some((r) => !r.entry)) {
        const week = await thisWeek();
        sources.push({ id: "forexfactory", ok: week !== null });
        if (week) {
          const wanted = new Set(countries);
          for (const e of week.events) if (wanted.has(e.country)) byId.set(e.id, e);
          partial = true;
        }
      }
      if (byId.size === 0 && sources.every((s) => !s.ok)) return { ok: false, error: "unavailable" };

      // The range asked for, with a day either side for the zones that see it on another date.
      const lo = Date.parse(`${request.from}T00:00:00Z`) - DAY_MS;
      const hi = Date.parse(`${request.to}T00:00:00Z`) + 2 * DAY_MS;
      // What any read so far said of each series, laid under the rows that print bare figures.
      for (const r of results) if (r.entry) learn(r.entry.events);
      const known = new Map(Object.entries(load().traits ?? {}));
      const events = fillTraits([...byId.values()], known)
        .filter((e) => {
          const ms = Date.parse(e.at);
          return ms >= lo && ms < hi;
        })
        .sort((a, b) => a.at.localeCompare(b.at) || b.importance - a.importance || a.id.localeCompare(b.id));
      return { ok: true, events, sources, stale, partial };
    },
    flush,
  };
}

export type EconomicCalendar = ReturnType<typeof createEconomicCalendar>;
