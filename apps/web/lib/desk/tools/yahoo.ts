/**
 * Yahoo Finance reads for the Desk tools, through the backtester's polite
 * client (`yahooFetcher` in packages/backtest/src/data/http.ts: 6 at a time,
 * a gap between starts, a timeout per request, one retry on 429/5xx), so the
 * Desk and the backtests share one budget per server instance.
 *
 * The v7 quote and v10 quoteSummary endpoints need Yahoo's cookie and
 * "crumb" (fetched from Yahoo's own pages, as packages/engine/src/yahoo.ts
 * and the backtester's YahooEarningsSource do); the v8 chart does not.
 * Yahoo's terms forbid automated commercial use: a stand-in until a licensed
 * source (Massive) takes its place behind these functions.
 */

import { BROWSER_USER_AGENT, yahooFetcher } from "@falcon/backtest/data";
import { TtlCache, cached } from "./util";

const HOUR = 3_600_000;

type Session = { cookie: string; crumb: string };
let session: { value: Session; at: number } | null = null;
let sessionLoading: Promise<Session> | null = null;

async function getSession(signal?: AbortSignal): Promise<Session> {
  if (session && Date.now() - session.at < HOUR) return session.value;
  sessionLoading ??= (async () => {
    const first = await yahooFetcher.fetch("https://fc.yahoo.com", { headers: { "User-Agent": BROWSER_USER_AGENT }, redirect: "manual" }, signal);
    const cookie = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const res = await yahooFetcher.fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": BROWSER_USER_AGENT, Cookie: cookie } }, signal);
    const crumb = (await res.text()).trim();
    if (!res.ok || !crumb || crumb.includes("<") || crumb.length > 64) throw new Error("Yahoo session (crumb) unavailable");
    session = { value: { cookie, crumb }, at: Date.now() };
    return session.value;
  })().finally(() => {
    sessionLoading = null;
  });
  return sessionLoading;
}

/** For tests: forget the session and cached answers. */
export function resetYahoo(): void {
  session = null;
  sessionLoading = null;
  quoteCache.clear();
  summaryCache.clear();
  chartCache.clear();
  calendarCache.clear();
  optionsCache.clear();
}

/** GET (or POST) a crumb-protected URL; `{crumb}` in the URL is filled in. One retry with a fresh session on 401/403. */
async function withCrumb(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const s = await getSession(signal);
    const headers = { "User-Agent": BROWSER_USER_AGENT, Cookie: s.cookie, ...(init.headers as Record<string, string> | undefined) };
    const res = await yahooFetcher.fetch(url.replace("{crumb}", encodeURIComponent(s.crumb)), { ...init, headers }, signal);
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      session = null;
      continue;
    }
    return res;
  }
}

/* ------------------------------------------------------------------ quote */

/** Yahoo's v7 quote row (the fields the tools read). */
export type YahooQuote = Record<string, unknown> & { symbol?: string };

const quoteCache = new TtlCache<Promise<YahooQuote | null>>(30_000, 300);

/** The v7 quote row; null when Yahoo has no such symbol. Cached 30 s. */
export function yahooQuote(symbol: string, signal?: AbortSignal): Promise<YahooQuote | null> {
  return cached(quoteCache, symbol, async () => {
    const res = await withCrumb(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}&crumb={crumb}`, {}, signal);
    if (!res.ok) throw new Error(`Yahoo quote HTTP ${res.status}`);
    const json = (await res.json()) as { quoteResponse?: { result?: YahooQuote[] } };
    const row = json.quoteResponse?.result?.find((r) => String(r.symbol).toUpperCase() === symbol) ?? null;
    return row;
  });
}

/** Several v7 quote rows in one request (the Dashboard's market strip; no cache here, the caller holds one). */
export async function yahooQuotes(symbols: readonly string[], signal?: AbortSignal): Promise<YahooQuote[]> {
  const res = await withCrumb(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(",")}&crumb={crumb}`, {}, signal);
  if (!res.ok) throw new Error(`Yahoo quote HTTP ${res.status}`);
  const json = (await res.json()) as { quoteResponse?: { result?: YahooQuote[] } };
  return json.quoteResponse?.result ?? [];
}

/* ------------------------------------------------------------------ chart */

export type ChartResult = {
  meta: Record<string, unknown> & {
    currentTradingPeriod?: { pre?: { start?: number; end?: number }; regular?: { start?: number; end?: number }; post?: { start?: number; end?: number } };
    gmtoffset?: number;
  };
  timestamp?: number[];
  indicators?: {
    quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }>;
    adjclose?: Array<{ adjclose?: (number | null)[] }>;
  };
};

const chartCache = new TtlCache<Promise<ChartResult | null>>(5 * 60_000, 200);

/** The v8 chart for a range ("1mo", "5y", ...) and interval ("1d", "1wk"); null for an unknown symbol. Cached 5 min. */
export function yahooChart(symbol: string, range: string, interval: string, signal?: AbortSignal): Promise<ChartResult | null> {
  return cached(chartCache, `${symbol}|${range}|${interval}`, async () => {
    const url =
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?range=${range}&interval=${interval}&events=div%2Csplits&includeAdjustedClose=true`;
    const res = await yahooFetcher.fetch(url, { headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/json" } }, signal);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Yahoo chart HTTP ${res.status}`);
    const json = (await res.json()) as { chart?: { result?: ChartResult[] | null } };
    return json.chart?.result?.[0] ?? null;
  });
}

/* ------------------------------------------------------------------ quoteSummary */

const summaryCache = new TtlCache<Promise<Record<string, unknown> | null>>(30 * 60_000, 200);

/** quoteSummary modules (e.g. "earnings,calendarEvents"); null for an unknown symbol. Cached 30 min. */
export function yahooSummary(symbol: string, modules: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  return cached(summaryCache, `${symbol}|${modules}`, async () => {
    const res = await withCrumb(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb={crumb}`, {}, signal);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Yahoo quoteSummary HTTP ${res.status}`);
    const json = (await res.json()) as { quoteSummary?: { result?: Record<string, unknown>[] } };
    return json.quoteSummary?.result?.[0] ?? null;
  });
}

/* ------------------------------------------------------------------ options chain */

/** One contract of Yahoo's v7 options chain (the fields the tools read; prices in dollars, times in epoch seconds). */
export type YahooOptionContract = {
  contractSymbol?: string;
  strike?: number;
  bid?: number;
  ask?: number;
  lastPrice?: number;
  lastTradeDate?: number;
  volume?: number;
  openInterest?: number;
  impliedVolatility?: number;
  expiration?: number;
};

export type YahooOptionChain = {
  underlyingSymbol?: string;
  expirationDates?: number[];
  quote?: YahooQuote;
  options?: Array<{ expirationDate?: number; calls?: YahooOptionContract[]; puts?: YahooOptionContract[] }>;
};

const optionsCache = new TtlCache<Promise<YahooOptionChain | null>>(60_000, 300);

/**
 * Yahoo's v7 options chain for one expiry (`expiry` in epoch seconds; omitted: the nearest one, with the list of
 * every expiry). Quotes are delayed about 15 minutes. Null when Yahoo has no options for the symbol. Cached 60 s.
 */
export function yahooOptions(symbol: string, expiry: number | null, signal?: AbortSignal): Promise<YahooOptionChain | null> {
  return cached(optionsCache, `${symbol}|${expiry ?? ""}`, async () => {
    const date = expiry !== null ? `&date=${expiry}` : "";
    const res = await withCrumb(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}?crumb={crumb}${date}`, {}, signal);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Yahoo options HTTP ${res.status}`);
    const json = (await res.json()) as { optionChain?: { result?: YahooOptionChain[] } };
    const r = json.optionChain?.result?.[0] ?? null;
    return r && Array.isArray(r.expirationDates) && r.expirationDates.length ? r : null;
  });
}

/* ------------------------------------------------------------------ earnings calendar archive */

const calendarCache = new TtlCache<Promise<unknown>>(12 * HOUR, 200);

/**
 * Yahoo's earnings calendar archive for one ticker (the `visualization`
 * endpoint; the same request as the backtester's YahooEarningsSource). Raw
 * JSON for `parseEarningsCalendar`. Cached 12 h.
 */
export function yahooEarningsCalendar(symbol: string, signal?: AbortSignal): Promise<unknown> {
  return cached(calendarCache, symbol, async () => {
    const body = {
      sortType: "DESC",
      entityIdType: "earnings",
      sortField: "startdatetime",
      includeFields: ["ticker", "eventname", "startdatetime", "startdatetimetype", "epsestimate", "epsactual", "epssurprisepct", "gmtOffsetMilliSeconds"],
      query: { operator: "and", operands: [{ operator: "eq", operands: ["ticker", symbol] }] },
      offset: 0,
      size: 40,
    };
    const res = await withCrumb(
      "https://query1.finance.yahoo.com/v1/finance/visualization?crumb={crumb}&lang=en-US&region=US",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      signal,
    );
    if (!res.ok) throw new Error(`Yahoo earnings calendar HTTP ${res.status}`);
    return res.json();
  });
}
