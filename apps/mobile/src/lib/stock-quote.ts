const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

const PRICE_FORMAT = {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
} as const;

const QUOTE_TTL_MS = 60_000;
const QUOTE_TIMEOUT_MS = 8_000;

export type StockQuote = {
  symbol: string;
  companyName: string;
  price: number;
  change: number;
  changePercent: number;
};

type YahooChartMeta = {
  symbol?: string;
  longName?: string;
  shortName?: string;
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
};

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      meta?: YahooChartMeta;
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
    error?: { description?: string };
  };
};

export type PricePoint = { t: number; v: number };

const quoteCache = new Map<string, { at: number; quote: StockQuote }>();
const quoteInflight = new Map<string, Promise<StockQuote>>();

export function formatStockPrice(value: number): string {
  return new Intl.NumberFormat("en-US", PRICE_FORMAT).format(value);
}

export function formatSignedPercent(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

async function fetchStockQuote(symbol: string): Promise<StockQuote> {
  const normalized = symbol.trim().toUpperCase();
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(normalized)}?range=1d&interval=1d`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { headers: YAHOO_HEADERS, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`Market data request failed (${response.status})`);
  }

  const payload = (await response.json()) as YahooChartResponse;
  const meta = payload.chart?.result?.[0]?.meta;
  if (!meta) {
    throw new Error(payload.chart?.error?.description ?? "No market data returned");
  }

  const price = meta.regularMarketPrice;
  if (price == null || !Number.isFinite(price)) {
    throw new Error("Quote missing regularMarketPrice");
  }

  const previousClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
  const change = price - previousClose;
  const changePercent = previousClose !== 0 ? (change / previousClose) * 100 : 0;

  return {
    symbol: meta.symbol?.toUpperCase() ?? normalized,
    companyName: meta.longName?.trim() || meta.shortName?.trim() || normalized,
    price,
    change,
    changePercent,
  };
}

export async function getStockQuote(symbol: string): Promise<StockQuote> {
  const key = symbol.trim().toUpperCase();
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.at < QUOTE_TTL_MS) {
    return cached.quote;
  }

  const inflight = quoteInflight.get(key);
  if (inflight) return inflight;

  const request = fetchStockQuote(key)
    .then((quote) => {
      quoteCache.set(key, { at: Date.now(), quote });
      return quote;
    })
    .finally(() => {
      quoteInflight.delete(key);
    });

  quoteInflight.set(key, request);
  return request;
}

const RANGE_TTL_MS = 15 * 60_000;
const rangeCache = new Map<string, { at: number; pts: PricePoint[] }>();
const rangeInflight = new Map<string, Promise<PricePoint[]>>();

/** Daily closes between unix seconds — same shape as desktop getStockChartRange. */
export async function getStockChartRange(
  symbol: string,
  startSec: number,
  endSec: number,
): Promise<PricePoint[]> {
  const key = `${symbol.trim().toUpperCase()}:${startSec}:${endSec}`;
  const cached = rangeCache.get(key);
  if (cached && Date.now() - cached.at < RANGE_TTL_MS) return cached.pts;

  const inflight = rangeInflight.get(key);
  if (inflight) return inflight;

  const request = (async () => {
    const normalized = symbol.trim().toUpperCase();
    const url =
      `${YAHOO_CHART_BASE}/${encodeURIComponent(normalized)}` +
      `?period1=${Math.floor(startSec)}&period2=${Math.floor(endSec)}&interval=1d`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUOTE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, { headers: YAHOO_HEADERS, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`Chart request failed (${response.status})`);

    const payload = (await response.json()) as YahooChartResponse;
    const result = payload.chart?.result?.[0];
    const stamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const pts: PricePoint[] = [];
    for (let i = 0; i < stamps.length; i++) {
      const v = closes[i];
      if (v == null || !Number.isFinite(v) || v <= 0) continue;
      pts.push({ t: stamps[i] * 1000, v });
    }
    rangeCache.set(key, { at: Date.now(), pts });
    return pts;
  })().finally(() => {
    rangeInflight.delete(key);
  });

  rangeInflight.set(key, request);
  return request;
}
