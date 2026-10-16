/**
 * Stock tab: the changes list, the earnings history and the competitor
 * figures for one stock, behind disk caches sized to how fast each source
 * moves. Everything lives under `<data root>/stock-tab/`:
 *
 *   yahoo.json            the day's parsed Yahoo read per stock (earnings
 *                         trend, short interest, mean price estimate): one
 *                         quote-summary request per stock per New York day
 *   price-estimates.json  one mean price estimate reading a day per stock,
 *                         120 days: the provider keeps no history of its own
 *   visits.json           when the reader last opened each stock, and the
 *                         graph links it had then
 *   form4.json            Form 4 totals by accession (a filed form never changes)
 *   closes.json           the day's daily closes per symbol (two years for the
 *                         stock, a year and a bit for its peers)
 *   quarters.json         the quarters on record per stock, kept as Yahoo
 *                         drops its oldest
 *   tags.json             the thesis tags, by (ticker, thesis, items, language)
 *
 * Providers are reached only through the readers injected here, which are the
 * app's own (the earnings service's Yahoo read and reaction figures, the
 * agents engine's EDGAR reader, the chart path), so their caches and spacing
 * hold. Electron-free: the readers, the folder and the clock are injected.
 */

import path from "node:path";
import type { GlossModelCaller } from "@meridian/research/gloss";
import { readJson, writeJsonAtomic } from "../briefing/json-file";
import type { FilingRef } from "../agents/sources";
import type { EarningsReaction, EarningsRow, EarningsFx } from "../../shared/earnings-types";
import type { PricePoint } from "../../shared/stock-types";
import { nyYmdOf } from "../../shared/earnings-time";
import type {
  ChangeItem,
  ChangeTagsResult,
  NextReport,
  PeerRow,
  ReportRow,
  StockChanges,
  StockChangesResult,
  StockEarnings,
  StockEarningsResult,
  StockPeers,
  StockPeersResult,
} from "../../shared/stock-tab-data";
import { coMovement, shockVsShift, MIN_OVERLAP_QUARTER, MIN_OVERLAP_YEAR, QUARTER_SESSIONS, YEAR_SESSIONS, type Bar } from "../../shared/peer-dynamics";
import type { YahooEarningsRead, YahooQuarter } from "../earnings/earnings-sources";
import { toUsd } from "../earnings/earnings-fx";
import { barsFrom } from "../earnings/earnings-reactions";
import {
  addDaysYmd,
  changeWindow,
  edgeKey,
  insiderItems,
  linkItems,
  linksOf,
  priceEstimateItem,
  readYahooChanges,
  recordEstimate,
  revisionItems,
  shortInterestItem,
  sortItems,
  type ChangeWindow,
  type EstimatePoint,
  type GraphEdgeForChanges,
  type InsiderFiling,
  type YahooChangesRead,
} from "./changes";
import { form4Totals, type Form4Totals } from "./form4";
import { MAX_COMPETITORS, MAX_LINKED, linksAround } from "./graph-links";
import { assembleReports, leadReports, mergeQuarters, seasonWindow, type LinkedCompany, type ReleaseFiling } from "./report-history";
import { MAX_CALLS_PER_DAY, itemsHash, tagChanges, tagsKey } from "./thesis-tags";

const MIN = 60_000;
const DAY_MS = 86_400_000;
const FAILURE_RETRY_MS = 30 * MIN;
const ANSWER_TTL_MS = 20 * MIN;
const SESSION_WINDOW_MS = 12 * 60 * MIN;
const STOCK_HISTORY_DAYS = 800;
/** Closes for the longer report history (twelve reports reach back about three years). */
export const REPORT_HISTORY_DAYS = 1300;
/** Reports the history read carries at most. */
export const REPORT_HISTORY_ROWS = 12;
const PEER_HISTORY_DAYS = 400;
const MAX_FORM4_READS = 24;
const FORM4_CACHE_CAP = 4000;
const INSIDER_BUDGET_MS = 15_000;
const TAG_ENTRIES_DAYS = 7;
const SECTOR_PEER_MIN_CAP = 10e9;
const SECTOR_CANDIDATES = 100;
const FLUSH_DELAY_MS = 400;

const SCHEMA = 1;

export type StockTabDeps = {
  dir: string;
  now?: () => number;
  /** Raw Yahoo quote-summary modules for a symbol. */
  fetchYahoo: (symbol: string, modules: readonly string[]) => Promise<Record<string, unknown> | null>;
  fetchDaily: (symbol: string, startSec: number, endSec: number) => Promise<PricePoint[]>;
  /** The company's EDGAR filings, newest first, as far back as the index goes. */
  filings: (ticker: string) => Promise<FilingRef[]>;
  /** A Form 4's ownership XML; null when it cannot be read. */
  form4Xml: (filing: FilingRef) => Promise<string | null>;
  graphEdges: () => Promise<GraphEdgeForChanges[]>;
  /** The graph file's build instant, ISO; null when unknown. */
  graphBuiltAt: () => Promise<string | null>;
  /** When a filer's links were extracted (step1 meta), ISO; null when not on disk. */
  linksExtractedAt: (filer: string) => string | null;
  earnings: {
    /** Yahoo's earnings read for a symbol (the earnings service's cached one); null when none. */
    read: (symbol: string) => Promise<YahooEarningsRead | null>;
    /** The Earnings tab's row for the next report, when it falls inside the tab's window. */
    upcoming: (symbol: string) => Promise<EarningsRow | null>;
    reaction: (symbol: string) => Promise<EarningsReaction | null>;
    fxRate: (currency: string | null, ymd: string) => Promise<EarningsFx | null>;
  };
  sectors: {
    get: (symbol: string) => Promise<string | null>;
    /** Every symbol whose sector is on record, with it. */
    known: () => Array<{ symbol: string; sector: string }>;
  };
  marketCaps: (symbols: readonly string[]) => Promise<Record<string, number>>;
  companyName: (symbol: string) => Promise<string | null>;
  caller: GlossModelCaller;
  configured: () => boolean;
  language: () => string;
};

type DayFile<T> = { schema_version: number; day: string; symbols: Record<string, T> };
type VisitsFile = { schema_version: number; symbols: Record<string, { at: number; links: string[] }> };
type EstimatesFile = { schema_version: number; symbols: Record<string, EstimatePoint[]> };
type Form4File = { schema_version: number; forms: Record<string, Form4Totals | null> };
type QuartersFile = { schema_version: number; symbols: Record<string, YahooQuarter[]> };
type TagsFile = {
  schema_version: number;
  day: string;
  calls: Record<string, number>;
  entries: Record<string, { day: string; itemsHash: string; tags: import("../../shared/stock-tab-data").ChangeTag[] }>;
};
type ClosesEntry = { days: number; bars: Bar[] };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

function withBudget<T>(task: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createStockTabService(deps: StockTabDeps) {
  const now = deps.now ?? Date.now;
  const file = (name: string) => path.join(deps.dir, name);

  // ---- small disk stores ---------------------------------------------------

  const stores = new Map<string, unknown>();
  const dirty = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function load<T>(name: string, fresh: () => T, valid: (v: T) => boolean): T {
    const hit = stores.get(name) as T | undefined;
    if (hit !== undefined && valid(hit)) return hit;
    const disk = readJson<T>(file(name));
    const value = disk && valid(disk) ? disk : fresh();
    stores.set(name, value);
    return value;
  }

  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    for (const name of dirty) {
      try {
        writeJsonAtomic(file(name), stores.get(name));
      } catch (err) {
        console.warn("[stock-tab] write failed:", name, errText(err));
      }
    }
    dirty.clear();
  };

  const touch = (name: string): void => {
    dirty.add(name);
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
    flushTimer.unref?.();
  };

  const today = () => nyYmdOf(now());

  const dayFile = <T>(name: string): DayFile<T> => {
    const day = today();
    return load<DayFile<T>>(
      name,
      () => ({ schema_version: SCHEMA, day, symbols: {} }),
      (v) => v.schema_version === SCHEMA && v.day === day && !!v.symbols && typeof v.symbols === "object",
    );
  };

  // ---- Yahoo, once a day per stock ----------------------------------------

  const failedAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<unknown>>();

  function once<T>(key: string, task: () => Promise<T>): Promise<T> {
    const pending = inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const p = task().finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }

  const yahooChanges = (symbol: string): Promise<YahooChangesRead | null> =>
    once(`yahoo:${symbol}`, async () => {
      const store = dayFile<YahooChangesRead | null>("yahoo.json");
      if (symbol in store.symbols) return store.symbols[symbol] ?? null;
      const failed = failedAt.get(`yahoo:${symbol}`);
      if (failed !== undefined && now() - failed < FAILURE_RETRY_MS) throw new Error("yahoo read failed recently");
      try {
        const read = readYahooChanges(await deps.fetchYahoo(symbol, ["earningsTrend", "defaultKeyStatistics", "financialData"]));
        dayFile<YahooChangesRead | null>("yahoo.json").symbols[symbol] = read;
        touch("yahoo.json");
        // The day's price estimate reading, kept for the thirty-day comparison.
        const est = load<EstimatesFile>(
          "price-estimates.json",
          () => ({ schema_version: SCHEMA, symbols: {} }),
          (v) => v.schema_version === SCHEMA && !!v.symbols,
        );
        est.symbols[symbol] = recordEstimate(est.symbols[symbol] ?? [], today(), read.priceEstimate);
        touch("price-estimates.json");
        return read;
      } catch (err) {
        failedAt.set(`yahoo:${symbol}`, now());
        throw err;
      }
    });

  // ---- daily closes, once a day per symbol --------------------------------

  const closes = (symbol: string, days: number): Promise<Bar[]> =>
    once(`closes:${symbol}:${days}`, async () => {
      const store = dayFile<ClosesEntry>("closes.json");
      const hit = store.symbols[symbol];
      if (hit && hit.days >= days) return hit.bars;
      const failed = failedAt.get(`closes:${symbol}`);
      if (failed !== undefined && now() - failed < FAILURE_RETRY_MS) return hit?.bars ?? [];
      try {
        const nowMs = now();
        const points = await deps.fetchDaily(symbol, Math.floor((nowMs - days * DAY_MS) / 1000), Math.floor(nowMs / 1000));
        const bars = barsFrom(points);
        dayFile<ClosesEntry>("closes.json").symbols[symbol] = { days, bars };
        touch("closes.json");
        return bars;
      } catch (err) {
        failedAt.set(`closes:${symbol}`, now());
        console.warn("[stock-tab] closes read failed:", symbol, errText(err));
        return hit?.bars ?? [];
      }
    });

  // ---- insiders --------------------------------------------------------------

  const form4Store = () =>
    load<Form4File>("form4.json", () => ({ schema_version: SCHEMA, forms: {} }), (v) => v.schema_version === SCHEMA && !!v.forms);

  const insiderFilings = async (ticker: string, since: string): Promise<InsiderFiling[]> => {
    const all = await deps.filings(ticker);
    const forms = all.filter((f) => (f.form === "4" || f.form === "4/A") && f.filedAt >= since).slice(0, MAX_FORM4_READS);
    const out: InsiderFiling[] = [];
    for (const f of forms) {
      const store = form4Store();
      let totals: Form4Totals | null | undefined = store.forms[f.accession];
      if (totals === undefined) {
        const xml = await deps.form4Xml(f);
        // A failed read is not cached: the next visit asks again.
        if (xml === null) continue;
        totals = form4Totals(xml);
        store.forms[f.accession] = totals;
        const keys = Object.keys(store.forms);
        if (keys.length > FORM4_CACHE_CAP) for (const k of keys.slice(0, keys.length - FORM4_CACHE_CAP)) delete store.forms[k];
        touch("form4.json");
      }
      if (totals) out.push({ accession: f.accession, filedAt: f.filedAt, url: f.url, totals });
    }
    return out;
  };

  // ---- visits ----------------------------------------------------------------

  const visits = () =>
    load<VisitsFile>("visits.json", () => ({ schema_version: SCHEMA, symbols: {} }), (v) => v.schema_version === SCHEMA && !!v.symbols);

  /** The window for this run: fixed at the first open, so a refresh does not shrink it to a week. */
  const sessions = new Map<string, { at: number; window: ChangeWindow; previous: Set<string> | null }>();

  const visitWindow = (ticker: string): { window: ChangeWindow; previous: Set<string> | null } => {
    const nowMs = now();
    const held = sessions.get(ticker);
    if (held && nowMs - held.at < SESSION_WINDOW_MS) return held;
    const prev = visits().symbols[ticker];
    const entry = {
      at: nowMs,
      window: changeWindow(prev && Number.isFinite(prev.at) ? prev.at : null, nowMs),
      previous: prev && Array.isArray(prev.links) ? new Set(prev.links) : null,
    };
    sessions.set(ticker, entry);
    return entry;
  };

  const recordVisit = (ticker: string, links: string[]): void => {
    visits().symbols[ticker] = { at: now(), links };
    touch("visits.json");
  };

  // ---- changes ---------------------------------------------------------------

  const changeAnswers = new Map<string, { at: number; changes: StockChanges }>();

  const buildChanges = async (ticker: string): Promise<StockChanges> => {
    const { window, previous } = visitWindow(ticker);
    const asOf = today();
    const degraded: StockChanges["degraded"] = [];
    const items: ChangeItem[] = [];

    const yahoo = yahooChanges(ticker).catch((err) => {
      console.warn("[stock-tab] yahoo changes failed:", ticker, errText(err));
      degraded.push("yahoo");
      return null;
    });
    const insiders = withBudget(insiderFilings(ticker, window.since), INSIDER_BUDGET_MS).catch((err) => {
      console.warn("[stock-tab] insider read failed:", ticker, errText(err));
      return "failed" as const;
    });
    const graph = Promise.all([deps.graphEdges(), deps.graphBuiltAt()]).catch((err) => {
      console.warn("[stock-tab] graph read failed:", errText(err));
      return null;
    });

    const read = await yahoo;
    if (read) {
      items.push(...revisionItems(read.trend, window.days, asOf));
      const si = shortInterestItem(read.short, window.since);
      if (si) items.push(si);
      const history = load<EstimatesFile>("price-estimates.json", () => ({ schema_version: SCHEMA, symbols: {} }), (v) => !!v.symbols).symbols[ticker] ?? [];
      const pe = priceEstimateItem(history, asOf, read.priceEstimate?.currency ?? null);
      if (pe) items.push(pe);
    }

    const ins = await insiders;
    if (ins === "failed" || ins === "timeout") degraded.push("insiders");
    else items.push(...insiderItems(ins, window.since));

    const g = await graph;
    if (!g) degraded.push("graph");
    else {
      const [edges, builtAt] = g;
      const graphDate = builtAt && Number.isFinite(Date.parse(builtAt)) ? nyYmdOf(Date.parse(builtAt)) : null;
      items.push(
        ...linkItems(edges, ticker, {
          since: window.since,
          today: asOf,
          previous,
          graphDate,
          builtOn: (filer) => {
            const at = deps.linksExtractedAt(filer);
            const ms = at ? Date.parse(at) : NaN;
            return Number.isFinite(ms) ? nyYmdOf(ms) : null;
          },
        }),
      );
      recordVisit(ticker, linksOf(edges, ticker).map(edgeKey));
    }

    const sorted = sortItems(items);
    return {
      ticker,
      since: window.since,
      sinceVisit: window.sinceVisit,
      asOf,
      items: sorted,
      itemsHash: itemsHash(sorted),
      degraded,
    };
  };

  const changes = (ticker: string): Promise<StockChanges> =>
    once(`changes:${ticker}`, async () => {
      const hit = changeAnswers.get(ticker);
      if (hit && now() - hit.at < ANSWER_TTL_MS && hit.changes.asOf === today()) return hit.changes;
      const built = await buildChanges(ticker);
      changeAnswers.set(ticker, { at: now(), changes: built });
      return built;
    });

  // ---- thesis tags -----------------------------------------------------------

  const tagStore = () => {
    const day = today();
    const store = load<TagsFile>(
      "tags.json",
      () => ({ schema_version: SCHEMA, day, calls: {}, entries: {} }),
      (v) => v.schema_version === SCHEMA && !!v.entries && !!v.calls,
    );
    if (store.day !== day) {
      store.day = day;
      store.calls = {};
      const floor = addDaysYmd(day, -TAG_ENTRIES_DAYS);
      for (const [k, e] of Object.entries(store.entries)) if (e.day < floor) delete store.entries[k];
      touch("tags.json");
    }
    return store;
  };

  const tags = async (ticker: string, thesis: string): Promise<ChangeTagsResult> => {
    const list = await changes(ticker);
    if (list.items.length === 0) return { ok: false, error: "no_changes" };
    const language = deps.language();
    const key = tagsKey(ticker, thesis, list.itemsHash, language);
    return once(`tags:${key}`, async (): Promise<ChangeTagsResult> => {
      const store = tagStore();
      const hit = store.entries[key];
      if (hit) return { ok: true, itemsHash: hit.itemsHash, tags: hit.tags };
      if (!deps.configured()) return { ok: false, error: "not_configured" };
      if ((store.calls[ticker] ?? 0) >= MAX_CALLS_PER_DAY) return { ok: false, error: "unavailable" };
      store.calls[ticker] = (store.calls[ticker] ?? 0) + 1;
      touch("tags.json");
      const result = await tagChanges(ticker, thesis, list.items, language, { caller: deps.caller });
      const fresh = tagStore();
      fresh.entries[key] = { day: today(), itemsHash: list.itemsHash, tags: result };
      touch("tags.json");
      return { ok: true, itemsHash: list.itemsHash, tags: result };
    });
  };

  // ---- earnings ----------------------------------------------------------------

  const earningsAnswers = new Map<string, { at: number; value: StockEarnings }>();

  const quarterStore = () =>
    load<QuartersFile>("quarters.json", () => ({ schema_version: SCHEMA, symbols: {} }), (v) => v.schema_version === SCHEMA && !!v.symbols);

  const nextReport = async (ticker: string, read: YahooEarningsRead | null, day: string): Promise<NextReport | null> => {
    const row = await deps.earnings.upcoming(ticker).catch(() => null);
    if (row && row.phase !== "reported" && row.date >= day) {
      return {
        date: row.date,
        windowEnd: row.windowEnd,
        time: row.time,
        status: row.status,
        fiscalPeriod: row.fiscalPeriod,
        epsEstimate: row.epsEstimate,
        epsCurrency: row.epsCurrency,
        consensus: row.consensus,
        revenueEstimate: row.revenueEstimate,
        revenueCurrency: row.revenueCurrency,
        revenueEstimateUsd: row.revenueEstimateUsd,
        fx: row.fx,
        source: { kind: row.source, url: null },
      };
    }
    if (!read) return null;
    const date = read.dates.find((d) => d >= day);
    if (!date) return null;
    // On report day Yahoo keeps the date while the quarter is already on record: that report is not "next".
    if ((read.quarters ?? []).some((q) => q.epsActual !== null && q.reportedYmd === date)) return null;
    const fx = read.revenueCurrency && read.revenueCurrency !== "USD" ? await deps.earnings.fxRate(read.revenueCurrency, day).catch(() => null) : null;
    return {
      date,
      windowEnd: read.dates.length > 1 ? read.dates[read.dates.length - 1]! : null,
      time: read.time,
      status: read.estimated === false ? "confirmed" : read.estimated === true ? "estimated" : "unknown",
      fiscalPeriod: read.consensusFiscal ?? null,
      epsEstimate: read.epsEstimate,
      epsCurrency: read.epsCurrency ?? null,
      consensus: read.consensus ?? null,
      revenueEstimate: read.revenueEstimate,
      revenueCurrency: read.revenueCurrency ?? null,
      revenueEstimateUsd: toUsd(read.revenueEstimate, fx),
      fx,
      source: { kind: "yahoo", url: null },
    };
  };

  const buildEarnings = async (ticker: string): Promise<StockEarnings> => {
    const day = today();
    const [read, bars, filings, edges] = await Promise.all([
      deps.earnings.read(ticker).catch(() => null),
      closes(ticker, STOCK_HISTORY_DAYS),
      deps.filings(ticker).catch(() => [] as FilingRef[]),
      deps.graphEdges().catch(() => [] as GraphEdgeForChanges[]),
    ]);

    const store = quarterStore();
    const quarters = mergeQuarters(store.symbols[ticker] ?? [], read?.quarters ?? []);
    if (quarters.length > 0) {
      store.symbols[ticker] = quarters;
      touch("quarters.json");
    }
    const releases: ReleaseFiling[] = filings
      .filter((f) => f.form === "8-K" && f.items.includes("2.02"))
      .map((f) => ({ acceptedAt: f.acceptedAt, acceptedAtUtc: f.acceptedAtUtc, filedAt: f.filedAt, url: f.url }));
    const reports = assembleReports(quarters, releases, bars, day);
    const next = await nextReport(ticker, read, day);

    const window = seasonWindow(reports[0]?.date ?? null, next?.date ?? null, day);
    const linked = linksAround(edges, ticker).slice(0, MAX_LINKED);
    const companies: LinkedCompany[] = [];
    await pool(linked, 3, async (l) => {
      const [r, reaction] = await Promise.all([deps.earnings.read(l.ticker).catch(() => null), deps.earnings.reaction(l.ticker).catch(() => null)]);
      if (!r?.quarters?.length) return;
      companies.push({
        ticker: l.ticker,
        category: l.category,
        direction: l.direction,
        filingUrl: l.filingUrl,
        quarters: r.quarters,
        moves: reaction?.moves ?? [],
      });
    });

    return {
      ticker,
      today: day,
      next,
      reports,
      epsCurrency: read?.epsCurrency ?? null,
      revenueCurrency: read?.revenueCurrency ?? null,
      leadSince: window.from,
      leads: leadReports(companies, window, day),
    };
  };

  // ---- report history (the implied move comparison) -------------------------

  const historyAnswers = new Map<string, { day: string; rows: ReportRow[] }>();

  /** The last reports with their moves, up to twelve, newest first: the same rows as the section, reaching further back. */
  const reportHistory = (ticker: string): Promise<ReportRow[]> =>
    once(`history:${ticker}`, async () => {
      const day = today();
      const hit = historyAnswers.get(ticker);
      if (hit && hit.day === day) return hit.rows;
      const [read, bars, filings] = await Promise.all([
        deps.earnings.read(ticker).catch(() => null),
        closes(ticker, REPORT_HISTORY_DAYS),
        deps.filings(ticker).catch(() => [] as FilingRef[]),
      ]);
      const store = quarterStore();
      const quarters = mergeQuarters(store.symbols[ticker] ?? [], read?.quarters ?? []);
      if (quarters.length > 0) {
        store.symbols[ticker] = quarters;
        touch("quarters.json");
      }
      const releases: ReleaseFiling[] = filings
        .filter((f) => f.form === "8-K" && f.items.includes("2.02"))
        .map((f) => ({ acceptedAt: f.acceptedAt, acceptedAtUtc: f.acceptedAtUtc, filedAt: f.filedAt, url: f.url }));
      const rows = assembleReports(quarters, releases, bars, day, REPORT_HISTORY_ROWS);
      // A failed closes read leaves every move empty: not worth keeping for the day.
      if (bars.length > 0) {
        // Yesterday's answers are never read again (the implied move asks for forty names a day).
        for (const [t, kept] of historyAnswers) if (kept.day !== day) historyAnswers.delete(t);
        historyAnswers.set(ticker, { day, rows });
      }
      return rows;
    });

  const earnings = (ticker: string): Promise<StockEarnings> =>
    once(`earnings:${ticker}`, async () => {
      const hit = earningsAnswers.get(ticker);
      if (hit && now() - hit.at < ANSWER_TTL_MS && hit.value.today === today()) return hit.value;
      const value = await buildEarnings(ticker);
      earningsAnswers.set(ticker, { at: now(), value });
      return value;
    });

  // ---- peers -------------------------------------------------------------------

  const peerAnswers = new Map<string, { day: string; value: StockPeers }>();

  const sectorPeers = async (ticker: string): Promise<Array<{ ticker: string; name: string | null }>> => {
    const sector = await deps.sectors.get(ticker).catch(() => null);
    if (!sector || sector === "Funds & ETFs" || sector === "Unclassified") return [];
    const candidates = deps.sectors
      .known()
      .filter((k) => k.sector === sector && k.symbol !== ticker && /^[A-Z]{1,5}$/.test(k.symbol))
      .map((k) => k.symbol)
      .slice(0, SECTOR_CANDIDATES);
    if (candidates.length === 0) return [];
    const caps = await deps.marketCaps(candidates).catch(() => ({}) as Record<string, number>);
    const ranked = candidates
      .filter((s) => (caps[s] ?? 0) >= SECTOR_PEER_MIN_CAP)
      .sort((a, b) => (caps[b] ?? 0) - (caps[a] ?? 0))
      .slice(0, MAX_COMPETITORS);
    return Promise.all(ranked.map(async (s) => ({ ticker: s, name: await deps.companyName(s).catch(() => null) })));
  };

  const buildPeers = async (ticker: string): Promise<StockPeers> => {
    const edges = await deps.graphEdges().catch(() => [] as GraphEdgeForChanges[]);
    const filed = linksAround(edges, ticker, "competitor").slice(0, MAX_COMPETITORS);
    const list: Array<{ ticker: string; name: string | null; basis: "filing" | "sector"; filingUrl: string | null }> =
      filed.length > 0
        ? await Promise.all(
            filed.map(async (l) => ({ ticker: l.ticker, name: l.name ?? (await deps.companyName(l.ticker).catch(() => null)), basis: "filing" as const, filingUrl: l.filingUrl })),
          )
        : (await sectorPeers(ticker)).map((p) => ({ ...p, basis: "sector" as const, filingUrl: null }));
    if (list.length === 0) return { ticker, asOf: null, peers: [], moves: [] };

    const stockBars = await closes(ticker, STOCK_HISTORY_DAYS);
    const series = new Map<string, Bar[]>();
    await pool(list, 3, async (p) => {
      series.set(p.ticker, await closes(p.ticker, PEER_HISTORY_DAYS));
    });
    const peers: PeerRow[] = list.map((p) => {
      const bars = series.get(p.ticker) ?? [];
      return {
        ticker: p.ticker,
        name: p.name,
        basis: p.basis,
        filingUrl: p.filingUrl,
        corr1y: coMovement(stockBars, bars, YEAR_SESSIONS, MIN_OVERLAP_YEAR),
        corr3m: coMovement(stockBars, bars, QUARTER_SESSIONS, MIN_OVERLAP_QUARTER),
      };
    });
    const withData = peers.filter((p) => p.corr1y !== null || p.corr3m !== null);
    const moves = shockVsShift(
      stockBars,
      withData.map((p) => ({ ticker: p.ticker, bars: series.get(p.ticker) ?? [] })),
    );
    const last = stockBars[stockBars.length - 1];
    return { ticker, asOf: last ? last.d : null, peers: withData, moves };
  };

  const peers = (ticker: string): Promise<StockPeers> =>
    once(`peers:${ticker}`, async () => {
      const day = today();
      const hit = peerAnswers.get(ticker);
      if (hit && hit.day === day) return hit.value;
      const value = await buildPeers(ticker);
      if (value.peers.length > 0) peerAnswers.set(ticker, { day, value });
      return value;
    });

  return {
    async changes(ticker: string): Promise<StockChangesResult> {
      try {
        return { ok: true, changes: await changes(ticker) };
      } catch (err) {
        console.warn("[stock-tab] changes failed:", ticker, errText(err));
        return { ok: false, error: "unavailable" };
      }
    },
    async tags(ticker: string, thesis: string): Promise<ChangeTagsResult> {
      try {
        return await tags(ticker, thesis);
      } catch (err) {
        console.warn("[stock-tab] thesis tags failed:", ticker, errText(err));
        return { ok: false, error: "unavailable" };
      }
    },
    async earnings(ticker: string): Promise<StockEarningsResult> {
      try {
        return { ok: true, earnings: await earnings(ticker) };
      } catch (err) {
        console.warn("[stock-tab] earnings failed:", ticker, errText(err));
        return { ok: false, error: "unavailable" };
      }
    },
    /** The last reports and their moves, up to twelve, newest first; empty when none can be read. */
    async reportHistory(ticker: string): Promise<ReportRow[]> {
      try {
        return await reportHistory(ticker);
      } catch (err) {
        console.warn("[stock-tab] report history failed:", ticker, errText(err));
        return [];
      }
    },
    async peers(ticker: string): Promise<StockPeersResult> {
      try {
        return { ok: true, peers: await peers(ticker) };
      } catch (err) {
        console.warn("[stock-tab] peers failed:", ticker, errText(err));
        return { ok: false, error: "unavailable" };
      }
    },
    /** Daily closes through the day cache (the Today line's usual day). Empty when none can be read. */
    closes(symbol: string, days: number): Promise<Bar[]> {
      return closes(symbol, days).catch(() => [] as Bar[]);
    },
    /** A Form 4's open market totals as already read (null: no such trade); undefined when not read. Never fetches. */
    form4Kept(accession: string): Form4Totals | null | undefined {
      return form4Store().forms[accession];
    },
    /** The Competitors section's tickers (its day answer, built when not yet). */
    async peerTickers(ticker: string): Promise<string[]> {
      return (await peers(ticker)).peers.map((p) => p.ticker);
    },
    flush,
  };
}

export type StockTabService = ReturnType<typeof createStockTabService>;
