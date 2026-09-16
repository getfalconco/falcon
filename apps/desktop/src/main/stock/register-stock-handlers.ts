import type { ChartTimeframe, OverviewChartTimeframe } from "../../shared/stock-types";
import { registerIpcHandler } from "../ipc-register";
import {
  computeMoveSince,
  fetchLiveQuote,
  fetchStockChart,
  fetchStockChartRange,
  fetchStockNews,
  fetchStockOverview,
  fetchStockPanelData,
  fetchStockKeyStats,
  fetchStockQuote,
} from "./market-data-service";
import { getRandomUsStock, searchUsStocks } from "./us-stock-catalog";

export function registerStockHandlers(): void {
  registerIpcHandler("stock:search-symbols", async (_event, query: string, limit?: number) => {
    return searchUsStocks(query, limit ?? 50);
  });

  registerIpcHandler("stock:get-random-symbol", async () => {
    const entry = await getRandomUsStock();
    return entry.symbol;
  });

  registerIpcHandler("stock:get-panel-data", async (_event, symbol: string, timeframe: ChartTimeframe) => {
    return fetchStockPanelData(symbol, timeframe);
  });

  registerIpcHandler("stock:get-quote", async (_event, symbol: string) => {
    return fetchStockQuote(symbol);
  });

  // Polled every few seconds by the stock screen — never throws, so a transient
  // Yahoo hiccup just leaves the last price on screen.
  registerIpcHandler("stock:get-live-quote", async (_event, symbol: string) => {
    try {
      return { ok: true as const, quote: await fetchLiveQuote(symbol) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler(
    "stock:get-chart",
    async (_event, symbol: string, timeframe: ChartTimeframe) => {
      return fetchStockChart(symbol, timeframe);
    },
  );

  registerIpcHandler("stock:get-key-stats", async (_event, symbol: string) => {
    return fetchStockKeyStats(symbol);
  });

  registerIpcHandler(
    "stock:get-overview",
    async (
      _event,
      symbol: string,
      timeframe: OverviewChartTimeframe,
      intervalOverride?: string,
    ) => {
      return fetchStockOverview(symbol, timeframe, intervalOverride);
    },
  );

  registerIpcHandler(
    "stock:get-chart-range",
    async (_event, symbol: string, startSec: number, endSec: number) => {
      return fetchStockChartRange(symbol, startSec, endSec);
    },
  );

  registerIpcHandler("stock:get-news", async (_event, symbol: string) => {
    return fetchStockNews(symbol);
  });

  // Price movement since a news event for a pair of tickers (source + target).
  // Powers the Opportunities view's "since the news" price panels.
  registerIpcHandler(
    "stock:move-since",
    async (
      _event,
      payload: { rootTicker: string; terminalTicker: string; sinceSec: number },
    ) => {
      try {
        const [root, terminal] = await Promise.all([
          computeMoveSince(payload.rootTicker, payload.sinceSec),
          computeMoveSince(payload.terminalTicker, payload.sinceSec),
        ]);
        return { ok: true as const, root, terminal };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
