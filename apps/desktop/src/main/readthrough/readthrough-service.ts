/**
 * Read-through radar, put together: the filing links of the reader's names
 * (radar.ts), the report dates of the linked companies (the Earnings tab's
 * own reads), and for each pair with a report coming up or just out, the
 * measured history (event-study.ts).
 *
 * What it asks for and how often:
 *
 *   report dates   the earnings service's Yahoo reads ("mine" scope with the
 *                  linked companies as the names), which it keeps six hours
 *                  on disk and shares with the Earnings tab
 *   quarters       the same service's quarters on record, same cache
 *   releases       EDGAR's item 2.02 filings, one request per company per
 *                  New York day (releases.json); a read between 00:00 and
 *                  00:45 New York, when SEC may not have rebuilt the index
 *                  yet, is kept only ten minutes
 *   closes         two years and a bit of daily closes per name and SPY,
 *                  one chart read per name per New York day (closes.json)
 *
 * A read that fails is not tried again for half an hour; the answer stands
 * without it and says which read was missing. Whole answers are kept ten
 * minutes per request.
 *
 * Electron-free: every reader, the folder and the clock are injected.
 */

import path from "node:path";
import { inEdgarRebuildWindow } from "@meridian/research/edgar-time";
import { readJson, writeJsonAtomic } from "../briefing/json-file";
import { barsFrom } from "../earnings/earnings-reactions";
import type { LinkEdge } from "../../shared/earnings-links";
import type { EarningsRow, EarningsTime } from "../../shared/earnings-types";
import { nyYmdOf, reactionSession } from "../../shared/earnings-time";
import type { PricePoint } from "../../shared/stock-types";
import {
  READTHROUGH_AHEAD_DAYS,
  READTHROUGH_BACK_DAYS,
  READTHROUGH_BENCHMARK,
  type ParsedReadthroughRequest,
  type ReadthroughDegraded,
  type ReadthroughReport,
  type ReadthroughResult,
  type ReadthroughRow,
} from "../../shared/readthrough-types";
import {
  moveBetween,
  reportEvents,
  sessionBefore,
  studyPair,
  type Bar,
  type QuarterLike,
  type ReleaseFilingLike,
} from "./event-study";
import { WATCH_WEIGHT, accountWeights, capPairs, pairsFor, rankRows, scoreOf, weightOf, type Pair } from "./radar";

const DAY_MS = 86_400_000;
/** Eight quarters back plus a year of sessions for beta. */
export const HISTORY_DAYS = 800;
export const FAILURE_RETRY_MS = 30 * 60_000;
export const ANSWER_TTL_MS = 10 * 60_000;
/** Linked companies one answer reads report dates for. */
export const MAX_COUNTERPARTIES = 60;
/** Pairs one answer measures. */
export const MAX_STUDIES = 40;
const SCHEMA_VERSION = 1;
/** releases.json: 2 since acceptance instants follow each file's own clock (@meridian/research/edgar-time); a day read by version 1 is read again. */
const RELEASES_SCHEMA_VERSION = 2;

export type ReadthroughDeps = {
  dir: string;
  now?: () => number;
  graphEdges: () => Promise<readonly LinkEdge[]>;
  formOf?: (filer: string) => "10-K" | "20-F" | null;
  /** The next (or this week's) report of each name; the Earnings tab's "mine" answer. */
  upcoming: (tickers: string[], days: number) => Promise<EarningsRow[]>;
  quarters: (symbol: string) => Promise<QuarterLike[] | null>;
  releases: (symbol: string) => Promise<ReleaseFilingLike[]>;
  fetchDaily: (symbol: string, startSec: number, endSec: number) => Promise<PricePoint[]>;
  concurrency?: number;
};

/** How long a releases read made while EDGAR's index may not be rebuilt yet is kept. */
export const REBUILD_WINDOW_TTL_MS = 10 * 60_000;

/** `expires`: per symbol, the instant a value kept for less than the day runs out. */
type DayFile<T> = { schema_version: number; day: string; symbols: Record<string, T>; expires?: Record<string, number> };

/**
 * A per-symbol answer kept on disk for the New York day, with the half-hour
 * pause after a failure. `expiresAt`, given the read's start, may cut a
 * value's life short (null: the whole day). A file of another
 * `schemaVersion` is dropped.
 */
export function dayCache<T>(
  file: string,
  now: () => number,
  read: (symbol: string) => Promise<T>,
  expiresAt?: (readAtMs: number) => number | null,
  schemaVersion: number = SCHEMA_VERSION,
) {
  let store: DayFile<T> | null = null;
  const failedAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<T | null>>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const load = (day: string): DayFile<T> => {
    if (store && store.day === day) return store;
    const disk = readJson<DayFile<T>>(file);
    store =
      disk && disk.schema_version === schemaVersion && disk.day === day && disk.symbols && typeof disk.symbols === "object"
        ? disk
        : { schema_version: schemaVersion, day, symbols: {} };
    return store;
  };
  const flush = () => {
    flushTimer = null;
    if (!store) return;
    try {
      writeJsonAtomic(file, store);
    } catch (err) {
      console.warn("[readthrough] cache write failed:", err instanceof Error ? err.message : String(err));
    }
  };

  return (symbol: string): Promise<T | null> => {
    const nowMs = now();
    const day = nyYmdOf(nowMs);
    const s = load(day);
    const until = s.expires?.[symbol];
    if (symbol in s.symbols && (typeof until !== "number" || nowMs < until)) return Promise.resolve(s.symbols[symbol]!);
    const failed = failedAt.get(symbol);
    if (failed !== undefined && nowMs - failed < FAILURE_RETRY_MS) return Promise.resolve(null);
    const pending = inFlight.get(symbol);
    if (pending) return pending;
    const task = (async () => {
      try {
        const value = await read(symbol);
        const kept = load(day);
        kept.symbols[symbol] = value;
        const until = expiresAt?.(nowMs) ?? null;
        if (until !== null) kept.expires = { ...kept.expires, [symbol]: until };
        else if (kept.expires && symbol in kept.expires) delete kept.expires[symbol];
        if (!flushTimer) {
          flushTimer = setTimeout(flush, 250);
          flushTimer.unref?.();
        }
        return value;
      } catch (err) {
        failedAt.set(symbol, now());
        console.warn("[readthrough] read failed:", symbol, err instanceof Error ? err.message : String(err));
        return null;
      }
    })().finally(() => inFlight.delete(symbol));
    inFlight.set(symbol, task);
    return task;
  };
}

async function pool<T>(items: readonly string[], size: number, run: (item: string) => Promise<T>): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      out.set(item, await run(item));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  return out;
}

function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

type Timing = {
  kind: ReadthroughRow["kind"];
  date: string | null;
  time: EarningsTime;
  status: ReadthroughRow["status"];
  releasedAtMs: number | null;
  epsActual: number | null;
  epsEstimate: number | null;
  surprisePct: number | null;
  company: string | null;
};

/** Where a linked company stands: a report in the next four weeks, one in the last week, or neither. */
export function timingOf(row: EarningsRow | undefined, quarters: readonly QuarterLike[], today: string): Timing {
  const company = row?.company ?? null;
  const ahead = addDays(today, READTHROUGH_AHEAD_DAYS - 1);
  const back = addDays(today, -READTHROUGH_BACK_DAYS);
  if (row && row.phase !== "reported" && row.date >= today && row.date <= ahead) {
    return {
      kind: "upcoming",
      date: row.date,
      time: row.time,
      status: row.status,
      releasedAtMs: null,
      epsActual: null,
      epsEstimate: row.epsEstimate,
      surprisePct: null,
      company,
    };
  }
  if (row && row.phase === "reported" && row.date >= back && row.date <= today) {
    const surprise =
      row.epsActual !== null && row.epsEstimate !== null && row.epsEstimate !== 0
        ? Math.round(((row.epsActual - row.epsEstimate) / Math.abs(row.epsEstimate)) * 10_000) / 100
        : null;
    return {
      kind: "recent",
      date: row.date,
      time: row.time,
      status: row.status,
      releasedAtMs: row.releasedAt ? Date.parse(row.releasedAt) : null,
      epsActual: row.epsActual,
      epsEstimate: row.epsEstimate,
      surprisePct: surprise,
      company,
    };
  }
  // The provider's quarters reach further back than this week's calendar.
  const last = [...quarters]
    .filter((q) => q.epsActual !== null && (q.reportedAt || q.reportedYmd))
    .map((q) => {
      const ms = q.reportedAt ? Date.parse(q.reportedAt) : NaN;
      return { q, ms: Number.isFinite(ms) ? ms : null, date: Number.isFinite(ms) ? nyYmdOf(ms) : q.reportedYmd! };
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .pop();
  if (last && last.date >= back && last.date <= today) {
    const { q } = last;
    return {
      kind: "recent",
      date: last.date,
      time: "unknown",
      status: "confirmed",
      releasedAtMs: last.ms,
      epsActual: q.epsActual,
      epsEstimate: q.epsEstimate,
      surprisePct:
        q.epsActual !== null && q.epsEstimate !== null && q.epsEstimate !== 0
          ? Math.round(((q.epsActual - q.epsEstimate) / Math.abs(q.epsEstimate)) * 10_000) / 100
          : null,
      company,
    };
  }
  return {
    kind: "later",
    date: row && row.date >= today ? row.date : null,
    time: row?.time ?? "unknown",
    status: row?.status ?? null,
    releasedAtMs: null,
    epsActual: null,
    epsEstimate: row?.epsEstimate ?? null,
    surprisePct: null,
    company,
  };
}

/** What a recent report did: C's move and H's on the session that first traded it, and H since. */
export function reportOf(timing: Timing, cBars: readonly Bar[], hBars: readonly Bar[], today: string): ReadthroughReport {
  const reactionDay = timing.date ? reactionSession(timing.date, timing.time, timing.releasedAtMs) : null;
  const closed = (bars: readonly Bar[]) => bars.filter((b) => b.d < today);
  let counterpartyMove: number | null = null;
  let holdingOnDay: number | null = null;
  let holdingSince: number | null = null;
  let sinceTo: string | null = null;
  if (reactionDay) {
    if (reactionDay < today) {
      const cBefore = sessionBefore(cBars, reactionDay);
      const hBefore = sessionBefore(hBars, reactionDay);
      counterpartyMove = cBefore ? moveBetween(closed(cBars), cBefore, reactionDay) : null;
      holdingOnDay = hBefore ? moveBetween(closed(hBars), hBefore, reactionDay) : null;
    }
    const hBefore = sessionBefore(hBars, reactionDay);
    const last = hBars.length > 0 ? hBars.reduce((a, b) => (b.d > a.d ? b : a)) : null;
    if (hBefore && last && last.d >= reactionDay) {
      holdingSince = moveBetween(hBars, hBefore, last.d);
      sinceTo = last.d;
    }
  }
  return {
    epsActual: timing.epsActual,
    epsEstimate: timing.epsEstimate,
    surprisePct: timing.surprisePct,
    reactionDay,
    counterpartyMove,
    holdingOnDay,
    holdingSince,
    sinceTo,
  };
}

export function createReadthroughService(deps: ReadthroughDeps) {
  const now = deps.now ?? Date.now;
  const concurrency = deps.concurrency ?? 4;
  const closes = dayCache<Bar[]>(path.join(deps.dir, "closes.json"), now, async (symbol) => {
    const endMs = now();
    const points = await deps.fetchDaily(symbol, Math.floor((endMs - HISTORY_DAYS * DAY_MS) / 1000), Math.floor(endMs / 1000));
    return barsFrom(points);
  });
  const releases = dayCache<ReleaseFilingLike[]>(
    path.join(deps.dir, "releases.json"),
    now,
    (symbol) => deps.releases(symbol),
    // Read before SEC's nightly rebuild may have run, the day's answer is not final.
    (readAtMs) => (inEdgarRebuildWindow(readAtMs) ? readAtMs + REBUILD_WINDOW_TTL_MS : null),
    RELEASES_SCHEMA_VERSION,
  );
  const answers = new Map<string, { at: number; result: Promise<ReadthroughResult> }>();

  const build = async (req: ParsedReadthroughRequest): Promise<ReadthroughResult> => {
    const nowMs = now();
    const today = nyYmdOf(nowMs);
    const degraded = new Set<ReadthroughDegraded>();
    const heldSet = new Set(req.held.map((h) => h.ticker));
    const names = new Map<string, { held: boolean; watchlist: boolean }>();
    if (req.focus) names.set(req.focus, { held: heldSet.has(req.focus), watchlist: req.watchlist.includes(req.focus) });
    else {
      for (const h of req.held) names.set(h.ticker, { held: true, watchlist: req.watchlist.includes(h.ticker) });
      for (const w of req.watchlist) if (!names.has(w)) names.set(w, { held: false, watchlist: true });
    }
    const base = { ok: true as const, today, builtAt: new Date(nowMs).toISOString() };
    if (names.size === 0) return { ...base, rows: [], links: 0, truncated: false, degraded: [] };

    let edges: readonly LinkEdge[] = [];
    try {
      edges = await deps.graphEdges();
    } catch (err) {
      degraded.add("links");
      console.warn("[readthrough] links failed:", err instanceof Error ? err.message : String(err));
    }
    const all = pairsFor(edges, names, deps.formOf);
    const capped = capPairs(all, MAX_COUNTERPARTIES);
    const counterparties = [...new Set(capped.pairs.map((p) => p.counterparty))];
    if (counterparties.length === 0) return { ...base, rows: [], links: all.length, truncated: false, degraded: [...degraded] };

    const upBy = new Map<string, EarningsRow>();
    try {
      for (const row of await deps.upcoming(counterparties, READTHROUGH_AHEAD_DAYS)) upBy.set(row.ticker, row);
    } catch (err) {
      degraded.add("dates");
      console.warn("[readthrough] report dates failed:", err instanceof Error ? err.message : String(err));
    }
    const quarters = await pool(counterparties, concurrency, async (c) => {
      try {
        return (await deps.quarters(c)) ?? [];
      } catch {
        degraded.add("dates");
        return [];
      }
    });
    const timing = new Map(counterparties.map((c) => [c, timingOf(upBy.get(c), quarters.get(c) ?? [], today)] as const));

    let candidates: Pair[] = capped.pairs.filter((p) => req.focus || timing.get(p.counterparty)!.kind !== "later");
    let truncated = capped.truncated;
    if (candidates.length > MAX_STUDIES) {
      candidates = candidates.slice(0, MAX_STUDIES);
      truncated = true;
    }
    if (candidates.length === 0) return { ...base, rows: [], links: all.length, truncated, degraded: [...degraded] };

    const holdings = [...new Set(candidates.map((p) => p.holding))];
    const symbols = [...new Set([READTHROUGH_BENCHMARK, ...candidates.map((p) => p.counterparty), ...holdings, ...req.held.map((h) => h.ticker)])];
    const bars = await pool(symbols, concurrency, async (s) => (await closes(s)) ?? null);
    if ([...bars.values()].some((b) => b === null)) degraded.add("prices");
    const filingSymbols = [...new Set([...candidates.map((p) => p.counterparty), ...holdings])];
    const filings = await pool(filingSymbols, concurrency, async (s) => (await releases(s)) ?? null);
    if ([...filings.values()].some((f) => f === null)) degraded.add("filings");
    const ownQuarters = await pool(
      holdings.filter((h) => !quarters.has(h)),
      concurrency,
      async (h) => {
        try {
          return (await deps.quarters(h)) ?? [];
        } catch {
          return [];
        }
      },
    );
    const quartersOf = (s: string) => quarters.get(s) ?? ownQuarters.get(s) ?? [];

    const lastClose = (t: string): number | null => {
      const list = bars.get(t);
      return list && list.length > 0 ? list[list.length - 1]!.c : null;
    };
    const weights = accountWeights(req.held, lastClose);
    const market = bars.get(READTHROUGH_BENCHMARK) ?? [];

    const rows: ReadthroughRow[] = candidates.map((p) => {
      const t = timing.get(p.counterparty)!;
      const cBars = bars.get(p.counterparty) ?? [];
      const hBars = bars.get(p.holding) ?? [];
      const study = studyPair({
        holding: hBars,
        counterparty: cBars,
        market,
        events: reportEvents(quartersOf(p.counterparty), filings.get(p.counterparty) ?? []),
        holdingEvents: reportEvents(quartersOf(p.holding), filings.get(p.holding) ?? []),
        today,
      });
      const name = names.get(p.holding)!;
      const row: ReadthroughRow = {
        id: `${p.counterparty}>${p.holding}`,
        counterparty: p.counterparty,
        counterpartyName: t.company,
        holding: p.holding,
        held: name.held,
        watchlist: name.watchlist,
        relation: p.relation,
        tier: p.tier,
        namedBy: p.namedBy,
        form: p.form,
        filingDate: p.filingDate,
        sourceUrl: p.sourceUrl,
        kind: t.kind,
        date: t.date,
        time: t.time,
        status: t.status,
        report: t.kind === "recent" ? reportOf(t, cBars, hBars, today) : null,
        sample: study.sample,
        stats: study.stats,
        events: study.events,
        weight: name.held ? weightOf(p.holding, weights) : WATCH_WEIGHT,
        score: 0,
      };
      row.score = scoreOf(row);
      return row;
    });

    return { ...base, rows: rankRows(rows, today), links: all.length, truncated, degraded: [...degraded] };
  };

  return {
    async radar(req: ParsedReadthroughRequest): Promise<ReadthroughResult> {
      const key = JSON.stringify([req.focus, req.held.map((h) => `${h.ticker}:${h.shares ?? ""}`).sort(), [...req.watchlist].sort()]);
      const nowMs = now();
      const kept = answers.get(key);
      if (kept && nowMs - kept.at < ANSWER_TTL_MS) return kept.result;
      const result = build(req);
      answers.set(key, { at: nowMs, result });
      // A failed build is not kept.
      result.catch(() => answers.delete(key));
      if (answers.size > 40) answers.delete(answers.keys().next().value!);
      return result;
    },
  };
}

export type ReadthroughService = ReturnType<typeof createReadthroughService>;
