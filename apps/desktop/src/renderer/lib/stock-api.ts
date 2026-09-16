import type {
  ChartTimeframe,
  LiveQuote,
  OverviewChartTimeframe,
  PricePoint,
  StockKeyStat,
  StockNewsItem,
  StockOverviewData,
  StockQuote,
} from "../../shared/stock-types";
import type { StockCatalogEntry } from "../../shared/stock-catalog";

export type StockPanelData = {
  quote: StockQuote;
  series: PricePoint[];
  keyStats: StockKeyStat[];
};

function requireBridge() {
  const bridge = window.meridian;
  if (!bridge?.getStockPanelData || !bridge.getStockQuote) {
    throw new Error(
      "Stock API is unavailable. Quit the app completely and run pnpm dev:desktop again.",
    );
  }
  return bridge;
}

export async function searchStockSymbols(
  query: string,
  limit = 50,
): Promise<StockCatalogEntry[]> {
  const bridge = window.meridian;
  if (!bridge?.searchStockSymbols) {
    throw new Error(
      "Stock API is unavailable. Quit the app completely and run pnpm dev:desktop again.",
    );
  }
  return bridge.searchStockSymbols(query, limit);
}

export async function getRandomStockSymbol(): Promise<string> {
  const bridge = window.meridian;
  if (!bridge?.getRandomStockSymbol) {
    throw new Error(
      "Stock API is unavailable. Quit the app completely and run pnpm dev:desktop again.",
    );
  }
  return bridge.getRandomStockSymbol();
}

export async function getStockPanelData(
  symbol: string,
  timeframe: ChartTimeframe,
): Promise<StockPanelData> {
  return requireBridge().getStockPanelData(symbol, timeframe);
}

export async function getStockQuote(symbol: string): Promise<StockQuote> {
  return requireBridge().getStockQuote(symbol);
}

/** Latest traded price (incl. pre/post market). Resolves to `null` when the
 *  bridge is missing so callers can keep polling without crashing. */
export async function getLiveQuote(
  symbol: string,
): Promise<{ ok: true; quote: LiveQuote } | { ok: false; error: string }> {
  const bridge = window.meridian;
  if (!bridge?.getLiveQuote) {
    return {
      ok: false,
      error: "Live quotes unavailable — quit the app completely and run pnpm dev:desktop again.",
    };
  }
  return bridge.getLiveQuote(symbol);
}

export async function getStockChart(
  symbol: string,
  timeframe: ChartTimeframe,
): Promise<PricePoint[]> {
  const bridge = window.meridian;
  if (!bridge?.getStockChart) {
    throw new Error(
      "Stock API is unavailable. Quit the app completely and run pnpm dev:desktop again.",
    );
  }
  return bridge.getStockChart(symbol, timeframe);
}

export async function getStockKeyStats(symbol: string): Promise<StockKeyStat[]> {
  const bridge = window.meridian;
  if (!bridge?.getStockKeyStats) {
    throw new Error(
      "Stock API is unavailable. Quit the app completely and run pnpm dev:desktop again.",
    );
  }
  return bridge.getStockKeyStats(symbol);
}

export async function getStockOverview(
  symbol: string,
  timeframe: OverviewChartTimeframe,
  intervalOverride?: string,
): Promise<StockOverviewData> {
  const bridge = window.meridian;
  if (!bridge?.getStockOverview) {
    throw new Error(
      "Stock API is unavailable. Quit the app completely and run pnpm dev:desktop again.",
    );
  }
  return bridge.getStockOverview(symbol, timeframe, intervalOverride);
}

export async function getStockChartRange(
  symbol: string,
  startSec: number,
  endSec: number,
): Promise<PricePoint[]> {
  const bridge = window.meridian;
  if (!bridge?.getStockChartRange) {
    throw new Error(
      "Stock API is unavailable. Quit the app completely and run pnpm dev:desktop again.",
    );
  }
  return bridge.getStockChartRange(symbol, startSec, endSec);
}

export async function getStockNews(symbol: string): Promise<StockNewsItem[]> {
  const bridge = window.meridian;
  if (!bridge?.getStockNews) {
    throw new Error(
      "Stock API is unavailable. Quit the app completely and run pnpm dev:desktop again.",
    );
  }
  return bridge.getStockNews(symbol);
}

export type {
  ChartTimeframe,
  LiveQuote,
  OverviewChartTimeframe,
  PricePoint,
  StockCatalogEntry,
  StockKeyStat,
  StockNewsItem,
  StockOverviewData,
  StockQuote,
};
