/**
 * Handover briefing: the market-wide headline list, behind a small cache.
 *
 * One port answer stands for nine provider reads (one search query per index,
 * future and macro symbol). The renderer asks for the report every five
 * minutes while the panel is open and the report cache itself lasts ten, so
 * without this a busy pre-open would send the nine queries several times over
 * for a list that changes by an item or two an hour. Answers are kept in
 * memory and on disk, ten minutes for a good one and two for a failure, keyed
 * by the instant the list was asked to start from (the last US close, which is
 * the same for every report of one handover).
 *
 * Electron-free: the file path, the reader and the clock are injected.
 */

import type { MarketHeadline } from "../../shared/briefing-types";
import { readJson, writeJsonAtomic } from "./json-file";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const MARKET_NEWS_TTL_MS = 10 * MINUTE_MS;
/** Long enough that a provider outage is not answered with nine retries per poll, short enough to notice it end. */
export const MARKET_NEWS_FAILURE_TTL_MS = 2 * MINUTE_MS;

/** A "since" older than this belongs to a handover that is over; its entry is dropped at the next write. */
const ENTRY_MAX_AGE_MS = 36 * HOUR_MS;
const CACHE_SCHEMA_VERSION = 1;

/** `headlines` null records a read that failed at `at`. */
export type MarketNewsEntry = { at: number; headlines: MarketHeadline[] | null };

type CacheFile = { schema_version: number; by_since: Record<string, MarketNewsEntry> };

export type MarketNewsDeps = {
  file: string;
  fetch: (since: string) => Promise<MarketHeadline[]>;
  now?: () => number;
};

/**
 * Whether a stored entry still answers at `nowMs`. A negative age is a clock
 * set back: the entry is not from the future, it is unverifiable, and is read
 * again.
 */
export function marketNewsEntryFresh(entry: MarketNewsEntry | undefined, nowMs: number): entry is MarketNewsEntry {
  if (!entry || typeof entry.at !== "number" || !Number.isFinite(entry.at)) return false;
  if (entry.headlines !== null && !Array.isArray(entry.headlines)) return false;
  const age = nowMs - entry.at;
  return age >= 0 && age < (entry.headlines === null ? MARKET_NEWS_FAILURE_TTL_MS : MARKET_NEWS_TTL_MS);
}

/**
 * The cache key for a "since". The instant is normalised, so two spellings
 * of the same close ("...:00Z" and "...:00.000Z") land on one entry; an
 * instant that cannot be read is refused before it reaches a provider or a
 * file, the way the request parser refuses a malformed symbol.
 */
export function marketNewsKey(since: string): string {
  const ms = Date.parse(since);
  if (!Number.isFinite(ms)) throw new Error("market news: since is not an instant");
  return new Date(ms).toISOString();
}

export function createMarketNews(deps: MarketNewsDeps): {
  get(since: string): Promise<MarketHeadline[]>;
} {
  const now = deps.now ?? Date.now;
  let cache: CacheFile | null = null;
  const inFlight = new Map<string, Promise<MarketHeadline[]>>();

  const load = (): CacheFile => {
    if (cache) return cache;
    const file = readJson<CacheFile>(deps.file);
    cache =
      file && file.schema_version === CACHE_SCHEMA_VERSION && file.by_since !== null && typeof file.by_since === "object"
        ? file
        : { schema_version: CACHE_SCHEMA_VERSION, by_since: {} };
    return cache;
  };

  /** One write per provider read, so at most one every ten minutes: no batching needed. */
  const save = (store: CacheFile, nowMs: number): void => {
    for (const [key, entry] of Object.entries(store.by_since)) {
      if (typeof entry?.at !== "number" || nowMs - entry.at > ENTRY_MAX_AGE_MS) delete store.by_since[key];
    }
    try {
      writeJsonAtomic(deps.file, store);
    } catch (err) {
      // The in-memory copy still serves this run; only the next launch pays.
      console.warn("[briefing] market-news cache write failed:", err instanceof Error ? err.message : String(err));
    }
  };

  const read = async (key: string): Promise<MarketHeadline[]> => {
    const store = load();
    const entry = store.by_since[key];
    if (marketNewsEntryFresh(entry, now())) {
      if (entry.headlines === null) throw new Error("market news unavailable: the last read failed");
      return entry.headlines;
    }

    let headlines: MarketHeadline[] | null;
    let failure: unknown = null;
    try {
      headlines = await deps.fetch(key);
    } catch (err) {
      headlines = null;
      failure = err;
    }
    store.by_since[key] = { at: now(), headlines };
    save(store, now());
    if (headlines === null) throw failure instanceof Error ? failure : new Error("market news unavailable");
    return headlines;
  };

  return {
    // Async so a malformed `since` rejects like any other port failure instead of throwing at the call site.
    async get(since) {
      const key = marketNewsKey(since);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const task = read(key).finally(() => inFlight.delete(key));
      inFlight.set(key, task);
      return task;
    },
  };
}
