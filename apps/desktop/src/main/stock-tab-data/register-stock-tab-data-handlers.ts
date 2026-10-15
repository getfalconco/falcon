import fs from "node:fs";
import path from "node:path";
import { anthropicGlossCaller, glossConfigured } from "@meridian/research/gloss";
import { resolveDataRoot } from "../data-root";
import { invokeChannel, registerIpcHandler } from "../ipc-register";
import { getMainLanguage } from "../i18n";
import { filingHistory, form4Xml } from "../agents/edgar";
import { sectorCache } from "../calendar/register-calendar-handlers";
import { earningsReaders } from "../earnings/register-earnings-handlers";
import { SOURCE_TIMEOUT_MS, withTimeout } from "../earnings/earnings-service";
import { graphEdges, graphPath } from "../research/graph-edges";
import { resolveStep1DataDir } from "../research/research-paths";
import { fetchDailyRange, fetchMarketCaps, fetchQuoteSummaryModules } from "../stock/market-data-service";
import { getUsStockCatalog } from "../stock/us-stock-catalog";
import { normalizeTicker } from "../../shared/calendar-events";
import type { EarningsResult, EarningsRow } from "../../shared/earnings-types";
import type { StockThesisResult } from "../../shared/stock-thesis";
import type { ChangeTagsResult, StockChangesResult, StockEarningsResult, StockPeersResult } from "../../shared/stock-tab-data";
import { createStockTabService, type StockTabService } from "./service";

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
      filings: filingHistory,
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
}
