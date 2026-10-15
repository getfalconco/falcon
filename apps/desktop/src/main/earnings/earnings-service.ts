/**
 * Earnings tab and card: the upcoming reports of a set of names, behind disk
 * caches that keep the providers asked as rarely as the answer allows.
 *
 * Three caches, each sized to how fast its answer changes:
 *
 *   market-calendar.json  Finnhub's market-wide calendar for the next six
 *                         weeks. Read at most once every six hours, in week
 *                         pieces (the endpoint caps the lines per answer),
 *                         one piece at a time with a pause between. A failed
 *                         read keeps the older copy and is not tried again for
 *                         half an hour. Finnhub's quota is shared with the
 *                         engines, so this is the only market-wide read.
 *   market-recent.json    The same calendar from Monday of this week to
 *                         yesterday, read every half hour, for the actual
 *                         figures of the reports already out.
 *   details.json          Yahoo's next date, consensus, quarters on record and
 *                         last surprise per name, kept six hours (an hour
 *                         after a failure), twenty minutes for a name due
 *                         today or yesterday and not yet on record.
 *   snapshots.json        The consensus per name and quarter as it stood
 *                         before the release: Yahoo moves its consensus to the
 *                         next quarter on report day, and this is what the
 *                         reported row compares the actual with.
 *   tracked.json          The last universe the Tracker reported, used when
 *                         the engine cannot be reached.
 *   caps.json             Market values for the "For you" list, a week each,
 *                         read in batches of a hundred names and only for
 *                         companies with a consensus revenue that could make
 *                         them large (CAP_LOOKUP_MIN_REVENUE).
 *
 * The answer for one request is kept two minutes on top, so the tab, the card
 * and a duplicate of the card share one build.
 *
 * Electron-free: the readers, the folder and the clock are injected.
 */

import path from "node:path";
import { readJson, writeJsonAtomic } from "../briefing/json-file";
import type { CalendarSector } from "../../shared/calendar-events";
import {
  EARNINGS_MAX_DAYS,
  type EarningsDegradedSource,
  type EarningsDetail,
  type EarningsFx,
  type EarningsResult,
  type EarningsRow,
  type ParsedEarningsRequest,
} from "../../shared/earnings-types";
import { indexLinks, readsThrough, type LinkEdge, type LinkIndex } from "../../shared/earnings-links";
import { weekStartOf } from "../../shared/earnings-time";
import {
  CAP_LOOKUP_MIN_REVENUE,
  SECTOR_MIN_CAP_USD,
  forYouReason,
  mineReason,
  reasonRank,
} from "../../shared/earnings-foryou";
import {
  dedupeMarketEntries,
  mergeEarnings,
  parseFinnhubCalendar,
  parseYahooEarnings,
  snapshotOf,
  type ConsensusSnapshot,
  type MarketCalendarEntry,
  type YahooEarningsRead,
  type YahooQuarter,
} from "./earnings-sources";
import { toUsd } from "./earnings-fx";

const MIN = 60_000;
const HOUR = 60 * MIN;
export const MARKET_TTL_MS = 6 * HOUR;
export const MARKET_RETRY_MS = 30 * MIN;
export const DETAILS_TTL_MS = 6 * HOUR;
export const DETAILS_FAILURE_TTL_MS = HOUR;
/** A name due today or yesterday whose release is not yet on record is asked again this soon. */
export const DETAILS_NEAR_TTL_MS = 20 * MIN;
export const RECENT_TTL_MS = 30 * MIN;
export const RECENT_RETRY_MS = 10 * MIN;
export const CAPS_TTL_MS = 7 * 24 * HOUR;
/** Batched market-value reads one answer may make (a hundred names each). */
const CAP_BATCHES_PER_BUILD = 8;
const CAP_BATCH = 100;
/** Sector reads one "For you" answer may make for names not yet in the sector cache; the rest wait for the next answer. */
const FORYOU_SECTOR_READS = 40;
/** Snapshots kept per name: a year and a half of quarters. */
const SNAPSHOTS_PER_NAME = 6;
export const TRACKED_TTL_MS = 30 * MIN;
export const ANSWER_TTL_MS = 2 * MIN;
/** The most lines Finnhub returns for one calendar request; an answer this long was cut. */
export const FINNHUB_LINE_CAP = 1500;
const CHUNK_DAYS = 7;
const SCHEMA_VERSION = 1;
/** The details file's shape changed with the quarters and currencies: older copies are read again. */
const DETAILS_SCHEMA_VERSION = 2;
const FLUSH_DELAY_MS = 250;
/**
 * The longest one provider read may take before the answer goes on without
 * it. Every reader below is held to this: a crumb handshake or a listing
 * directory that never answers must not hold the whole list.
 */
export const SOURCE_TIMEOUT_MS = 20_000;

/** `task`, or a rejection once `ms` has passed. The read itself is left to finish or fail on its own. */
export function withTimeout<T>(task: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([task, expiry]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

export type EarningsServiceDeps = {
  /** Folder the caches live in. */
  dir: string;
  /** Finnhub's `/calendar/earnings` for a date range, raw JSON. Throws on a failed request. */
  fetchMarketCalendar: (from: string, to: string) => Promise<unknown>;
  /** Whether a market-wide read can be made at all (a key or the proxy is set up). */
  marketConfigured: () => boolean;
  /** Yahoo quote-summary modules for one symbol, raw. Throws on a failed request; null when it has nothing. */
  fetchYahoo: (symbol: string) => Promise<Record<string, unknown> | null>;
  /** A sector read through the Calendar tab's month-long cache. Throws when it could not be learned. */
  sector: (symbol: string) => Promise<CalendarSector | null>;
  /** The same cache, without asking the provider: undefined when it holds nothing for the name. */
  peekSector: (symbol: string) => CalendarSector | null | undefined;
  /** Company names by symbol, from the listing directory. */
  companyNames: () => Promise<ReadonlyMap<string, string>>;
  /** The Tracker's universe. */
  trackedUniverse: () => Promise<string[]>;
  /** The filing graph's edges, for "reads through to". Empty when there is no graph. */
  graphEdges?: () => Promise<readonly LinkEdge[]>;
  /** The form of the filing step1 read for a company, for a graph edge that does not carry it. */
  filingForm?: (ticker: string) => "10-K" | "20-F" | null;
  /** A dated rate from a reporting currency to US dollars; null for USD or when none can be read. */
  fxRate?: (currency: string | null, ymd: string) => Promise<EarningsFx | null>;
  /** Market values in dollars for up to a hundred symbols; a symbol without one is absent. Throws on a failed read. */
  fetchMarketCaps?: (symbols: readonly string[]) => Promise<Record<string, number>>;
  now?: () => number;
  /** Yahoo reads at once. */
  concurrency?: number;
  /** Pause between two Finnhub pieces. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Per-read time limit (SOURCE_TIMEOUT_MS). */
  sourceTimeoutMs?: number;
};

type MarketFile = { schema_version: number; fetchedAt: number; from: string; to: string; entries: MarketCalendarEntry[] };
type DetailEntry = { at: number; read?: YahooEarningsRead | null };
type DetailsFile = { schema_version: number; symbols: Record<string, DetailEntry> };
type SnapshotsFile = { schema_version: number; symbols: Record<string, ConsensusSnapshot[]> };
type CapsFile = { schema_version: number; symbols: Record<string, { at: number; cap: number | null }> };
type TrackedFile = { schema_version: number; at: number; tickers: string[] };
/** Records a read that failed; `count` is how many rows or names went without it (default one). */
type NoteDegraded = (source: EarningsDegradedSource, count?: number) => void;

const NY_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** Today's New York calendar date. */
export function nyToday(nowMs: number): string {
  return NY_DATE.format(new Date(nowMs));
}

export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysSpan(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
}

/** Runs `task` over `items`, at most `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

const TIME_ORDER: Record<EarningsRow["time"], number> = { bmo: 0, dmh: 1, amc: 2, unknown: 3 };

export function sortRows(rows: EarningsRow[]): EarningsRow[] {
  return rows.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      reasonRank(a.reason) - reasonRank(b.reason) ||
      TIME_ORDER[a.time] - TIME_ORDER[b.time] ||
      Number(b.held) - Number(a.held) ||
      Number(b.watchlist) - Number(a.watchlist) ||
      a.ticker.localeCompare(b.ticker),
  );
}

export function createEarningsService(deps: EarningsServiceDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pauseMs = deps.pauseMs ?? 400;
  const concurrency = deps.concurrency ?? 4;
  const limit = deps.sourceTimeoutMs ?? SOURCE_TIMEOUT_MS;
  /** A reader held to the time limit; a synchronous throw becomes a rejection like any other failure. */
  const timed =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>, what: string) =>
    (...args: A): Promise<R> =>
      withTimeout(
        Promise.resolve().then(() => fn(...args)),
        limit,
        what,
      );
  const src = {
    fetchMarketCalendar: timed(deps.fetchMarketCalendar, "market calendar"),
    fetchYahoo: timed(deps.fetchYahoo, "quote summary"),
    sector: timed(deps.sector, "sector"),
    companyNames: timed(deps.companyNames, "listing directory"),
    trackedUniverse: timed(deps.trackedUniverse, "tracked universe"),
    graphEdges: deps.graphEdges ? timed(deps.graphEdges, "filing graph") : undefined,
    fxRate: deps.fxRate ? timed(deps.fxRate, "fx rate") : undefined,
    fetchMarketCaps: deps.fetchMarketCaps ? timed(deps.fetchMarketCaps, "market values") : undefined,
  };
  const marketFile = path.join(deps.dir, "market-calendar.json");
  const detailsFile = path.join(deps.dir, "details.json");
  const trackedFile = path.join(deps.dir, "tracked.json");
  const recentFile = path.join(deps.dir, "market-recent.json");
  const snapshotsFile = path.join(deps.dir, "snapshots.json");
  const capsFile = path.join(deps.dir, "caps.json");

  // ---- market-wide calendar ------------------------------------------------

  let market: MarketFile | null | undefined;
  let marketFailedAt: number | null = null;
  let marketInFlight: Promise<MarketFile | null> | null = null;

  const loadMarket = (): MarketFile | null => {
    if (market !== undefined) return market;
    const file = readJson<MarketFile>(marketFile);
    market = file && file.schema_version === SCHEMA_VERSION && Array.isArray(file.entries) ? file : null;
    return market;
  };

  /** One range, split in halves while the provider's answer comes back cut. */
  const readRange = async (from: string, to: string, out: MarketCalendarEntry[], first: { value: boolean }): Promise<void> => {
    if (!first.value) await sleep(pauseMs);
    first.value = false;
    const { entries, rawCount } = parseFinnhubCalendar(await src.fetchMarketCalendar(from, to));
    const span = daysSpan(from, to);
    if (rawCount >= FINNHUB_LINE_CAP && span > 1) {
      const mid = addDays(from, Math.floor(span / 2) - 1);
      await readRange(from, mid, out, first);
      await readRange(addDays(mid, 1), to, out, first);
      return;
    }
    out.push(...entries);
  };

  const fetchMarket = async (from: string, to: string): Promise<MarketFile> => {
    const out: MarketCalendarEntry[] = [];
    const first = { value: true };
    for (let start = from; start <= to; start = addDays(start, CHUNK_DAYS)) {
      const end = addDays(start, CHUNK_DAYS - 1) < to ? addDays(start, CHUNK_DAYS - 1) : to;
      await readRange(start, end, out, first);
    }
    return { schema_version: SCHEMA_VERSION, fetchedAt: now(), from, to, entries: dedupeMarketEntries(out) };
  };

  /** The market calendar covering `needTo`: a fresh copy, an older one, or null. */
  const marketCalendar = async (today: string, needTo: string): Promise<{ file: MarketFile; fresh: boolean } | null> => {
    const cached = loadMarket();
    const nowMs = now();
    const fresh = (f: MarketFile): boolean =>
      nowMs - f.fetchedAt >= 0 && nowMs - f.fetchedAt < MARKET_TTL_MS && f.from <= today && f.to >= needTo;
    if (cached && fresh(cached)) return { file: cached, fresh: true };
    const usable = cached && cached.to >= today ? cached : null;
    if (!deps.marketConfigured()) return usable ? { file: usable, fresh: false } : null;
    if (marketFailedAt !== null && nowMs - marketFailedAt < MARKET_RETRY_MS) return usable ? { file: usable, fresh: false } : null;
    if (!marketInFlight) {
      marketInFlight = fetchMarket(today, addDays(today, EARNINGS_MAX_DAYS - 1))
        .then((file) => {
          market = file;
          marketFailedAt = null;
          try {
            writeJsonAtomic(marketFile, file);
          } catch (err) {
            console.warn("[earnings] market calendar write failed:", err instanceof Error ? err.message : String(err));
          }
          return file;
        })
        .catch((err) => {
          marketFailedAt = now();
          console.warn("[earnings] market calendar read failed:", err instanceof Error ? err.message : String(err));
          return null;
        })
        .finally(() => {
          marketInFlight = null;
        });
    }
    const got = await marketInFlight;
    if (got) return { file: got, fresh: true };
    return usable ? { file: usable, fresh: false } : null;
  };

  // ---- this week's calendar, for the figures already out ------------------

  let recent: MarketFile | null | undefined;
  let recentFailedAt: number | null = null;
  let recentInFlight: Promise<MarketFile | null> | null = null;

  /** Monday to yesterday, read every half hour. */
  const recentCalendar = async (weekStart: string, through: string): Promise<MarketFile | null> => {
    if (recent === undefined) {
      const file = readJson<MarketFile>(recentFile);
      recent = file && file.schema_version === SCHEMA_VERSION && Array.isArray(file.entries) ? file : null;
    }
    const nowMs = now();
    const current = recent;
    if (current && current.from === weekStart && current.to === through && nowMs - current.fetchedAt >= 0 && nowMs - current.fetchedAt < RECENT_TTL_MS) {
      return current;
    }
    const usable = current && current.from === weekStart ? current : null;
    if (!deps.marketConfigured()) return usable;
    if (recentFailedAt !== null && nowMs - recentFailedAt < RECENT_RETRY_MS) return usable;
    if (!recentInFlight) {
      recentInFlight = (async () => {
        const out: MarketCalendarEntry[] = [];
        await readRange(weekStart, through, out, { value: true });
        return { schema_version: SCHEMA_VERSION, fetchedAt: now(), from: weekStart, to: through, entries: dedupeMarketEntries(out) };
      })()
        .then((file) => {
          recent = file;
          recentFailedAt = null;
          try {
            writeJsonAtomic(recentFile, file);
          } catch (err) {
            console.warn("[earnings] recent calendar write failed:", err instanceof Error ? err.message : String(err));
          }
          return file;
        })
        .catch((err) => {
          recentFailedAt = now();
          console.warn("[earnings] recent calendar read failed:", err instanceof Error ? err.message : String(err));
          return null;
        })
        .finally(() => {
          recentInFlight = null;
        });
    }
    return (await recentInFlight) ?? usable;
  };

  // ---- consensus snapshots ---------------------------------------------------

  let snapshots: SnapshotsFile | null = null;
  let snapshotsDirty = false;

  const loadSnapshots = (): SnapshotsFile => {
    if (snapshots) return snapshots;
    const file = readJson<SnapshotsFile>(snapshotsFile);
    snapshots =
      file && file.schema_version === SCHEMA_VERSION && file.symbols && typeof file.symbols === "object"
        ? file
        : { schema_version: SCHEMA_VERSION, symbols: {} };
    return snapshots;
  };

  const keepSnapshot = (symbol: string, snap: ConsensusSnapshot | null): void => {
    if (!snap) return;
    const store = loadSnapshots();
    const list = (store.symbols[symbol] ?? []).filter((x) => x.periodEnd !== snap.periodEnd);
    list.push(snap);
    list.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
    store.symbols[symbol] = list.slice(-SNAPSHOTS_PER_NAME);
    snapshotsDirty = true;
  };

  const snapshotFor =
    (symbol: string) =>
    (periodEnd: string): ConsensusSnapshot | null =>
      loadSnapshots().symbols[symbol]?.find((x) => x.periodEnd === periodEnd) ?? null;

  // ---- per-name details ----------------------------------------------------

  let details: DetailsFile | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const detailsInFlight = new Map<string, Promise<YahooEarningsRead | null>>();

  const loadDetails = (): DetailsFile => {
    if (details) return details;
    const file = readJson<DetailsFile>(detailsFile);
    details =
      file && file.schema_version === DETAILS_SCHEMA_VERSION && file.symbols !== null && typeof file.symbols === "object"
        ? file
        : { schema_version: DETAILS_SCHEMA_VERSION, symbols: {} };
    return details;
  };

  const flush = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (details) {
      try {
        writeJsonAtomic(detailsFile, details);
      } catch (err) {
        console.warn("[earnings] details write failed:", err instanceof Error ? err.message : String(err));
      }
    }
    if (snapshots && snapshotsDirty) {
      try {
        writeJsonAtomic(snapshotsFile, snapshots);
        snapshotsDirty = false;
      } catch (err) {
        console.warn("[earnings] snapshots write failed:", err instanceof Error ? err.message : String(err));
      }
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
    flushTimer.unref?.();
  };

  /**
   * How long a read stays good: twenty minutes while the name is due today or
   * yesterday and the release is not yet on record, six hours otherwise.
   */
  const ttlFor = (read: YahooEarningsRead | null, today: string): number => {
    if (!read) return DETAILS_TTL_MS;
    const yesterday = addDays(today, -1);
    const due = read.dates.some((d) => d === today || d === yesterday);
    if (!due) return DETAILS_TTL_MS;
    const onRecord = (read.quarters ?? []).some(
      (q) => q.epsActual !== null && (q.reportedAt !== null ? nyToday(Date.parse(q.reportedAt)) : (q.reportedYmd ?? "")) >= yesterday,
    );
    return onRecord ? DETAILS_TTL_MS : DETAILS_NEAR_TTL_MS;
  };

  /** One name's Yahoo read; throws when it could not be learned (now, or within the last hour). */
  const detail = (symbol: string): Promise<YahooEarningsRead | null> => {
    const pending = detailsInFlight.get(symbol);
    if (pending) return pending;
    const task = (async () => {
      const store = loadDetails();
      const nowMs = now();
      const entry = store.symbols[symbol];
      if (entry && typeof entry.at === "number") {
        const age = nowMs - entry.at;
        const ttl = entry.read === undefined ? DETAILS_FAILURE_TTL_MS : ttlFor(entry.read, nyToday(nowMs));
        if (age >= 0 && age < ttl) {
          if (entry.read === undefined) throw new Error("details read failed recently");
          return entry.read;
        }
      }
      try {
        const read = parseYahooEarnings(await src.fetchYahoo(symbol));
        store.symbols[symbol] = { at: nowMs, read };
        keepSnapshot(symbol, snapshotOf(read, nowMs));
        scheduleFlush();
        return read;
      } catch (err) {
        // A failure keeps the last good read for a row, but marks the time so it is not retried at once.
        store.symbols[symbol] = entry && entry.read !== undefined ? { at: nowMs - DETAILS_TTL_MS + DETAILS_FAILURE_TTL_MS, read: entry.read } : { at: nowMs };
        scheduleFlush();
        if (entry && entry.read !== undefined) return entry.read;
        throw err;
      }
    })().finally(() => detailsInFlight.delete(symbol));
    detailsInFlight.set(symbol, task);
    return task;
  };

  // ---- the Tracker's universe ---------------------------------------------

  let tracked: { at: number; tickers: string[] } | null = null;
  let trackedInFlight: Promise<string[] | null> | null = null;

  const trackedList = async (): Promise<string[] | null> => {
    const nowMs = now();
    if (tracked && nowMs - tracked.at < TRACKED_TTL_MS) return tracked.tickers;
    if (!trackedInFlight) {
      trackedInFlight = src
        .trackedUniverse()
        .then((list) => {
          const tickers = [...new Set(list.map((t) => t.trim().toUpperCase()).filter(Boolean))].sort();
          tracked = { at: now(), tickers };
          try {
            writeJsonAtomic(trackedFile, { schema_version: SCHEMA_VERSION, at: tracked.at, tickers } satisfies TrackedFile);
          } catch {
            /* the list in memory still serves */
          }
          return tickers;
        })
        .catch((err) => {
          console.warn("[earnings] tracked universe read failed:", err instanceof Error ? err.message : String(err));
          const file = readJson<TrackedFile>(trackedFile);
          if (file && Array.isArray(file.tickers) && file.tickers.length > 0) {
            // Remembered as read just now, so a down engine is asked again only after the usual wait.
            tracked = { at: now(), tickers: file.tickers.filter((t) => typeof t === "string") };
            return tracked.tickers;
          }
          return null;
        })
        .finally(() => {
          trackedInFlight = null;
        });
    }
    return trackedInFlight;
  };

  // ---- market values -----------------------------------------------------------

  let caps: CapsFile | null = null;

  const loadCaps = (): CapsFile => {
    if (caps) return caps;
    const file = readJson<CapsFile>(capsFile);
    caps = file && file.schema_version === SCHEMA_VERSION && file.symbols && typeof file.symbols === "object" ? file : { schema_version: SCHEMA_VERSION, symbols: {} };
    return caps;
  };

  /** Market values for these names: kept ones a week old or less, the rest read in batches (a failed batch is asked again next time). */
  const capsFor = async (symbols: readonly string[], note: NoteDegraded): Promise<Map<string, number | null>> => {
    const store = loadCaps();
    const nowMs = now();
    const out = new Map<string, number | null>();
    const missing: string[] = [];
    for (const s of symbols) {
      const kept = store.symbols[s];
      if (kept && nowMs - kept.at >= 0 && nowMs - kept.at < CAPS_TTL_MS) out.set(s, kept.cap);
      else missing.push(s);
    }
    if (!src.fetchMarketCaps || missing.length === 0) return out;
    let wrote = false;
    for (let i = 0; i < missing.length && i < CAP_BATCHES_PER_BUILD * CAP_BATCH; i += CAP_BATCH) {
      const batch = missing.slice(i, i + CAP_BATCH);
      try {
        const got = await src.fetchMarketCaps(batch);
        for (const s of batch) {
          const cap = typeof got[s] === "number" && Number.isFinite(got[s]) && got[s]! > 0 ? got[s]! : null;
          store.symbols[s] = { at: now(), cap };
          out.set(s, cap);
        }
        wrote = true;
      } catch (err) {
        console.warn("[earnings] market values read failed:", err instanceof Error ? err.message : String(err));
        // Every name not yet read in this build goes without a value.
        note("caps", Math.min(missing.length, CAP_BATCHES_PER_BUILD * CAP_BATCH) - i);
        break;
      }
    }
    if (wrote) {
      try {
        writeJsonAtomic(capsFile, store);
      } catch (err) {
        console.warn("[earnings] market values write failed:", err instanceof Error ? err.message : String(err));
      }
    }
    return out;
  };

  // ---- the filing graph ------------------------------------------------------

  let linkCache: { edges: readonly LinkEdge[]; index: LinkIndex } | null = null;

  const linkIndex = async (): Promise<{ index: LinkIndex | null; failed: boolean }> => {
    if (!src.graphEdges) return { index: null, failed: false };
    try {
      const edges = await src.graphEdges();
      if (!linkCache || linkCache.edges !== edges) linkCache = { edges, index: indexLinks(edges) };
      return { index: linkCache.index, failed: false };
    } catch (err) {
      console.warn("[earnings] filing graph read failed:", err instanceof Error ? err.message : String(err));
      return { index: null, failed: true };
    }
  };

  /** The sector cache without asking the provider; a cache that throws holds nothing. */
  const peek = (symbol: string): CalendarSector | null | undefined => {
    try {
      return deps.peekSector(symbol);
    } catch {
      return undefined;
    }
  };

  // ---- "For you" ---------------------------------------------------------------

  /**
   * The rows "For you" keeps, each with its reason: the reader's names, then
   * companies a filing links to them, then sizeable companies in the sectors
   * they follow (from onboarding, and the sectors their holdings are in),
   * then the biggest listings. Everything else is left out.
   */
  const selectForYou = async (
    rows: readonly EarningsRow[],
    req: ParsedEarningsRequest,
    held: ReadonlySet<string>,
    watch: ReadonlySet<string>,
    note: NoteDegraded,
  ): Promise<EarningsRow[]> => {
    const userSectors = new Set<CalendarSector>(req.sectors);
    await pool(req.held, concurrency, async (t) => {
      try {
        const s = peek(t) ?? (await src.sector(t));
        if (s && s !== "Unclassified" && s !== "Funds & ETFs") userSectors.add(s);
      } catch {
        // A holding whose sector cannot be learned adds none.
        note("sectors");
      }
    });

    const others = rows.filter((r) => !mineReason(r.ticker, held, watch));
    const lookUp = others.filter((r) => Math.max(r.revenueEstimate ?? 0, r.revenueActual ?? 0) >= CAP_LOOKUP_MIN_REVENUE).map((r) => r.ticker);
    const capOf = await capsFor(lookUp, note);

    let sectorReads = 0;
    const kept: EarningsRow[] = [];
    for (const row of rows) {
      const own = mineReason(row.ticker, held, watch);
      if (own) {
        kept.push({ ...row, reason: own });
        continue;
      }
      const cap = capOf.get(row.ticker) ?? null;
      let sector: CalendarSector | null = null;
      if (cap !== null && cap >= SECTOR_MIN_CAP_USD && userSectors.size > 0) {
        const cached = peek(row.ticker);
        if (cached !== undefined) sector = cached;
        else if (sectorReads < FORYOU_SECTOR_READS) {
          sectorReads++;
          try {
            sector = await src.sector(row.ticker);
          } catch {
            sector = null;
            note("sectors");
          }
        }
      }
      const reason = forYouReason({ ticker: row.ticker, cap, sector, linked: row.readsThrough.length > 0 }, userSectors);
      if (reason) kept.push({ ...row, reason, marketCap: cap, sector: sector ?? row.sector });
    }
    return kept;
  };

  // ---- one answer ------------------------------------------------------------

  const answers = new Map<string, { at: number; result: EarningsResult }>();
  const building = new Map<string, Promise<EarningsResult>>();

  const build = async (req: ParsedEarningsRequest): Promise<EarningsResult> => {
    const nowMs = now();
    const today = nyToday(nowMs);
    const from = weekStartOf(today);
    const to = addDays(today, req.days - 1);
    const held = new Set(req.held);
    const watch = new Set(req.watchlist);
    const mine = [...new Set([...req.held, ...req.watchlist])];
    // Each read below can fail on its own; the answer goes on without it and says so.
    // Counted per source (rows or names affected) so the view can tell one
    // missing sector from a read that left many rows short.
    const degraded = new Map<EarningsDegradedSource, number>();
    const note: NoteDegraded = (s, count = 1) => {
      if (count > 0) degraded.set(s, (degraded.get(s) ?? 0) + count);
    };

    const [trackedTickers, cal, recentCal, names, graph] = await Promise.all([
      trackedList(),
      marketCalendar(today, to),
      from < today ? recentCalendar(from, addDays(today, -1)) : Promise.resolve(null),
      src.companyNames().catch((err: unknown) => {
        console.warn("[earnings] listing directory read failed:", err instanceof Error ? err.message : String(err));
        note("names");
        return null;
      }),
      linkIndex(),
    ]);
    const links = graph.index;
    if (graph.failed) note("links");
    const trackedSet = new Set(trackedTickers ?? []);
    const scopes = { tracked: trackedTickers !== null, all: cal !== null || deps.marketConfigured() };

    if (req.scope === "tracked" && trackedTickers === null) return { ok: false, error: "scope_unavailable" };
    if (req.scope === "all" && cal === null) return { ok: false, error: "scope_unavailable" };

    // This week's past days come from the half-hourly read, today on from
    // the six-week calendar.
    const marketBy = new Map<string, MarketCalendarEntry[]>();
    const put = (e: MarketCalendarEntry) => {
      const list = marketBy.get(e.ticker);
      if (list) list.push(e);
      else marketBy.set(e.ticker, [e]);
    };
    for (const e of recentCal?.entries ?? []) if (e.date >= from && e.date < today) put(e);
    for (const e of cal?.file.entries ?? []) if (e.date >= today && e.date <= to) put(e);

    // Who is read in detail: the names asked about, and in the market-wide
    // view only the reader's own and the covered ones. Everything else there
    // stands on the market calendar alone.
    const forYou = req.scope === "foryou";
    const detailed = new Set<string>(
      req.scope === "mine" || forYou ? mine : req.scope === "tracked" ? (trackedTickers ?? []) : [...mine, ...(trackedTickers ?? [])],
    );
    const listed = new Set<string>(detailed);
    if (req.scope === "all" || forYou) {
      for (const ticker of marketBy.keys()) {
        // With the listing directory at hand, the market view keeps to listed common stock.
        if (!names || names.has(ticker) || detailed.has(ticker)) listed.add(ticker);
      }
    }

    const reads = new Map<string, YahooEarningsRead | null>();
    const unavailable: string[] = [];
    await pool([...detailed], concurrency, async (symbol) => {
      try {
        reads.set(symbol, await detail(symbol));
      } catch {
        unavailable.push(symbol);
      }
    });

    // Nothing came back from either provider: no market calendar, old or new,
    // and not one of the names asked about could be read. Only then is the
    // answer a failure; anything less is a shorter list with a note.
    if (cal === null && (recentCal?.entries.length ?? 0) === 0 && detailed.size > 0 && reads.size === 0) {
      console.warn(`[earnings] nothing could be read: no market calendar and none of ${detailed.size} names`);
      return { ok: false, error: "unavailable" };
    }

    const rows: EarningsRow[] = [];
    for (const ticker of listed) {
      let merged: ReturnType<typeof mergeEarnings>;
      try {
        merged = mergeEarnings(reads.get(ticker) ?? null, marketBy.get(ticker) ?? [], {
          from,
          today,
          to,
          nowMs,
          snapshot: snapshotFor(ticker),
        });
      } catch (err) {
        // One provider answer that does not read leaves out its row, not the list.
        console.warn(`[earnings] ${ticker} could not be put together:`, err instanceof Error ? err.message : String(err));
        if (detailed.has(ticker) && !unavailable.includes(ticker)) unavailable.push(ticker);
        continue;
      }
      if (!merged) continue;
      let through: EarningsRow["readsThrough"] = [];
      if (links) {
        try {
          through = readsThrough(links, ticker, held, watch, deps.filingForm);
        } catch {
          note("links");
        }
      }
      rows.push({
        ticker,
        company: names?.get(ticker) ?? null,
        ...merged,
        revenueEstimateUsd: null,
        revenueActualUsd: null,
        fx: null,
        sector: null,
        held: held.has(ticker),
        watchlist: watch.has(ticker),
        tracked: trackedSet.has(ticker),
        readsThrough: through,
        reason: null,
        marketCap: null,
      });
    }

    if (forYou) {
      let kept: EarningsRow[];
      try {
        kept = await selectForYou(rows, req, held, watch, note);
      } catch (err) {
        // The selection could not be made: the reader's own names still stand.
        console.warn("[earnings] for-you selection failed:", err instanceof Error ? err.message : String(err));
        note("foryou");
        kept = rows.flatMap((row) => {
          const own = mineReason(row.ticker, held, watch);
          return own ? [{ ...row, reason: own }] : [];
        });
      }
      rows.length = 0;
      rows.push(...kept);
    }

    // Revenue in a currency other than the dollar gets the dollar figure at
    // the close of the release day (a reported row) or the latest close.
    const fxRate = src.fxRate;
    if (fxRate) {
      await pool(
        rows.filter((r) => r.revenueCurrency && r.revenueCurrency !== "USD" && (r.revenueEstimate !== null || r.revenueActual !== null)),
        concurrency,
        async (row) => {
          try {
            const fx = await fxRate(row.revenueCurrency, row.phase === "reported" ? row.date : today);
            row.fx = fx;
            row.revenueEstimateUsd = toUsd(row.revenueEstimate, fx);
            row.revenueActualUsd = toUsd(row.revenueActual, fx);
          } catch {
            row.fx = null;
            note("fx");
          }
        },
      );
    }

    // Sectors: read (through the month-long cache) only for the rows that
    // will be drawn, and only for names read in detail; the rest of the
    // market view gets a sector only when the cache already holds one.
    await pool(
      rows.filter((r) => detailed.has(r.ticker)),
      concurrency,
      async (row) => {
        try {
          row.sector = await src.sector(row.ticker);
        } catch {
          row.sector = null;
          note("sectors");
        }
      },
    );
    for (const row of rows) {
      if (!detailed.has(row.ticker)) row.sector = peek(row.ticker) ?? null;
    }

    return {
      ok: true,
      scope: req.scope,
      from,
      to,
      today,
      rows: sortRows(rows),
      builtAt: new Date(nowMs).toISOString(),
      scopes,
      unavailable: unavailable.sort(),
      marketCalendar: cal === null ? "missing" : cal.fresh ? "fresh" : "stale",
      degraded: [...degraded.keys()].sort(),
      degradedCounts: Object.fromEntries([...degraded].sort(([a], [b]) => a.localeCompare(b))),
    };
  };

  const keyOf = (req: ParsedEarningsRequest, today: string): string =>
    [req.scope, req.days, today, [...req.held].sort().join(","), [...req.watchlist].sort().join(","), [...req.sectors].sort().join(",")].join("|");

  return {
    async upcoming(req: ParsedEarningsRequest): Promise<EarningsResult> {
      const nowMs = now();
      const key = keyOf(req, nyToday(nowMs));
      const hit = answers.get(key);
      if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < ANSWER_TTL_MS) return hit.result;
      const pending = building.get(key);
      if (pending) return pending;
      const task = build(req)
        .then((result) => {
          if (result.ok) answers.set(key, { at: now(), result });
          // Old answers for other keys go once they are past use.
          for (const [k, v] of answers) if (now() - v.at >= ANSWER_TTL_MS) answers.delete(k);
          return result;
        })
        .finally(() => building.delete(key));
      building.set(key, task);
      return task;
    },
    flush,
    /** The whole Yahoo read for a name (next date, consensus, quarters), from the same cache; null when none can be read. */
    async read(symbol: string): Promise<YahooEarningsRead | null> {
      try {
        return await detail(symbol);
      } catch {
        return null;
      }
    },
    /** The quarters on record for a name, for the reaction figures; null when none can be read. */
    async quarters(symbol: string): Promise<YahooQuarter[] | null> {
      try {
        return (await detail(symbol))?.quarters ?? null;
      } catch {
        return null;
      }
    },
    /** The drawer's quarters and currencies for one name (the reaction figures are added by the caller). */
    async detail(symbol: string): Promise<Omit<EarningsDetail, "reaction">> {
      const read = await detail(symbol);
      return {
        ticker: symbol,
        quarters: (read?.quarters ?? []).map((q) => ({
          periodEnd: q.periodEnd,
          fiscalQuarter: q.fiscalQuarter,
          reportedAt: q.reportedAt,
          epsActual: q.epsActual,
          epsEstimate: q.epsEstimate,
          revenueActual: q.revenueActual,
        })),
        revenueCurrency: read?.revenueCurrency ?? null,
        epsCurrency: read?.epsCurrency ?? null,
      };
    },
  };
}

export type EarningsService = ReturnType<typeof createEarningsService>;
