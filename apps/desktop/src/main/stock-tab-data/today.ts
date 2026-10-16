/**
 * "Today" for a stock moving unusually (shared/today-move.ts has the rules):
 * the session's move against the stock's usual day and, only when it is
 * unusual, what is on record since the previous close.
 *
 * Reads, each through the app's own path and cache, each under its own time
 * budget, each failing soft (the answer stands without it and says so in
 * `degraded`):
 *
 *   quotes      the live quote (market-data-service, behind the Yahoo gate):
 *               the stock, SPY, the sector fund, the competitors
 *   closes      the Stock tab's day cache of daily closes (one read a day per
 *               symbol), for the usual day and a session that has closed
 *   SEC         the company's EDGAR index (agents/edgar, the shared SEC
 *               queue, kept four minutes); the linked companies' indexes
 *               only as already kept, never fetched here; Form 4 totals only
 *               as the Stock tab's changes list already read them
 *   radar       the read-through radar's focused answer (its own caches)
 *   news        the news feed (its cache), material stories only
 *   peers       the Competitors section's list (kept for the day)
 *
 * Electron-free: every reader and the clock are injected.
 */

import { filingAcceptedMs } from "@meridian/research/edgar-time";
import type { FilingRef } from "../agents/sources";
import type { LiveQuote } from "../../shared/stock-types";
import { nyYmdOf } from "../../shared/earnings-time";
import { yearSigma } from "../../shared/peer-dynamics";
import {
  MARKET_SYMBOL,
  barMove,
  linkedItems,
  moveCheck,
  newsItems,
  normalDay,
  ownFilings,
  peersSameWay,
  sectorFund,
  sessionFrame,
  type Bar,
  type FilingLike,
  type Form4Read,
  type MaterialLike,
  type RadarLike,
  type SessionFrame,
  type StockToday,
  type TodayDegraded,
  type Window,
} from "../../shared/today-move";
import type { GraphEdgeForChanges } from "./changes";
import { linksAround } from "./graph-links";

/** Closes for the opened stock (the Stock tab's own span) and for everything else. */
export const STOCK_DAYS = 800;
export const OTHER_DAYS = 400;
/** Each source's budget; past it the answer goes without that source. */
export const SOURCE_BUDGET_MS = 8_000;
/** A built answer is kept this long: the move changes with the price, the records by the minute. */
export const ANSWER_TTL_MS = 2 * 60_000;
/** Links whose kept EDGAR index is looked at. */
const LINKS_LOOKED_AT = 24;

export type TodayDeps = {
  now?: () => number;
  quote: (symbol: string) => Promise<LiveQuote>;
  closes: (symbol: string, days: number) => Promise<Bar[]>;
  sector: (symbol: string) => Promise<string | null>;
  /** The company's EDGAR index, newest first (one request at most, kept a few minutes). */
  filings: (ticker: string) => Promise<FilingRef[]>;
  /** A company's EDGAR index as already kept this run; null when none is. Never fetches. */
  keptFilings: (ticker: string) => FilingRef[] | null;
  /** A Form 4's open market totals as already read; undefined when not read. Never fetches. */
  form4: (accession: string) => Form4Read | null | undefined;
  graphEdges: () => Promise<GraphEdgeForChanges[]>;
  radar: (ticker: string) => Promise<RadarLike[]>;
  /** The news feed's material stories since an instant. */
  material: (sinceMs: number) => Promise<MaterialLike[]>;
  /** The Competitors section's tickers. */
  peers: (ticker: string) => Promise<string[]>;
};

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

/** The source's answer, or null (logged) when it failed or ran out of time. */
async function soft<T>(label: string, task: () => Promise<T>, ms = SOURCE_BUDGET_MS): Promise<T | null> {
  try {
    const r = await withBudget(task(), ms);
    if (r === "timeout") {
      console.warn("[stock-today] out of time:", label);
      return null;
    }
    return r;
  } catch (err) {
    console.warn("[stock-today] read failed:", label, err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function toFilingLike(f: FilingRef): FilingLike {
  return { form: f.form, accession: f.accession, filedAt: f.filedAt, acceptedMs: filingAcceptedMs(f), items: f.items, url: f.url };
}

/**
 * The session's move from a quote and closes. From the open on, the latest
 * regular print against the previous close; before it, the closed session
 * from the bars (read today, so that session is complete in them).
 */
export function sessionMove(quote: LiveQuote | null, bars: readonly Bar[], frame: SessionFrame): number | null {
  if (frame.live) {
    if (quote && quote.regularPrice && quote.previousClose) return quote.regularPrice / quote.previousClose - 1;
    return null;
  }
  return barMove(bars, frame.day, frame.previousDay);
}

export function createTodayService(deps: TodayDeps) {
  const now = deps.now ?? Date.now;
  const answers = new Map<string, { at: number; value: StockToday | null }>();
  const inFlight = new Map<string, Promise<StockToday | null>>();

  const moveOf = async (symbol: string, frame: SessionFrame, days: number): Promise<{ move: number | null; bars: Bar[] }> => {
    const [quote, bars] = await Promise.all([
      frame.live ? soft(`quote ${symbol}`, () => deps.quote(symbol)) : Promise.resolve(null),
      soft(`closes ${symbol}`, () => deps.closes(symbol, days)).then((b) => b ?? []),
    ]);
    return { move: sessionMove(quote, bars, frame), bars };
  };

  const build = async (ticker: string): Promise<StockToday | null> => {
    const nowMs = now();
    const frame = sessionFrame(nowMs);
    const [stock, market] = await Promise.all([moveOf(ticker, frame, STOCK_DAYS), moveOf(MARKET_SYMBOL, frame, OTHER_DAYS)]);
    if (stock.move === null || market.move === null) return null;
    const normal = normalDay(stock.bars, market.bars, frame.day);
    if (!normal) return null;
    const check = moveCheck(stock.move, market.move, normal);
    const base: StockToday = {
      ticker,
      day: frame.day,
      previousDay: frame.previousDay,
      since: new Date(frame.sinceMs).toISOString(),
      asOf: new Date(nowMs).toISOString(),
      move: stock.move,
      market: { symbol: MARKET_SYMBOL, move: market.move },
      sector: null,
      beta: normal.beta,
      sigma: normal.sigma,
      sessions: normal.sessions,
      abnormal: check.abnormal,
      ratio: check.ratio,
      unusual: check.unusual,
      filings: [],
      linked: [],
      news: [],
      peers: [],
      peersRead: 0,
      degraded: [],
    };
    // An ordinary day reads nothing more: the section is not shown.
    if (!check.unusual) return base;

    const w: Window = { sinceMs: frame.sinceMs, untilMs: nowMs, previousDay: frame.previousDay, untilDay: nyYmdOf(nowMs) };
    const degraded: TodayDegraded[] = [];

    const sectorTask = (async () => {
      const fund = sectorFund(await soft("sector", () => deps.sector(ticker)));
      if (!fund || fund === ticker) return null;
      const m = await moveOf(fund, frame, OTHER_DAYS);
      return m.move === null ? null : { symbol: fund, move: m.move };
    })();

    const ownTask = soft("filings", () => deps.filings(ticker));

    const linkedTask = (async () => {
      const [edges, radar] = await Promise.all([soft("graph", () => deps.graphEdges()), soft("radar", () => deps.radar(ticker))]);
      if (!edges) return null;
      const links = linksAround(edges, ticker).slice(0, LINKS_LOOKED_AT);
      return linkedItems(
        ticker,
        links,
        (t) => deps.keptFilings(t)?.map(toFilingLike) ?? null,
        radar ?? [],
        w,
      );
    })();

    const newsTask = soft("news", () => deps.material(frame.sinceMs));

    const peersTask = (async () => {
      const list = await soft("peers", () => deps.peers(ticker));
      if (!list) return null;
      const read = await Promise.all(
        list.map(async (p) => {
          const m = await moveOf(p, frame, OTHER_DAYS);
          return { ticker: p, move: m.move, sigma: yearSigma(m.bars) };
        }),
      );
      return { read: read.filter((r) => r.move !== null).length, same: peersSameWay(stock.move!, read) };
    })();

    const [sector, own, linked, material, peers] = await Promise.all([sectorTask, ownTask, linkedTask, newsTask, peersTask]);
    if (own === null) degraded.push("sec");
    if (linked === null) degraded.push("links");
    if (material === null) degraded.push("news");
    if (peers === null) degraded.push("peers");

    return {
      ...base,
      sector,
      filings: own ? ownFilings(own.map(toFilingLike), w, deps.form4) : [],
      linked: linked ?? [],
      news: material ? newsItems(material, ticker, w) : [],
      peers: peers?.same ?? [],
      peersRead: peers?.read ?? 0,
      degraded,
    };
  };

  const today = (ticker: string): Promise<StockToday | null> => {
    const hit = answers.get(ticker);
    if (hit && now() - hit.at < ANSWER_TTL_MS) return Promise.resolve(hit.value);
    const pending = inFlight.get(ticker);
    if (pending) return pending;
    const task = build(ticker)
      .then((value) => {
        answers.set(ticker, { at: now(), value });
        if (answers.size > 200) answers.delete(answers.keys().next().value as string);
        return value;
      })
      .finally(() => inFlight.delete(ticker));
    inFlight.set(ticker, task);
    return task;
  };

  return {
    today,
    /** The names among `tickers` moving unusually, three read at a time. */
    async unusual(tickers: readonly string[]): Promise<StockToday[]> {
      const out: StockToday[] = [];
      let next = 0;
      const worker = async () => {
        while (next < tickers.length) {
          const t = tickers[next++]!;
          const d = await today(t).catch(() => null);
          if (d?.unusual) out.push(d);
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, tickers.length) }, worker));
      return out.sort((a, b) => b.ratio - a.ratio);
    },
  };
}

export type TodayService = ReturnType<typeof createTodayService>;
