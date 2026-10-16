import fs from "node:fs";
import path from "node:path";
import { anthropicGlossCaller, glossConfigured } from "@meridian/research/gloss";
import { resolveDataRoot } from "../data-root";
import { invokeChannel, registerIpcHandler } from "../ipc-register";
import { getMainLanguage } from "../i18n";
import { cachedFilingHistory, daysBefore, filingHistory, form4Xml, releaseCount } from "../agents/edgar";
import { materialFromFeed } from "../agents/sources";
import { sectorCache } from "../calendar/register-calendar-handlers";
import { earningsReaders } from "../earnings/register-earnings-handlers";
import { SOURCE_TIMEOUT_MS, withTimeout } from "../earnings/earnings-service";
import { graphEdges, graphPath } from "../research/graph-edges";
import { resolveStep1DataDir } from "../research/research-paths";
import { fetchDailyRange, fetchLiveQuote, fetchMarketCaps, fetchQuoteSummaryModules } from "../stock/market-data-service";
import { asBulk } from "../stock/request-gate";
import { getUsStockCatalog } from "../stock/us-stock-catalog";
import { normalizeTicker } from "../../shared/calendar-events";
import type { EarningsResult, EarningsRow } from "../../shared/earnings-types";
import type { StockThesisResult } from "../../shared/stock-thesis";
import type { ChangeTagsResult, StockChangesResult, StockEarningsResult, StockPeersResult } from "../../shared/stock-tab-data";
import type { NewsFeedResult } from "../../shared/news-feed";
import type { ReadthroughResult } from "../../shared/readthrough-types";
import { parseTodayMovesRequest, type RadarLike, type StockTodayResult, type TodayMovesResult } from "../../shared/today-move";
import { REPORT_HISTORY_DAYS, REPORT_HISTORY_ROWS, createStockTabService, type StockTabService } from "./service";
import { createTodayService, type TodayService } from "./today";

/**
 * Stock tab data IPC (the changes, earnings and competitor sections):
 *
 *   stocktab:changes      ticker   what changed since the last visit (service.ts)
 *   stocktab:change-tags  ticker   those changes against the reader's thesis,
 *                                  read here from stock:thesis:get; one model
 *                                  call per stock per day at most
 *   stocktab:earnings     ticker   the next report, the last reports, and what
 *                                  linked companies reported first
 *   stocktab:peers        ticker   competitors, co-movement, shared moves
 *   stocktab:today        ticker   the session's move against the stock's
 *                                  usual day and, when unusual, what is on
 *                                  record since the previous close (today.ts)
 *   stocktab:today-moves  tickers  the same for held names: those moving
 *                                  unusually (the Positions card)
 *
 * Keys stay in this process: the model call and every provider read happen
 * here, and anything that goes wrong is logged here and answered with a
 * fixed code.
 */

let service: StockTabService | null = null;

let names: Promise<Map<string, string>> | null = null;
function companyNames(): Promise<Map<string, string>> {
  if (!names) {
    names = getUsStockCatalog()
      .then((list) => new Map(list.map((e) => [e.symbol.toUpperCase(), e.companyName] as const)))
      .catch((err) => {
        names = null;
        throw err;
      });
  }
  return names;
}

const extractedAt = new Map<string, string | null>();

/** When step1 extracted a filer's links, from its meta file; read once per run. */
function linksExtractedAt(filer: string): string | null {
  const key = filer.toUpperCase();
  if (extractedAt.has(key)) return extractedAt.get(key)!;
  let at: string | null = null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(resolveStep1DataDir(), `${key}.meta.json`), "utf8")) as { generatedAt?: unknown };
    at = typeof meta.generatedAt === "string" ? meta.generatedAt : null;
  } catch {
    at = null;
  }
  extractedAt.set(key, at);
  return at;
}

async function upcomingRow(ticker: string): Promise<EarningsRow | null> {
  const answer = await invokeChannel<EarningsResult>("earnings:upcoming", { scope: "mine", held: [ticker], days: 42 });
  if (!answer || answer.ok !== true) return null;
  return answer.rows.find((r) => r.ticker === ticker && r.phase !== "reported") ?? null;
}

/** Built on first use: the data root moves early in a packaged build's startup. */
function stockTab(): StockTabService {
  if (!service) {
    const sectors = sectorCache();
    const readers = earningsReaders();
    service = createStockTabService({
      dir: path.join(resolveDataRoot(), "stock-tab"),
      fetchYahoo: (symbol, modules) => withTimeout(fetchQuoteSummaryModules(symbol, modules), SOURCE_TIMEOUT_MS, "quote summary"),
      // Daily candles whatever the span: the report history reaches past the three years where the chart path turns weekly.
      fetchDaily: (symbol, startSec, endSec) => withTimeout(fetchDailyRange(symbol, startSec, endSec), SOURCE_TIMEOUT_MS, "daily closes"),
      // The report history's 8-K releases: a heavy filer (a bank's structured notes) keeps only a year in the index's newest page.
      filings: (ticker) =>
        filingHistory(ticker, { since: daysBefore(REPORT_HISTORY_DAYS), enough: (list) => releaseCount(list) >= REPORT_HISTORY_ROWS }),
      form4Xml,
      graphEdges,
      graphBuiltAt: async () => {
        try {
          return (await fs.promises.stat(graphPath())).mtime.toISOString();
        } catch {
          return null;
        }
      },
      linksExtractedAt,
      earnings: { ...readers, upcoming: upcomingRow },
      sectors: { get: (symbol) => sectors.get(symbol), known: () => sectors.known() },
      marketCaps: fetchMarketCaps,
      companyName: async (symbol) => (await companyNames()).get(symbol.toUpperCase()) ?? null,
      caller: anthropicGlossCaller,
      configured: glossConfigured,
      language: getMainLanguage,
    });
  }
  return service;
}

/** The News card's own request, so this read shares the feed cache with it (agents/sources-live). */
const NEWS_FEED_REQUEST = { days: 3, limit: 300 };

let todayService: TodayService | null = null;

function todayReads(): TodayService {
  if (!todayService) {
    const tab = stockTab();
    const sectors = sectorCache();
    todayService = createTodayService({
      quote: (symbol) => fetchLiveQuote(symbol),
      closes: (symbol, days) => tab.closes(symbol, days),
      sector: (symbol) => sectors.get(symbol),
      // The index alone: the window is a day, and the newest page always holds it.
      filings: (ticker) => filingHistory(ticker),
      keptFilings: (ticker) => cachedFilingHistory(ticker),
      form4: (accession) => tab.form4Kept(accession),
      graphEdges,
      radar: async (ticker) => {
        const answer = await invokeChannel<ReadthroughResult>("readthrough:radar", { focus: ticker });
        if (!answer || answer.ok !== true) throw new Error("the read-through radar is unavailable");
        return answer.rows.map((r): RadarLike => ({ counterparty: r.counterparty, kind: r.kind, date: r.date, time: r.time, releasedMs: null }));
      },
      material: async (sinceMs) => materialFromFeed(await invokeChannel<NewsFeedResult>("news:feed", NEWS_FEED_REQUEST), sinceMs),
      peers: (ticker) => tab.peerTickers(ticker),
    });
  }
  return todayService;
}

/**
 * The stock's last reports and their moves (up to twelve, newest first),
 * through the Stock tab's own caches, for features that compare against them
 * (main/options, the implied move).
 */
export function stockReportHistory(ticker: string) {
  return stockTab().reportHistory(ticker);
}

export function registerStockTabDataHandlers(): void {
  registerIpcHandler("stocktab:changes", async (_event, request: unknown): Promise<StockChangesResult> => {
    const ticker = normalizeTicker(request);
    if (!ticker) return { ok: false, error: "invalid_request" };
    return stockTab().changes(ticker);
  });

  registerIpcHandler("stocktab:change-tags", async (_event, request: unknown): Promise<ChangeTagsResult> => {
    const ticker = normalizeTicker(request);
    if (!ticker) return { ok: false, error: "invalid_request" };
    let thesis: string | null = null;
    try {
      const answer = await invokeChannel<StockThesisResult>("stock:thesis:get", ticker);
      thesis = answer && answer.ok ? (answer.thesis?.text.trim() ?? null) : null;
    } catch (err) {
      console.warn("[stock-tab] thesis read failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
    if (!thesis) return { ok: false, error: "no_thesis" };
    return stockTab().tags(ticker, thesis);
  });

  registerIpcHandler("stocktab:earnings", async (_event, request: unknown): Promise<StockEarningsResult> => {
    const ticker = normalizeTicker(request);
    if (!ticker) return { ok: false, error: "invalid_request" };
    return stockTab().earnings(ticker);
  });

  registerIpcHandler("stocktab:peers", async (_event, request: unknown): Promise<StockPeersResult> => {
    const ticker = normalizeTicker(request);
    if (!ticker) return { ok: false, error: "invalid_request" };
    return stockTab().peers(ticker);
  });

  registerIpcHandler("stocktab:today", async (_event, request: unknown): Promise<StockTodayResult> => {
    const ticker = normalizeTicker(request);
    if (!ticker) return { ok: false, error: "invalid_request" };
    try {
      return { ok: true, today: await todayReads().today(ticker) };
    } catch (err) {
      console.warn("[stock-today] failed:", ticker, err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });

  registerIpcHandler("stocktab:today-moves", async (_event, request: unknown): Promise<TodayMovesResult> => {
    const tickers = parseTodayMovesRequest(request);
    if (!tickers) return { ok: false, error: "invalid_request" };
    try {
      // The bulk lane: forty held names never hold up a chart or a quote the reader is waiting on.
      return { ok: true, unusual: await asBulk(() => todayReads().unusual(tickers)) };
    } catch (err) {
      console.warn("[stock-today] moves failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });
}
