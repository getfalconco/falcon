/**
 * `quote(ticker)`: last price, the day's change, volume, previous close,
 * market state and time. Databento's end-of-day close first (Supabase
 * prices_daily); when the ticker has none, Yahoo's v7 quote (it has the market state and
 * extended-hours prices); the v8 chart's summary when the quote endpoint
 * cannot be read.
 */

import { yahooChart, yahooQuote, type ChartResult, type YahooQuote } from "./yahoo";
import { ToolError, num, nyStamp, round, type DeskToolContext } from "./util";
import { DATABENTO_LABEL, databentoBars, databentoLatest } from "./databento";

const MARKET_STATES: Record<string, string> = {
  PRE: "pre-market",
  PREPRE: "closed (overnight)",
  REGULAR: "open",
  POST: "after-hours",
  POSTPOST: "closed (overnight)",
  CLOSED: "closed",
};

const at = (sec: number | null) => (sec === null ? null : nyStamp(sec * 1000));

/** The tool's answer from a v7 quote row. Pure. */
export function quoteFromYahoo(q: YahooQuote) {
  const s = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : null);
  const n = (k: string) => num(q[k]);
  const state = s("marketState");
  const out: Record<string, unknown> = {
    ticker: s("symbol"),
    name: s("longName") ?? s("shortName"),
    exchange: s("fullExchangeName") ?? s("exchange"),
    currency: s("currency"),
    price: round(n("regularMarketPrice"), 4),
    change: round(n("regularMarketChange"), 4),
    changePct: round(n("regularMarketChangePercent"), 2),
    previousClose: round(n("regularMarketPreviousClose"), 4),
    open: round(n("regularMarketOpen"), 4),
    dayHigh: round(n("regularMarketDayHigh"), 4),
    dayLow: round(n("regularMarketDayLow"), 4),
    volume: n("regularMarketVolume"),
    avgVolume3m: n("averageDailyVolume3Month"),
    fiftyTwoWeekHigh: round(n("fiftyTwoWeekHigh"), 4),
    fiftyTwoWeekLow: round(n("fiftyTwoWeekLow"), 4),
    marketCap: n("marketCap"),
    marketState: state ? (MARKET_STATES[state] ?? state.toLowerCase()) : null,
    priceTime: at(n("regularMarketTime")),
  };
  const post = n("postMarketPrice");
  const pre = n("preMarketPrice");
  if (post !== null && (state === "POST" || state === "POSTPOST" || state === "CLOSED" || state === "PREPRE")) {
    out.afterHours = { price: round(post, 4), changePct: round(n("postMarketChangePercent"), 2), time: at(n("postMarketTime")) };
  }
  if (pre !== null && (state === "PRE" || state === "PREPRE")) {
    out.preMarket = { price: round(pre, 4), changePct: round(n("preMarketChangePercent"), 2), time: at(n("preMarketTime")) };
  }
  const delay = n("exchangeDataDelayedBy");
  out.source = `Yahoo Finance quote${delay ? ` (exchange data may be delayed up to ${delay} min)` : ""}`;
  return out;
}

/** The tool's answer from a 1-day chart's summary (fallback when the quote endpoint fails). Pure. */
export function quoteFromChart(symbol: string, c: ChartResult, nowSec = Date.now() / 1000) {
  const m = c.meta;
  const n = (k: string) => num(m[k]);
  const s = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : null);
  const price = n("regularMarketPrice");
  // With range=1d, chartPreviousClose is the previous session's close.
  const previousClose = n("chartPreviousClose") ?? n("previousClose");
  const regular = m.currentTradingPeriod?.regular;
  const open = regular?.start !== undefined && regular?.end !== undefined && nowSec >= regular.start && nowSec < regular.end;
  const change = price !== null && previousClose !== null ? price - previousClose : null;
  return {
    ticker: symbol,
    name: s("longName") ?? s("shortName"),
    exchange: s("fullExchangeName") ?? s("exchangeName"),
    currency: s("currency"),
    price: round(price, 4),
    change: round(change, 4),
    changePct: change !== null && previousClose ? round((change / previousClose) * 100, 2) : null,
    previousClose: round(previousClose, 4),
    dayHigh: round(n("regularMarketDayHigh"), 4),
    dayLow: round(n("regularMarketDayLow"), 4),
    volume: n("regularMarketVolume"),
    fiftyTwoWeekHigh: round(n("fiftyTwoWeekHigh"), 4),
    fiftyTwoWeekLow: round(n("fiftyTwoWeekLow"), 4),
    marketState: open ? "open" : "closed or extended hours",
    priceTime: at(n("regularMarketTime")),
    source: "Yahoo Finance chart summary (quote endpoint unavailable)",
  };
}

/** The 52-week high/low from Databento's last year of bars (intraday extremes), or nulls. */
async function yearRange(symbol: string) {
  const h = await databentoBars(symbol, "1y");
  if (!h) return { fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null };
  return { fiftyTwoWeekHigh: round(Math.max(...h.bars.map((b) => b[2])), 4), fiftyTwoWeekLow: round(Math.min(...h.bars.map((b) => b[3])), 4) };
}

export async function quoteTool(symbol: string, _ctx: DeskToolContext, signal: AbortSignal) {
  const d = await databentoLatest(symbol);
  if (d) {
    return {
      ticker: symbol,
      currency: "USD",
      price: d.close,
      change: d.change,
      changePct: d.changePct,
      previousClose: d.prevClose,
      previousCloseDate: d.prevDate,
      open: d.open,
      dayHigh: d.high,
      dayLow: d.low,
      volume: d.volume,
      ...(await yearRange(symbol)),
      date: d.date,
      marketState: "end-of-day close (not a live price)",
      source: `${DATABENTO_LABEL}, as of ${d.date}. Split-adjusted; 52-week range from daily highs and lows.`,
    };
  }
  try {
    const q = await yahooQuote(symbol, signal);
    if (q && num(q.regularMarketPrice) !== null) {
      const out = quoteFromYahoo(q);
      const type = typeof q.quoteType === "string" ? q.quoteType : null;
      if (type && type !== "EQUITY") out.instrumentType = type;
      return out;
    }
  } catch (err) {
    if (signal.aborted) throw err;
    // Fall through to the chart summary.
  }
  const chart = await yahooChart(symbol, "1d", "1d", signal);
  if (!chart || num(chart.meta.regularMarketPrice) === null) throw new ToolError(`No quote found for ${symbol}. Check the ticker (US listings only).`);
  return quoteFromChart(symbol, chart);
}
