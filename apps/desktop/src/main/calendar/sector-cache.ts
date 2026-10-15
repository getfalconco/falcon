import { readJson, writeJsonAtomic } from "../briefing/json-file";
import { normalizeSector, type CalendarSector } from "../../shared/calendar-events";

/**
 * Calendar tab: which sector a company is in, behind a disk cache.
 *
 * A company changes sector about never, so a good answer is kept for a month
 * and the provider is asked once per name per month at most. A failed read is
 * remembered for an hour, long enough that an outage is not answered with a
 * retry on every visit to the tab.
 *
 * Electron-free: the file path, the reader and the clock are injected.
 */

const HOUR_MS = 60 * 60 * 1000;
export const SECTOR_TTL_MS = 30 * 24 * HOUR_MS;
export const SECTOR_FAILURE_TTL_MS = HOUR_MS;
const SCHEMA_VERSION = 1;
const FLUSH_DELAY_MS = 250;

/** What the provider's profile says of one symbol. */
export type SectorRead = {
  sector: string | null;
  industry: string | null;
  /** "EQUITY", "ETF", "MUTUALFUND"...; null when the provider did not say. */
  quoteType: string | null;
};

/** `sector` undefined records a failed read; null a read that named no sector. */
type Entry = { at: number; sector?: CalendarSector | null };
type CacheFile = { schema_version: number; symbols: Record<string, Entry> };

export type SectorCacheDeps = {
  file: string;
  fetch: (symbol: string) => Promise<SectorRead>;
  now?: () => number;
};

/** A profile read as one of the calendar's sectors. Funds have no sector of their own; they are filed together. */
export function sectorFromRead(read: SectorRead): CalendarSector | null {
  const type = (read.quoteType ?? "").toUpperCase();
  if (type === "ETF" || type === "MUTUALFUND") return "Funds & ETFs";
  return normalizeSector(read.sector) ?? normalizeSector(read.industry);
}

export function createSectorCache(deps: SectorCacheDeps) {
  const now = deps.now ?? Date.now;
  let cache: CacheFile | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const inFlight = new Map<string, Promise<CalendarSector | null>>();

  const load = (): CacheFile => {
    if (cache) return cache;
    const file = readJson<CacheFile>(deps.file);
    cache =
      file && file.schema_version === SCHEMA_VERSION && file.symbols !== null && typeof file.symbols === "object"
        ? file
        : { schema_version: SCHEMA_VERSION, symbols: {} };
    return cache;
  };

  const flush = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!cache) return;
    try {
      writeJsonAtomic(deps.file, cache);
    } catch (err) {
      console.warn("[calendar] sector cache write failed:", err instanceof Error ? err.message : String(err));
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
    flushTimer.unref?.();
  };

  const fresh = (entry: Entry | undefined, nowMs: number): entry is Entry => {
    if (!entry || typeof entry.at !== "number" || !Number.isFinite(entry.at)) return false;
    const age = nowMs - entry.at;
    return age >= 0 && age < (entry.sector === undefined ? SECTOR_FAILURE_TTL_MS : SECTOR_TTL_MS);
  };

  const read = async (symbol: string): Promise<CalendarSector | null> => {
    const store = load();
    const nowMs = now();
    const entry = store.symbols[symbol];
    if (fresh(entry, nowMs)) {
      if (entry.sector === undefined) throw new Error("sector read failed recently");
      return entry.sector;
    }
    try {
      const sector = sectorFromRead(await deps.fetch(symbol));
      store.symbols[symbol] = { at: nowMs, sector };
      scheduleFlush();
      return sector;
    } catch (err) {
      store.symbols[symbol] = { at: nowMs };
      scheduleFlush();
      throw err;
    }
  };

  return {
    /** The symbol's sector; throws when it could not be learned (now or within the last hour). */
    get(rawSymbol: string): Promise<CalendarSector | null> {
      const symbol = rawSymbol.trim().toUpperCase();
      const pending = inFlight.get(symbol);
      if (pending) return pending;
      const task = read(symbol).finally(() => inFlight.delete(symbol));
      inFlight.set(symbol, task);
      return task;
    },
    /**
     * What the cache holds for the symbol, without asking the provider:
     * undefined when it holds nothing usable (never read, or only a failure).
     * The Earnings tab's market-wide view uses this, so a list of thousands
     * of names never turns into thousands of profile reads.
     */
    peek(rawSymbol: string): CalendarSector | null | undefined {
      const entry = load().symbols[rawSymbol.trim().toUpperCase()];
      if (!entry || typeof entry.at !== "number" || entry.sector === undefined) return undefined;
      return now() - entry.at < SECTOR_TTL_MS ? entry.sector : undefined;
    },
    /** Every symbol with a fresh sector on record, without asking the provider (the Stock tab's sector peers). */
    known(): Array<{ symbol: string; sector: CalendarSector }> {
      const nowMs = now();
      const out: Array<{ symbol: string; sector: CalendarSector }> = [];
      for (const [symbol, entry] of Object.entries(load().symbols)) {
        if (entry && typeof entry.at === "number" && entry.sector && nowMs - entry.at < SECTOR_TTL_MS) out.push({ symbol, sector: entry.sector });
      }
      return out;
    },
    flush,
  };
}

export type SectorCache = ReturnType<typeof createSectorCache>;
