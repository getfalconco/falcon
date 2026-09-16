import type {
  ChartTimeframe,
  LiveQuote,
  LiveQuoteSession,
  OverviewChartTimeframe,
  PriceMoveSince,
  PricePoint,
  StockAnalystConsensus,
  StockCompanyProfile,
  StockKeyStat,
  StockNewsItem,
  StockOverviewData,
  StockOverviewStats,
  StockQuote,
  StockSessionQuote,
} from "../../shared/stock-types";

const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_SEARCH_BASE = "https://query2.finance.yahoo.com/v1/finance/search";
const YAHOO_QUOTE_SUMMARY_BASE = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const YAHOO_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YAHOO_COOKIE_URL = "https://fc.yahoo.com";
const YAHOO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

type YahooAuth = { cookie: string; crumb: string };

let cachedAuth: YahooAuth | null = null;
let cachedAuthAt = 0;
const AUTH_TTL_MS = 30 * 60 * 1000;

async function getYahooAuth(forceRefresh = false): Promise<YahooAuth | null> {
  const now = Date.now();
  if (!forceRefresh && cachedAuth && now - cachedAuthAt < AUTH_TTL_MS) {
    return cachedAuth;
  }

  try {
    const cookieResponse = await fetch(YAHOO_COOKIE_URL, {
      headers: YAHOO_HEADERS,
      redirect: "manual",
    });
    const setCookie = cookieResponse.headers.get("set-cookie");
    const cookie = setCookie?.split(";")[0] ?? "";
    if (!cookie) return null;

    const crumbResponse = await fetch(YAHOO_CRUMB_URL, {
      headers: { ...YAHOO_HEADERS, Cookie: cookie },
    });
    if (!crumbResponse.ok) return null;
    const crumb = (await crumbResponse.text()).trim();
    if (!crumb || crumb.includes("<")) return null;

    cachedAuth = { cookie, crumb };
    cachedAuthAt = now;
    return cachedAuth;
  } catch {
    return null;
  }
}

type YahooTradingPeriod = { start?: number; end?: number };

type YahooChartMeta = {
  symbol?: string;
  longName?: string;
  shortName?: string;
  /** Exchange UTC offset in seconds — used to classify pre/regular/post sessions. */
  gmtoffset?: number;
  currentTradingPeriod?: {
    pre?: YahooTradingPeriod;
    regular?: YahooTradingPeriod;
    post?: YahooTradingPeriod;
  };
  postMarketPrice?: number;
  postMarketTime?: number;
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  regularMarketOpen?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
  preMarketTime?: number;
  trailingPE?: number;
  marketCap?: number;
};

type YahooChartResult = {
  meta?: YahooChartMeta;
  timestamp?: number[];
  indicators?: {
    quote?: Array<{
      open?: Array<number | null>;
      high?: Array<number | null>;
      low?: Array<number | null>;
      close?: Array<number | null>;
      volume?: Array<number | null>;
    }>;
  };
};

type YahooChartResponse = {
  chart?: {
    result?: YahooChartResult[];
    error?: { description?: string };
  };
};

const TIMEFRAME_QUERY: Record<ChartTimeframe, { range: string; interval: string }> = {
  "1D": { range: "1d", interval: "5m" },
  "1W": { range: "5d", interval: "15m" },
  "1M": { range: "1mo", interval: "1h" },
  YTD: { range: "ytd", interval: "1d" },
  "1Y": { range: "1y", interval: "1d" },
  ALL: { range: "max", interval: "1wk" },
};

const OVERVIEW_TIMEFRAME_QUERY: Record<OverviewChartTimeframe, { range: string; interval: string }> =
  {
    "1D": { range: "1d", interval: "5m" },
    "5D": { range: "5d", interval: "15m" },
    "1M": { range: "1mo", interval: "1h" },
    "6M": { range: "6mo", interval: "1d" },
    YTD: { range: "ytd", interval: "1d" },
    "1Y": { range: "1y", interval: "1d" },
    "5Y": { range: "5y", interval: "1wk" },
    MAX: { range: "max", interval: "1mo" },
  };

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/** Intraday intervals get extended-hours candles (includePrePost). */
function isIntradayInterval(interval: string): boolean {
  return /^\d+m$|^1h$/.test(interval);
}

function localMinutesOfDay(tSec: number, offset: number): number {
  const localSec = tSec + offset;
  return Math.floor((((localSec % 86400) + 86400) % 86400) / 60);
}

/**
 * Classify an intraday timestamp into pre/regular/post. Uses the exchange's
 * actual regular-session bounds from chart meta (currentTradingPeriod) so
 * half-days and non-US exchanges classify correctly; falls back to the US
 * default 09:30–16:00 when meta is missing.
 */
function classifySession(
  tSec: number,
  meta: YahooChartMeta | undefined,
): "pre" | "reg" | "post" {
  const offset =
    typeof meta?.gmtoffset === "number" && Number.isFinite(meta.gmtoffset)
      ? meta.gmtoffset
      : -4 * 3600;

  let regStart = 570; // 09:30
  let regEnd = 960; // 16:00
  const regular = meta?.currentTradingPeriod?.regular;
  if (regular?.start != null && regular?.end != null) {
    const start = localMinutesOfDay(regular.start, offset);
    const end = localMinutesOfDay(regular.end, offset);
    // Guard against degenerate/overnight bounds — keep the US default there.
    if (end > start) {
      regStart = start;
      regEnd = end;
    }
  }

  const minutes = localMinutesOfDay(tSec, offset);
  if (minutes < regStart) return "pre";
  if (minutes >= regEnd) return "post";
  return "reg";
}

/** Pick a sensible candle interval for a custom date range. */
function intervalForRange(startSec: number, endSec: number): string {
  const spanDays = (endSec - startSec) / 86_400;
  const endIsRecent = Date.now() / 1000 - endSec < 55 * 86_400;

  if (spanDays <= 7 && endIsRecent) return "30m";
  if (spanDays <= 60 && endIsRecent) return "1h";
  if (spanDays > 365 * 3) return "1wk";
  return "1d";
}

async function fetchYahooChartRange(
  symbol: string,
  startSec: number,
  endSec: number,
  intervalOverride?: string,
): Promise<YahooChartResult> {
  const normalized = normalizeSymbol(symbol);
  const interval = intervalOverride ?? intervalForRange(startSec, endSec);
  const prePost = isIntradayInterval(interval) ? "&includePrePost=true" : "";
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(normalized)}?period1=${Math.floor(
    startSec,
  )}&period2=${Math.floor(endSec)}&interval=${interval}${prePost}`;

  const response = await fetch(url, { headers: YAHOO_HEADERS });
  if (!response.ok) {
    throw new Error(`Market data request failed (${response.status})`);
  }

  const payload = (await response.json()) as YahooChartResponse;
  const result = payload.chart?.result?.[0];

  if (!result?.meta) {
    const message = payload.chart?.error?.description ?? "No market data returned";
    throw new Error(message);
  }

  return result;
}

function seriesFromChartSafe(result: YahooChartResult): PricePoint[] {
  try {
    return seriesFromChart(result);
  } catch {
    return [];
  }
}

export async function fetchStockChartRange(
  symbol: string,
  startSec: number,
  endSec: number,
): Promise<PricePoint[]> {
  const result = await fetchYahooChartRange(symbol, startSec, endSec);
  const points = seriesFromChartSafe(result);
  if (points.length > 0) return points;

  // Intraday windows can be empty (non-trading day, or older than Yahoo's
  // intraday retention). Fall back to daily candles before giving up.
  const fallback = await fetchYahooChartRange(symbol, startSec, endSec, "1d");
  return seriesFromChartSafe(fallback);
}

/** Short-lived cache so fan-out signals sharing a (symbol, event) don't each hit Yahoo. */
const moveSinceCache = new Map<string, { at: number; value: PriceMoveSince | null }>();
const MOVE_SINCE_TTL_MS = 60_000;

/**
 * Price movement for a ticker from a reference moment (a news event) to now.
 * Used by the Opportunities view to show how the source and target stocks have
 * moved since the news landed. Returns null when no candles are available.
 */
export async function computeMoveSince(
  symbol: string,
  sinceSec: number,
): Promise<PriceMoveSince | null> {
  const normalized = normalizeSymbol(symbol);
  const cacheKey = `${normalized}|${Math.floor(sinceSec)}`;
  const cached = moveSinceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MOVE_SINCE_TTL_MS) {
    return cached.value;
  }

  const value = await computeMoveSinceUncached(normalized, sinceSec);
  moveSinceCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function computeMoveSinceUncached(
  normalized: string,
  sinceSec: number,
): Promise<PriceMoveSince | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  // Guard against a future / zero timestamp; cap the lookback window at ~120d.
  const start = Math.min(Math.max(0, Math.floor(sinceSec)), nowSec - 60);
  const clampedStart = Math.max(start, nowSec - 120 * 86_400);

  let points: PricePoint[];
  try {
    points = await fetchStockChartRange(normalized, clampedStart, nowSec);
  } catch {
    return null;
  }

  const sinceMs = clampedStart * 1000;
  // Keep only candles at/after the event; if that empties it (event older than
  // intraday retention), fall back to the full returned series.
  const afterEvent = points.filter((p) => p.t >= sinceMs);
  const series = afterEvent.length >= 2 ? afterEvent : points;
  if (series.length < 1) return null;

  const first = series[0]!;
  const last = series.at(-1)!;
  const firstClose = first.v;
  const lastClose = last.v;
  if (!Number.isFinite(firstClose) || firstClose === 0) return null;

  let low = firstClose;
  let high = firstClose;
  for (const p of series) {
    const lo = p.l ?? p.v;
    const hi = p.h ?? p.v;
    if (lo < low) low = lo;
    if (hi > high) high = hi;
  }

  const changePct = ((lastClose - firstClose) / firstClose) * 100;

  return {
    symbol: normalized,
    firstClose: Math.round(firstClose * 100) / 100,
    lastClose: Math.round(lastClose * 100) / 100,
    changePct: Math.round(changePct * 100) / 100,
    low: Math.round(low * 100) / 100,
    high: Math.round(high * 100) / 100,
    firstAt: first.t,
    lastAt: last.t,
    points: series.length,
  };
}

async function fetchYahooChart(
  symbol: string,
  timeframe: ChartTimeframe | OverviewChartTimeframe,
  intervalOverride?: string,
): Promise<YahooChartResult> {
  const normalized = normalizeSymbol(symbol);
  const query =
    timeframe in OVERVIEW_TIMEFRAME_QUERY
      ? OVERVIEW_TIMEFRAME_QUERY[timeframe as OverviewChartTimeframe]
      : TIMEFRAME_QUERY[timeframe as ChartTimeframe];
  const { range } = query;
  const interval = intervalOverride ?? query.interval;
  const prePost = isIntradayInterval(interval) ? "&includePrePost=true" : "";
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(normalized)}?range=${range}&interval=${interval}${prePost}`;

  const response = await fetch(url, { headers: YAHOO_HEADERS });
  if (!response.ok) {
    throw new Error(`Market data request failed (${response.status})`);
  }

  const payload = (await response.json()) as YahooChartResponse;
  const result = payload.chart?.result?.[0];

  if (!result?.meta) {
    const message = payload.chart?.error?.description ?? "No market data returned";
    throw new Error(message);
  }

  return result;
}

function quoteFromMeta(meta: YahooChartMeta, symbol: string): StockQuote {
  const price = meta.regularMarketPrice ?? 0;
  const previousClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
  const change = price - previousClose;
  const changePercent = previousClose !== 0 ? (change / previousClose) * 100 : 0;

  return {
    symbol: meta.symbol?.toUpperCase() ?? symbol,
    companyName: meta.longName?.trim() || meta.shortName?.trim() || symbol,
    price,
    change,
    changePercent,
  };
}

/** Period change for multi-day ranges; 1D keeps regular-session vs previous close. */
function quoteForTimeframe(
  meta: YahooChartMeta,
  symbol: string,
  series: PricePoint[],
  timeframe: ChartTimeframe,
): StockQuote {
  const normalized = normalizeSymbol(symbol);
  const base = quoteFromMeta(meta, normalized);

  if (timeframe === "1D" || series.length < 2) {
    return base;
  }

  const first = series[0]!.v;
  const last = series.at(-1)!.v;
  const change = last - first;
  const changePercent = first !== 0 ? (change / first) * 100 : 0;

  return {
    ...base,
    price: last,
    change,
    changePercent,
  };
}

function seriesFromChart(result: YahooChartResult): PricePoint[] {
  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0];
  const closes = quote?.close ?? [];
  const opens = quote?.open ?? [];
  const highs = quote?.high ?? [];
  const lows = quote?.low ?? [];
  const volumes = quote?.volume ?? [];

  // Intraday series get a pre/regular/post session tag so the chart can dim
  // extended-hours segments. Detected from the SMALLEST adjacent gap (bounded
  // scan) — a single large leading gap (overnight, halt) must not disable
  // tagging for the whole series. Daily+ series stay untagged.
  let minGapSec = Number.POSITIVE_INFINITY;
  for (let i = 1; i < Math.min(timestamps.length, 60); i++) {
    const gap = timestamps[i]! - timestamps[i - 1]!;
    if (gap > 0 && gap < minGapSec) minGapSec = gap;
  }
  const intraday = minGapSec < 7200;

  const points: PricePoint[] = [];
  for (let index = 0; index < timestamps.length; index++) {
    const close = closes[index];
    if (close == null) continue;
    points.push({
      t: timestamps[index]! * 1000,
      v: close,
      o: opens[index] ?? undefined,
      h: highs[index] ?? undefined,
      l: lows[index] ?? undefined,
      vol: volumes[index] ?? undefined,
      s: intraday ? classifySession(timestamps[index]!, result.meta) : undefined,
    });
  }

  if (points.length === 0) {
    throw new Error("No chart data available");
  }

  return points;
}

function formatCompactUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000_000) {
    return `$${(value / 1_000_000_000_000).toFixed(2)}T`;
  }
  if (abs >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (abs >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatVolume(value: number | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function keyStatsFromMeta(meta: YahooChartMeta): StockKeyStat[] {
  const dayLow = meta.regularMarketDayLow;
  const dayHigh = meta.regularMarketDayHigh;

  return [
    { id: "marketCap", label: "Market Cap", value: "—" },
    { id: "peRatio", label: "P/E Ratio", value: "—" },
    {
      id: "volume",
      label: "Volume",
      value: formatVolume(meta.regularMarketVolume),
    },
    {
      id: "weekHigh52",
      label: "52W High",
      value: meta.fiftyTwoWeekHigh != null ? formatCompactUsd(meta.fiftyTwoWeekHigh) : "—",
    },
    {
      id: "weekLow52",
      label: "52W Low",
      value: meta.fiftyTwoWeekLow != null ? formatCompactUsd(meta.fiftyTwoWeekLow) : "—",
    },
    {
      id: "dayRange",
      label: "Day Range",
      value:
        dayLow != null && dayHigh != null
          ? `${formatCompactUsd(dayLow)} – ${formatCompactUsd(dayHigh)}`
          : "—",
    },
  ];
}

export async function fetchStockQuote(symbol: string): Promise<StockQuote> {
  const result = await fetchYahooChart(symbol, "1D");
  return quoteFromMeta(result.meta!, normalizeSymbol(symbol));
}

/* ------------------------------------------------------------------ */
/* Live quote                                                          */
/* ------------------------------------------------------------------ */

/**
 * Coalescing cache for the live quote. The renderer polls every couple of
 * seconds and several panels can watch the same ticker, so identical requests
 * inside the TTL share one Yahoo round-trip.
 *
 * The TTL sits just under the 5s useLivePrices poll on purpose: three dashboard
 * surfaces price the same book on independent, out-of-phase timers, and at the
 * old 1.5s TTL each bought its own round-trip — 3-4x the upstream traffic for
 * the same prices. Keep it below the poll interval, never above, or a surface
 * renders a price older than its own refresh.
 */
const liveQuoteCache = new Map<string, { at: number; value: LiveQuote }>();
const liveQuoteInflight = new Map<string, Promise<LiveQuote>>();
const LIVE_QUOTE_TTL_MS = 4_000;

function lastClosePoint(result: YahooChartResult): { price: number; atSec: number } | null {
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  for (let index = timestamps.length - 1; index >= 0; index--) {
    const close = closes[index];
    const at = timestamps[index];
    if (close != null && Number.isFinite(close) && at != null) {
      return { price: close, atSec: at };
    }
  }
  return null;
}

/** Which session the clock is in right now — not which one the last candle sits in. */
function currentSession(meta: YahooChartMeta, nowSec: number): LiveQuoteSession {
  const period = meta.currentTradingPeriod;
  const inside = (p: YahooTradingPeriod | undefined) =>
    p?.start != null && p.end != null && nowSec >= p.start && nowSec < p.end;

  if (inside(period?.regular)) return "regular";
  if (inside(period?.pre)) return "pre";
  if (inside(period?.post)) return "post";
  // No trading period covers `now` (overnight, weekend, holiday), or Yahoo
  // didn't send one — fall back to "regular" only when the data is unusable.
  return period?.regular?.start != null ? "closed" : "regular";
}

/**
 * Only the last half-hour of candles is requested: `meta` (previous close,
 * trading periods, regular market price) comes back in full either way, so
 * this is ~3KB per poll instead of ~35KB for the whole session.
 */
const LIVE_QUOTE_WINDOW_SEC = 30 * 60;

/**
 * The last extended-hours print of the most recent trading day. The live-quote
 * window is only 30 minutes wide, so overnight and at weekends it holds no
 * candles at all — this reaches back over the whole session to find the
 * genuine last trade, which is what a held position is worth while closed.
 */
async function fetchLastExtendedPrint(
  symbol: string,
): Promise<{ price: number; atSec: number } | null> {
  try {
    const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(
      symbol,
    )}?range=1d&interval=1m&includePrePost=true`;
    const response = await fetch(url, { headers: YAHOO_HEADERS });
    if (!response.ok) return null;
    const payload = (await response.json()) as YahooChartResponse;
    const result = payload.chart?.result?.[0];
    return result ? lastClosePoint(result) : null;
  } catch {
    return null;
  }
}

async function requestLiveQuote(symbol: string): Promise<LiveQuote> {
  const nowSec = Math.floor(Date.now() / 1000);
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(symbol)}?period1=${
    nowSec - LIVE_QUOTE_WINDOW_SEC
  }&period2=${nowSec}&interval=1m&includePrePost=true`;

  const response = await fetch(url, { headers: YAHOO_HEADERS });
  if (!response.ok) {
    throw new Error(`Live quote request failed (${response.status})`);
  }

  const payload = (await response.json()) as YahooChartResponse;
  const result = payload.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) {
    throw new Error(payload.chart?.error?.description ?? "No live quote returned");
  }

  const session = currentSession(meta, nowSec);
  let last = lastClosePoint(result);
  // Closed market: the short window is empty, so go find the session's real
  // last print instead of falling back to the 16:00 close.
  if (session === "closed" && last == null) {
    last = await fetchLastExtendedPrint(symbol);
  }

  // During the regular session `regularMarketPrice` is the freshest field Yahoo
  // returns; extended hours only move the candles / the pre|post fields.
  //
  // When nothing is open (overnight, weekend, holiday) the freshest real trade
  // is the last extended-hours print, not the 16:00 close — so that is what a
  // held position is worth. Everything that prices this book must agree on it;
  // valuing here off one print and executing off another invents P&L.
  const price =
    session === "pre"
      ? (meta.preMarketPrice ?? last?.price ?? meta.regularMarketPrice ?? 0)
      : session === "post"
        ? (meta.postMarketPrice ?? last?.price ?? meta.regularMarketPrice ?? 0)
        : session === "closed"
          ? (meta.postMarketPrice ?? last?.price ?? meta.regularMarketPrice ?? 0)
          : (meta.regularMarketPrice ?? last?.price ?? 0);

  // After the close, the move is measured against today's regular close;
  // otherwise against the previous close.
  const baseline =
    session === "post"
      ? (meta.regularMarketPrice ?? meta.previousClose ?? price)
      : (meta.previousClose ?? meta.chartPreviousClose ?? price);

  const change = price - baseline;

  const asOfSec =
    (session === "pre"
      ? meta.preMarketTime
      : session === "post"
        ? meta.postMarketTime
        : session === "closed"
          ? (last?.atSec ?? meta.postMarketTime ?? meta.regularMarketTime)
          : meta.regularMarketTime) ??
    last?.atSec ??
    nowSec;

  return {
    symbol: meta.symbol?.toUpperCase() ?? symbol,
    companyName: meta.longName?.trim() || meta.shortName?.trim() || symbol,
    price,
    change,
    changePercent: baseline !== 0 ? (change / baseline) * 100 : 0,
    session,
    asOf: asOfSec * 1000,
  };
}

/** Latest traded price for a ticker, including pre/post-market sessions. */
export async function fetchLiveQuote(symbol: string): Promise<LiveQuote> {
  const normalized = normalizeSymbol(symbol);

  const cached = liveQuoteCache.get(normalized);
  if (cached && Date.now() - cached.at < LIVE_QUOTE_TTL_MS) return cached.value;

  const inflight = liveQuoteInflight.get(normalized);
  if (inflight) return inflight;

  const request = requestLiveQuote(normalized)
    .then((quote) => {
      liveQuoteCache.set(normalized, { at: Date.now(), value: quote });
      return quote;
    })
    .finally(() => {
      liveQuoteInflight.delete(normalized);
    });

  liveQuoteInflight.set(normalized, request);
  return request;
}

export async function fetchStockChart(
  symbol: string,
  timeframe: ChartTimeframe,
): Promise<PricePoint[]> {
  const result = await fetchYahooChart(symbol, timeframe);
  return seriesFromChart(result);
}

export async function fetchStockKeyStats(symbol: string): Promise<StockKeyStat[]> {
  const result = await fetchYahooChart(symbol, "1D");
  return keyStatsFromMeta(result.meta!);
}

export type StockPanelData = {
  quote: StockQuote;
  series: PricePoint[];
  keyStats: StockKeyStat[];
};

/** Single Yahoo request for quote, chart series, and key stats. */
export async function fetchStockPanelData(
  symbol: string,
  timeframe: ChartTimeframe,
): Promise<StockPanelData> {
  const normalized = normalizeSymbol(symbol);
  const result = await fetchYahooChart(normalized, timeframe);
  const series = seriesFromChart(result);

  return {
    quote: quoteForTimeframe(result.meta!, normalized, series, timeframe),
    series,
    keyStats: keyStatsFromMeta(result.meta!),
  };
}

function formatUsd(value: number | undefined, fractionDigits = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

function formatPercent(value: number | undefined, fractionDigits = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(fractionDigits)}%`;
}

function formatEmployees(value: number | undefined): string | undefined {
  if (value == null || Number.isNaN(value)) return undefined;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return value.toLocaleString("en-US");
}

function formatIpoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatMarketTimestamp(unixSeconds: number | undefined, prefix: string): string | undefined {
  if (unixSeconds == null) return undefined;
  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(new Date(unixSeconds * 1000));
  return `${prefix}: ${formatted}`;
}

/** Yahoo quoteSummary returns numbers as `{ raw, fmt }` objects (or bare numbers). */
type YahooNumber = number | { raw?: number; fmt?: string } | undefined;

function readNum(field: YahooNumber): number | undefined {
  if (field == null) return undefined;
  if (typeof field === "number") return Number.isFinite(field) ? field : undefined;
  return typeof field.raw === "number" && Number.isFinite(field.raw) ? field.raw : undefined;
}

type YahooQuoteSummaryResult = {
  assetProfile?: {
    companyOfficers?: Array<{ name?: string; title?: string }>;
    fullTimeEmployees?: number;
    sector?: string;
    industry?: string;
    country?: string;
    longBusinessSummary?: string;
  };
  summaryDetail?: {
    trailingPE?: YahooNumber;
    marketCap?: YahooNumber;
    dividendYield?: YahooNumber;
    fiftyTwoWeekLow?: YahooNumber;
    fiftyTwoWeekHigh?: YahooNumber;
  };
  defaultKeyStatistics?: {
    trailingEps?: YahooNumber;
    ipoDate?: string;
  };
  price?: {
    exchangeName?: string;
    exchange?: string;
    regularMarketOpen?: YahooNumber;
    regularMarketPreviousClose?: YahooNumber;
    preMarketPrice?: YahooNumber;
    preMarketChange?: YahooNumber;
    preMarketChangePercent?: YahooNumber;
    preMarketTime?: number;
    regularMarketTime?: number;
  };
  recommendationTrend?: {
    trend?: Array<{
      period?: string;
      strongBuy?: number;
      buy?: number;
      hold?: number;
      sell?: number;
      strongSell?: number;
    }>;
  };
  financialData?: {
    currentPrice?: YahooNumber;
    targetLowPrice?: YahooNumber;
    targetMeanPrice?: YahooNumber;
    targetHighPrice?: YahooNumber;
    recommendationKey?: string;
    numberOfAnalystOpinions?: YahooNumber;
  };
};

async function fetchQuoteSummary(symbol: string): Promise<YahooQuoteSummaryResult | null> {
  const normalized = normalizeSymbol(symbol);
  const modules = [
    "assetProfile",
    "summaryDetail",
    "defaultKeyStatistics",
    "price",
    "recommendationTrend",
    "financialData",
  ].join(",");

  async function attempt(auth: YahooAuth): Promise<Response> {
    const url = `${YAHOO_QUOTE_SUMMARY_BASE}/${encodeURIComponent(
      normalized,
    )}?modules=${modules}&crumb=${encodeURIComponent(auth.crumb)}`;
    return fetch(url, { headers: { ...YAHOO_HEADERS, Cookie: auth.cookie } });
  }

  try {
    let auth = await getYahooAuth();
    if (!auth) return null;

    let response = await attempt(auth);
    if (response.status === 401 || response.status === 403) {
      auth = await getYahooAuth(true);
      if (!auth) return null;
      response = await attempt(auth);
    }

    if (!response.ok) return null;
    const payload = (await response.json()) as {
      quoteSummary?: { result?: YahooQuoteSummaryResult[] };
    };
    return payload.quoteSummary?.result?.[0] ?? null;
  } catch {
    return null;
  }
}

function overviewStatsFromSources(
  meta: YahooChartMeta,
  summary: YahooQuoteSummaryResult | null,
): StockOverviewStats {
  const previousClose =
    meta.previousClose ??
    meta.chartPreviousClose ??
    readNum(summary?.price?.regularMarketPreviousClose);
  const dayLow = meta.regularMarketDayLow;
  const dayHigh = meta.regularMarketDayHigh;
  const weekLow = meta.fiftyTwoWeekLow ?? readNum(summary?.summaryDetail?.fiftyTwoWeekLow);
  const weekHigh = meta.fiftyTwoWeekHigh ?? readNum(summary?.summaryDetail?.fiftyTwoWeekHigh);
  const marketCap = readNum(summary?.summaryDetail?.marketCap) ?? meta.marketCap;
  const peRatio = readNum(summary?.summaryDetail?.trailingPE) ?? meta.trailingPE;
  const eps = readNum(summary?.defaultKeyStatistics?.trailingEps);
  const dividendYield = readNum(summary?.summaryDetail?.dividendYield);
  const open = meta.regularMarketOpen ?? readNum(summary?.price?.regularMarketOpen);

  return {
    prevClose: formatUsd(previousClose),
    peRatio: peRatio != null ? peRatio.toFixed(2) : "—",
    weekRange52:
      weekLow != null && weekHigh != null
        ? `${formatUsd(weekLow)} - ${formatUsd(weekHigh)}`
        : "—",
    marketCap: marketCap != null ? formatCompactUsd(marketCap) : "—",
    dayRange:
      dayLow != null && dayHigh != null
        ? `${formatUsd(dayLow)} - ${formatUsd(dayHigh)}`
        : "—",
    eps: eps != null ? formatUsd(eps) : "—",
    open: formatUsd(open),
    dividendYield:
      dividendYield != null ? formatPercent(dividendYield * 100) : "—",
    volume: formatVolume(meta.regularMarketVolume),
  };
}

function companyProfileFromSources(
  symbol: string,
  summary: YahooQuoteSummaryResult | null,
): StockCompanyProfile {
  const profile = summary?.assetProfile;
  const ceo =
    profile?.companyOfficers?.find((officer) =>
      officer.title?.toLowerCase().includes("chief executive"),
    )?.name ?? profile?.companyOfficers?.[0]?.name;

  return {
    symbol: normalizeSymbol(symbol),
    ipoDate: formatIpoDate(summary?.defaultKeyStatistics?.ipoDate),
    ceo,
    fullTimeEmployees: formatEmployees(profile?.fullTimeEmployees),
    sector: profile?.sector,
    industry: profile?.industry,
    country: profile?.country,
    exchange:
      summary?.price?.exchangeName?.trim() ||
      summary?.price?.exchange?.trim() ||
      undefined,
    description: profile?.longBusinessSummary,
  };
}

const RECOMMENDATION_LABELS: Record<string, { label: string; tone: "bullish" | "neutral" | "bearish" }> =
  {
    strong_buy: { label: "Strong Buy", tone: "bullish" },
    buy: { label: "Buy", tone: "bullish" },
    hold: { label: "Hold", tone: "neutral" },
    underperform: { label: "Underperform", tone: "bearish" },
    sell: { label: "Sell", tone: "bearish" },
    strong_sell: { label: "Strong Sell", tone: "bearish" },
  };

function analystConsensusFromSummary(
  summary: YahooQuoteSummaryResult | null,
): StockAnalystConsensus | undefined {
  const trend = summary?.recommendationTrend?.trend?.find(
    (entry) => entry.period === "0m",
  );
  const financial = summary?.financialData;

  const strongBuy = trend?.strongBuy ?? 0;
  const buy = trend?.buy ?? 0;
  const hold = trend?.hold ?? 0;
  const sell = trend?.sell ?? 0;
  const strongSell = trend?.strongSell ?? 0;

  const bullish = strongBuy + buy;
  const neutral = hold;
  const bearish = sell + strongSell;
  const analystCount = bullish + neutral + bearish;

  if (analystCount === 0 && !financial?.recommendationKey) return undefined;

  const recKey = financial?.recommendationKey?.toLowerCase();
  const mapped = recKey ? RECOMMENDATION_LABELS[recKey] : undefined;

  let rating = mapped?.label;
  let ratingTone = mapped?.tone;

  if (!rating) {
    if (bullish >= neutral && bullish >= bearish) {
      rating = "Buy";
      ratingTone = "bullish";
    } else if (bearish >= neutral && bearish >= bullish) {
      rating = "Sell";
      ratingTone = "bearish";
    } else {
      rating = "Hold";
      ratingTone = "neutral";
    }
  }

  const low = readNum(financial?.targetLowPrice);
  const current = readNum(financial?.currentPrice);
  const average = readNum(financial?.targetMeanPrice);
  const high = readNum(financial?.targetHighPrice);

  const priceTargets =
    low != null && current != null && average != null && high != null
      ? { low, current, average, high }
      : undefined;

  return {
    rating: rating ?? "Hold",
    ratingTone: ratingTone ?? "neutral",
    analystCount,
    bearish,
    neutral,
    bullish,
    priceTargets,
  };
}

function sessionQuote(
  price: number | undefined,
  change: number | undefined,
  changePercent: number | undefined,
  timestampSeconds: number | undefined,
  prefix: string,
): StockSessionQuote | undefined {
  if (price == null) return undefined;

  const resolvedChange = change ?? 0;
  const resolvedChangePercent =
    changePercent ??
    (price - resolvedChange !== 0
      ? (resolvedChange / (price - resolvedChange)) * 100
      : 0);

  return {
    price,
    change: resolvedChange,
    changePercent: resolvedChangePercent,
    timestampLabel: formatMarketTimestamp(timestampSeconds, prefix),
  };
}

export async function fetchStockOverview(
  symbol: string,
  timeframe: OverviewChartTimeframe,
  intervalOverride?: string,
): Promise<StockOverviewData> {
  const normalized = normalizeSymbol(symbol);
  const [chartResult, summary] = await Promise.all([
    fetchYahooChart(normalized, timeframe, intervalOverride),
    fetchQuoteSummary(normalized),
  ]);

  const meta = chartResult.meta!;
  const series = seriesFromChart(chartResult);
  const quote = quoteForTimeframe(meta, normalized, series, "1D");
  const previousClose =
    meta.previousClose ??
    meta.chartPreviousClose ??
    readNum(summary?.price?.regularMarketPreviousClose) ??
    quote.price;

  const atClosePrice = meta.regularMarketPrice ?? quote.price;
  const atCloseChange = atClosePrice - previousClose;
  const atCloseChangePercent =
    previousClose !== 0 ? (atCloseChange / previousClose) * 100 : 0;

  const preMarket = sessionQuote(
    readNum(summary?.price?.preMarketPrice) ?? meta.preMarketPrice,
    readNum(summary?.price?.preMarketChange) ?? meta.preMarketChange,
    readNum(summary?.price?.preMarketChangePercent) ?? meta.preMarketChangePercent,
    summary?.price?.preMarketTime ?? meta.preMarketTime,
    "Pre-market",
  );

  return {
    quote,
    series,
    previousClose,
    atClose: {
      price: atClosePrice,
      change: atCloseChange,
      changePercent: atCloseChangePercent,
      timestampLabel: formatMarketTimestamp(
        summary?.price?.regularMarketTime ?? meta.regularMarketTime,
        "At close",
      ),
    },
    preMarket,
    stats: overviewStatsFromSources(meta, summary),
    company: companyProfileFromSources(normalized, summary),
    analystConsensus: analystConsensusFromSummary(summary),
  };
}

type YahooNewsItem = {
  uuid?: string;
  title?: string;
  publisher?: string;
  link?: string;
  providerPublishTime?: number;
  thumbnail?: {
    resolutions?: Array<{ url?: string; width?: number; height?: number }>;
  };
};

function pickNewsThumbnail(thumbnail?: YahooNewsItem["thumbnail"]): string | undefined {
  const resolutions = thumbnail?.resolutions;
  if (!resolutions?.length) return undefined;
  return [...resolutions].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url;
}

export async function fetchStockNews(symbol: string, count = 12): Promise<StockNewsItem[]> {
  const normalized = normalizeSymbol(symbol);
  const url = `${YAHOO_SEARCH_BASE}?q=${encodeURIComponent(normalized)}&quotesCount=0&newsCount=${count}`;

  try {
    const response = await fetch(url, { headers: YAHOO_HEADERS });
    if (!response.ok) return [];

    const json = (await response.json()) as { news?: YahooNewsItem[] };

    return (json.news ?? [])
      .filter((item): item is YahooNewsItem & { title: string; link: string } =>
        Boolean(item.title && item.link),
      )
      .map((item) => ({
        id: item.uuid ?? item.link,
        title: item.title,
        url: item.link,
        source: item.publisher,
        publishedAt:
          item.providerPublishTime != null
            ? new Date(item.providerPublishTime * 1000).toISOString()
            : undefined,
        imageUrl: pickNewsThumbnail(item.thumbnail),
      }));
  } catch {
    return [];
  }
}
