import path from "node:path";
import { finnhubApiBase } from "@meridian/research";
import { resolveDataRoot } from "../data-root";
import { invokeChannel, registerIpcHandler } from "../ipc-register";
import { sectorCache } from "../calendar/register-calendar-handlers";
import { fetchMarketCaps, fetchQuoteSummaryModules, fetchStockChartRange } from "../stock/market-data-service";
import { filingForm, graphEdges } from "../research/graph-edges";
import { getUsStockCatalog } from "../stock/us-stock-catalog";
import {
  parseEarningsRequest,
  parseReactionTickers,
  type EarningsDetailResult,
  type EarningsReactionsResult,
  type EarningsResult,
} from "../../shared/earnings-types";
import { normalizeTicker } from "../../shared/calendar-events";
import type { TrackerStatus } from "../../shared/tracker-types";
import { SOURCE_TIMEOUT_MS, createEarningsService, withTimeout, type EarningsService } from "./earnings-service";
import { createFx } from "./earnings-fx";
import { createReactionService, type ReactionService } from "./earnings-reactions";

/**
 * Earnings tab and card IPC surface.
 *
 *   earnings:upcoming  { scope, days, held, watchlist }
 *       The next reports of the reader's names, the Tracker's universe, or
 *       the market-wide calendar, with each row's hour, consensus and last
 *       surprise where a provider gives them. See earnings-service.ts for the
 *       caches and how often each provider is asked.
 *
 *   earnings:reactions  string[]
 *       How each name has moved on its last reports and on a normal day,
 *       from its daily closes (earnings-reactions.ts). Asked after the table
 *       draws, so the list never waits on a year of closes per name.
 *
 *   earnings:detail  string
 *       The drawer's quarters on record and the name's reaction figures.
 *
 * Keys stay here: Finnhub is called with the key (or, in a packaged build,
 * the session token for the worker's proxy) from this process, and anything
 * that goes wrong is logged here and answered with a fixed code, since an
 * error string is how a provider's reply or a key would reach the renderer.
 */

const FETCH_TIMEOUT_MS = 15_000;

let service: EarningsService | null = null;
let reactions: ReactionService | null = null;

function finnhubKey(): string {
  return process.env.FINNHUB_API_KEY?.trim() ?? "";
}

async function fetchFinnhubCalendar(from: string, to: string): Promise<unknown> {
  const key = finnhubKey();
  if (!key) throw new Error("market calendar is not configured");
  const url = `${finnhubApiBase()}/calendar/earnings?from=${from}&to=${to}&token=${encodeURIComponent(key)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`calendar request failed (${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

let names: Promise<Map<string, string>> | null = null;

/** Symbol to company name, from the listing directory the search bar uses; read once per run. */
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

async function trackedUniverse(): Promise<string[]> {
  const answer = await invokeChannel<{ ok: true; status: TrackerStatus } | { ok: false; error?: string }>("tracker:status");
  if (!answer || answer.ok !== true || !Array.isArray(answer.status?.tickers)) throw new Error("tracker status unavailable");
  const tickers = answer.status.tickers.map((t) => t.ticker).filter((t): t is string => typeof t === "string" && t.length > 0);
  if (tickers.length === 0) throw new Error("tracker reports no tickers");
  return tickers;
}

/** Built on first use: the data root moves early in a packaged build's startup. */
function earnings(): EarningsService {
  if (!service) {
    const sectors = sectorCache();
    service = createEarningsService({
      dir: path.join(resolveDataRoot(), "earnings"),
      fetchMarketCalendar: fetchFinnhubCalendar,
      marketConfigured: () => finnhubKey().length > 0,
      fetchYahoo: (symbol) => fetchQuoteSummaryModules(symbol, ["calendarEvents", "earningsHistory", "earningsTrend", "earnings"]),
      sector: (symbol) => sectors.get(symbol),
      peekSector: (symbol) => sectors.peek(symbol),
      companyNames,
      trackedUniverse,
      graphEdges,
      filingForm,
      fxRate: fx.rate,
      fetchMarketCaps,
    });
  }
  return service;
}

/** Daily closes (FX and the reaction figures), held to the same limit as every other earnings read: the chart read has none of its own. */
const fetchDaily: typeof fetchStockChartRange = (symbol, startSec, endSec) =>
  withTimeout(fetchStockChartRange(symbol, startSec, endSec), SOURCE_TIMEOUT_MS, "daily closes");

const fx = createFx({ fetchDaily });

function reactionService(): ReactionService {
  if (!reactions) {
    const svc = earnings();
    reactions = createReactionService({
      dir: path.join(resolveDataRoot(), "earnings"),
      fetchDaily,
      quarters: (symbol) => svc.quarters(symbol),
    });
  }
  return reactions;
}

export function registerEarningsHandlers(): void {
  registerIpcHandler("earnings:upcoming", async (_event, request: unknown): Promise<EarningsResult> => {
    const parsed = parseEarningsRequest(request);
    if (!parsed) return { ok: false, error: "invalid_request" };
    try {
      return await earnings().upcoming(parsed);
    } catch (err) {
      console.warn("[earnings] upcoming failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });

  registerIpcHandler("earnings:reactions", async (_event, request: unknown): Promise<EarningsReactionsResult> => {
    const tickers = parseReactionTickers(request);
    if (!tickers) return { ok: false, error: "invalid_request" };
    try {
      return { ok: true, reactions: await reactionService().many(tickers) };
    } catch (err) {
      console.warn("[earnings] reactions failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });

  registerIpcHandler("earnings:detail", async (_event, request: unknown): Promise<EarningsDetailResult> => {
    const ticker = normalizeTicker(request);
    if (!ticker) return { ok: false, error: "invalid_request" };
    try {
      const [base, reaction] = await Promise.all([earnings().detail(ticker), reactionService().one(ticker)]);
      return { ok: true, detail: { ...base, reaction } };
    } catch (err) {
      console.warn("[earnings] detail failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });
}
