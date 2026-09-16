/**
 * Tracker inbound data sources (§1, §2, §6):
 *  - Yahoo v8 chart: split/dividend-adjusted daily bars + volume, and quotes
 *    (extended-hours aware). One bar fetch per ticker per day, cached upstream.
 *  - Finnhub: company news (date-range) + earnings calendar.
 *  - SEC EDGAR: submissions API (filing history, Form 4 detection) with a
 *    descriptive User-Agent and polite spacing handled by the engine.
 */

import { classifySession, nyYmd } from "./calendar.js";
import type { SessionKind } from "./calendar.js";
import type { DailyBar, EarningsRecord, FilingRecord } from "./types.js";
import { finnhubApiBase } from "../finnhub.js";

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SEC_UA =
  process.env.SEC_EDGAR_USER_AGENT?.trim() ||
  "Meridian Falcon Tracker research@getfalcon.co";
const FETCH_TIMEOUT_MS = 15_000;

/** Every outbound request goes through an abort timer — an unbounded fetch
 * here stalls the whole sequential backfill queue behind it. */
async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetchWithTimeout(url, headers);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split("?")[0]}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Yahoo — adjusted daily bars + volume
// ---------------------------------------------------------------------------

type YahooChart = {
  chart?: {
    result?: Array<{
      meta?: { regularMarketPrice?: number; chartPreviousClose?: number };
      timestamp?: number[];
      events?: { splits?: Record<string, { date: number }> };
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
        adjclose?: Array<{ adjclose?: Array<number | null> }>;
      };
    }>;
    error?: { description?: string } | null;
  };
};

export type AdjustedBarsResult = {
  bars: DailyBar[];
  /** Most recent split date within the range, "YYYY-MM-DD" (volume-baseline guard §6). */
  latestSplitDate: string | null;
};

/**
 * Trailing adjusted daily bars. Closes use adjclose; O/H/L are scaled by the
 * same adjustment factor so overnight gaps stay artifact-free across splits
 * and dividends. Yahoo's volume series is split-adjusted at source.
 */
export async function fetchAdjustedDailyBars(
  symbol: string,
  lookbackCalendarDays: number,
): Promise<AdjustedBarsResult> {
  const period2 = Math.floor(Date.now() / 1000) + 86_400;
  const period1 = period2 - lookbackCalendarDays * 86_400;
  const url =
    `${YAHOO_BASE}/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}` +
    `&interval=1d&events=div%7Csplit&includePrePost=false`;
  const data = await fetchJson<YahooChart>(url, { "User-Agent": BROWSER_UA });
  const result = data.chart?.result?.[0];
  if (!result) throw new Error(data.chart?.error?.description ?? `Yahoo: empty chart for ${symbol}`);

  const ts = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0];
  const adj = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const bars: DailyBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = quote?.close?.[i];
    const adjClose = adj[i] ?? close;
    if (
      ts[i] == null ||
      close == null ||
      adjClose == null ||
      !Number.isFinite(close) ||
      !Number.isFinite(adjClose) ||
      close === 0
    ) {
      continue;
    }
    const factor = adjClose / close;
    const open = quote?.open?.[i];
    const high = quote?.high?.[i];
    const low = quote?.low?.[i];
    const volume = quote?.volume?.[i];
    bars.push({
      d: nyYmd(new Date(ts[i] * 1000)),
      o: open != null && Number.isFinite(open) ? open * factor : adjClose,
      h: high != null && Number.isFinite(high) ? high * factor : adjClose,
      l: low != null && Number.isFinite(low) ? low * factor : adjClose,
      c: adjClose,
      v: volume != null && Number.isFinite(volume) ? volume : 0,
    });
  }

  let latestSplitDate: string | null = null;
  const splits = result.events?.splits ?? {};
  for (const key of Object.keys(splits)) {
    const date = splits[key]?.date;
    if (date == null) continue;
    const ymdStr = nyYmd(new Date(date * 1000));
    if (latestSplitDate == null || ymdStr > latestSplitDate) latestSplitDate = ymdStr;
  }
  return { bars, latestSplitDate };
}

// ---------------------------------------------------------------------------
// Yahoo — quotes (extended-hours aware)
// ---------------------------------------------------------------------------

export type QuoteSnapshot = {
  price: number;
  prevClose: number | null;
  asof: string; // ISO UTC
  session: SessionKind;
  /** Cumulative intraday share volume so far today (partial before close). */
  intradayVolume: number | null;
};

/** One minute print: epoch ms and the close of that minute. */
export type IntradayPrint = { t: number; c: number };

export type IntradaySeries = {
  symbol: string;
  prints: IntradayPrint[];
  prevClose: number | null;
  /** Cumulative share volume across the returned window. */
  volume: number | null;
};

/**
 * The 1-minute series behind a quote, kept rather than collapsed. The same
 * call already downloads it; propagation needs the prints to anchor a pricing
 * reference on the instant an event landed instead of the previous close.
 *
 * `range` is Yahoo's own vocabulary — "1d" for today, "5d" to reach back
 * across a session boundary (an after-close release measured the next day).
 */
export async function fetchIntradaySeries(
  symbol: string,
  options: { range?: "1d" | "5d" } = {},
): Promise<IntradaySeries> {
  const range = options.range ?? "1d";
  const url =
    `${YAHOO_BASE}/${encodeURIComponent(symbol)}?range=${range}&interval=1m&includePrePost=true`;
  const data = await fetchJson<YahooChart>(url, { "User-Agent": BROWSER_UA });
  const result = data.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo: empty quote chart for ${symbol}`);

  const ts = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const volumes = result.indicators?.quote?.[0]?.volume ?? [];
  const prints: IntradayPrint[] = [];
  let volume = 0;
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    const v = volumes[i];
    if (v != null && Number.isFinite(v)) volume += v;
    if (c != null && Number.isFinite(c) && ts[i] != null) prints.push({ t: ts[i] * 1000, c });
  }
  return {
    symbol,
    prints,
    prevClose: result.meta?.chartPreviousClose ?? null,
    volume: volume > 0 ? volume : null,
    ...(prints.length === 0 && result.meta?.regularMarketPrice != null
      ? { prints: [{ t: Date.now(), c: result.meta.regularMarketPrice }] }
      : {}),
  };
}

/**
 * Fresh quote via a 1-minute chart with pre/post included — the last valid
 * print is the extended-hours price when outside the regular session (§3.5).
 */
export async function fetchQuote(symbol: string): Promise<QuoteSnapshot> {
  const series = await fetchIntradaySeries(symbol);
  const last = series.prints[series.prints.length - 1];
  if (!last) throw new Error(`Yahoo: no prints for ${symbol}`);
  const asofDate = new Date(last.t);
  return {
    price: last.c,
    prevClose: series.prevClose,
    asof: asofDate.toISOString(),
    session: classifySession(asofDate).session,
    intradayVolume: series.volume,
  };
}

// ---------------------------------------------------------------------------
// Finnhub — company news + earnings calendar
// ---------------------------------------------------------------------------

export type FinnhubArticle = {
  id: number;
  datetime: number; // unix seconds
  headline: string;
  summary: string;
  url: string;
  source: string;
};

export class FinnhubRateLimitError extends Error {
  constructor() {
    super("Finnhub 429 — rate limit exceeded");
  }
}

function finnhubToken(): string {
  const token = process.env.FINNHUB_API_KEY?.trim();
  if (!token) throw new Error("FINNHUB_API_KEY not configured");
  return token;
}

export async function fetchCompanyNews(
  symbol: string,
  fromYmd: string,
  toYmd: string,
): Promise<FinnhubArticle[]> {
  const url =
    `${finnhubApiBase()}/company-news?symbol=${encodeURIComponent(symbol)}` +
    `&from=${fromYmd}&to=${toYmd}&token=${encodeURIComponent(finnhubToken())}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 429) throw new FinnhubRateLimitError();
    if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
    const data = (await res.json()) as FinnhubArticle[];
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}

export type EarningsCalendarEntry = {
  date: string; // "YYYY-MM-DD"
  hour: string | null; // "bmo" | "amc" | "dmh" | ""
  quarter: number | null;
  year: number | null;
};

export async function fetchEarningsCalendar(
  symbol: string,
  fromYmd: string,
  toYmd: string,
): Promise<EarningsCalendarEntry[]> {
  const url =
    `${finnhubApiBase()}/calendar/earnings?from=${fromYmd}&to=${toYmd}` +
    `&symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(finnhubToken())}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 429) throw new FinnhubRateLimitError();
    if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
    const data = (await res.json()) as {
      earningsCalendar?: Array<{
        date?: string;
        hour?: string;
        quarter?: number;
        year?: number;
      }>;
    };
    return (data.earningsCalendar ?? [])
      .filter((e) => typeof e.date === "string")
      .map((e) => ({
        date: e.date as string,
        hour: e.hour || null,
        quarter: e.quarter ?? null,
        year: e.year ?? null,
      }));
  } finally {
    clearTimeout(timer);
  }
}

export function fiscalPeriodLabel(entry: EarningsCalendarEntry): string {
  if (entry.quarter != null && entry.year != null) return `Q${entry.quarter} ${entry.year}`;
  return "unknown";
}

export function earningsRecordFromEntry(entry: EarningsCalendarEntry): EarningsRecord {
  return { date: entry.date, fiscalPeriod: fiscalPeriodLabel(entry), hour: entry.hour };
}

// ---------------------------------------------------------------------------
// SEC EDGAR — submissions + Form 4 documents
// ---------------------------------------------------------------------------

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
let cikCache: Record<string, string> | null = null;

export async function resolveCikCached(symbol: string): Promise<string | null> {
  if (!cikCache) {
    const data = await fetchJson<Record<string, { cik_str: number; ticker: string }>>(
      TICKERS_URL,
      { "User-Agent": SEC_UA, Accept: "application/json" },
    );
    cikCache = {};
    for (const entry of Object.values(data)) {
      cikCache[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, "0");
    }
  }
  return cikCache[symbol.toUpperCase()] ?? null;
}

export type SubmissionsResult = { filings: FilingRecord[] };

const TRACKED_FORMS = new Set(["8-K", "10-Q", "10-K", "4"]);

/**
 * Full filing history in one call (§1) — including 8-K item codes and the
 * acceptance timestamp, both carried by the submissions index itself, so no
 * per-filing follow-up request is needed.
 */
export async function fetchSubmissions(cik: string): Promise<SubmissionsResult> {
  const data = await fetchJson<{
    filings?: {
      recent?: {
        form?: string[];
        filingDate?: string[];
        reportDate?: string[];
        acceptanceDateTime?: string[];
        items?: string[];
        accessionNumber?: string[];
        primaryDocument?: string[];
      };
    };
  }>(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    "User-Agent": SEC_UA,
    Accept: "application/json",
  });

  const recent = data.filings?.recent;
  const filings: FilingRecord[] = [];
  if (recent?.form) {
    for (let i = 0; i < recent.form.length; i++) {
      const form = recent.form[i];
      if (!form || !TRACKED_FORMS.has(form)) continue;
      const rawItems = recent.items?.[i] ?? "";
      filings.push({
        form,
        accessionNumber: recent.accessionNumber?.[i] ?? "",
        filedAt: recent.filingDate?.[i] ?? "",
        acceptedAt: recent.acceptanceDateTime?.[i] || null,
        reportDate: recent.reportDate?.[i] || null,
        items: rawItems
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        primaryDocument: recent.primaryDocument?.[i] ?? null,
      });
    }
  }
  return { filings };
}

/** 8-K item code for "Results of Operations and Financial Condition". */
export const EARNINGS_RELEASE_ITEM = "2.02";

export function isEarningsRelease(filing: FilingRecord): boolean {
  return filing.form === "8-K" && filing.items.includes(EARNINGS_RELEASE_ITEM);
}

export function filingArchiveUrl(cik: string, filing: FilingRecord): string {
  const accession = filing.accessionNumber.replace(/-/g, "");
  const cikNum = cik.replace(/^0+/, "");
  const doc = filing.primaryDocument ?? "";
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accession}/${doc}`;
}

export type Form4Details = {
  insiderName: string;
  role: string;
  transactionCode: string;
  is10b51Plan: boolean;
  shares: number | null;
  value: number | null;
  direction: "buy" | "sell" | null;
  /**
   * The trade's execution date ("YYYY-MM-DD") from the ownership XML. A Form 4
   * may be filed up to two business days later, so time-window logic (the
   * cluster detector) must anchor on this, not the filing date. Null when the
   * XML carries no parseable date.
   */
  transactionDate: string | null;
};

/**
 * Parse a Form 4 ownership XML: insider identity, first open-market
 * transaction code, A/D direction, and the Rule 10b5-1 plan checkbox (§2.2).
 */
export async function fetchForm4Details(
  cik: string,
  filing: FilingRecord,
): Promise<Form4Details | null> {
  const doc = filing.primaryDocument;
  if (!doc) return null;
  // Strip an XSL-rendering prefix ("xslF345X05/foo.xml" → "foo.xml") for raw XML.
  const rawDoc = doc.includes("/") ? doc.slice(doc.lastIndexOf("/") + 1) : doc;
  const accession = filing.accessionNumber.replace(/-/g, "");
  const cikNum = cik.replace(/^0+/, "");
  const url = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accession}/${rawDoc}`;

  let xml: string;
  try {
    const res = await fetchWithTimeout(url, { "User-Agent": SEC_UA });
    if (!res.ok) return null;
    xml = await res.text();
  } catch {
    return null;
  }

  const tag = (name: string): string | null => {
    const m = xml.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i"));
    return m ? m[1].trim() : null;
  };
  const nestedValue = (name: string): string | null => {
    const m = xml.match(
      new RegExp(`<${name}>[\\s\\S]*?<value>\\s*([^<]*?)\\s*</value>[\\s\\S]*?</${name}>`, "i"),
    );
    return m ? m[1].trim() : null;
  };

  const insiderName = tag("rptOwnerName") ?? "unknown";
  const isDirector = tag("isDirector") === "1" || tag("isDirector")?.toLowerCase() === "true";
  const isOfficer = tag("isOfficer") === "1" || tag("isOfficer")?.toLowerCase() === "true";
  const officerTitle = tag("officerTitle");
  const isTenPct =
    tag("isTenPercentOwner") === "1" || tag("isTenPercentOwner")?.toLowerCase() === "true";
  const role =
    officerTitle || (isOfficer ? "officer" : isDirector ? "director" : isTenPct ? "10% owner" : "insider");

  const aff = tag("aff10b5One");
  const is10b51Plan = aff === "1" || aff?.toLowerCase() === "true";

  // First non-derivative transaction drives code/direction/size.
  const txnMatch = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/i);
  const txnXml = txnMatch ? txnMatch[0] : xml;
  const codeMatch = txnXml.match(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/i);
  const transactionCode = codeMatch ? codeMatch[1].toUpperCase() : "";
  const inTxn = (name: string): string | null => {
    const m = txnXml.match(
      new RegExp(`<${name}>[\\s\\S]*?<value>\\s*([^<]*?)\\s*</value>[\\s\\S]*?</${name}>`, "i"),
    );
    return m ? m[1].trim() : null;
  };
  const txnDateRaw = inTxn("transactionDate");
  const transactionDate =
    txnDateRaw != null && /^d{4}-d{2}-d{2}/.test(txnDateRaw)
      ? txnDateRaw.slice(0, 10)
      : null;
  const sharesRaw = inTxn("transactionShares");
  const priceRaw = inTxn("transactionPricePerShare");
  const adRaw = inTxn("transactionAcquiredDisposedCode") ?? nestedValue("transactionAcquiredDisposedCode");
  const shares = sharesRaw != null && Number.isFinite(Number(sharesRaw)) ? Number(sharesRaw) : null;
  const price = priceRaw != null && Number.isFinite(Number(priceRaw)) ? Number(priceRaw) : null;

  const direction: "buy" | "sell" | null =
    adRaw === "A" ? "buy" : adRaw === "D" ? "sell" : null;

  return {
    insiderName,
    role,
    transactionCode,
    transactionDate,
    is10b51Plan: Boolean(is10b51Plan),
    shares,
    value: shares != null && price != null ? shares * price : null,
    direction,
  };
}

/**
 * Open-market insider activity only (§5.8): transaction codes P (purchase) and
 * S (sale), excluding anything executed under a Rule 10b5-1 plan. Grants (A),
 * option exercises (M), tax withholding (F) and gifts (G) carry no directional
 * signal — an award vesting is not someone choosing to buy.
 *
 * Applied at ingest so the stored series holds only what the detector may
 * count; screening this out only inside the detector left grants and gifts
 * sitting in the persisted state, mislabelled with a buy/sell direction.
 */
export function isOpenMarketInsiderTxn(details: {
  transactionCode: string;
  is10b51Plan: boolean;
}): boolean {
  if (details.is10b51Plan) return false;
  const code = details.transactionCode.toUpperCase();
  return code === "P" || code === "S";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
