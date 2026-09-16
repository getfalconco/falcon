import { PROPAGATION_TIMEOUT_MS } from "./constants.js";
import type { EventDirection, PricedInStatus } from "./types.js";
import { withTimeout } from "./with-timeout.js";
import { finnhubApiBase } from "../finnhub.js";

export type PricedInResult = {
  price_change_pct: number | null;
  priced_in_status: PricedInStatus;
  /** Most recent close at signal-check time. */
  price_at_signal: number | null;
};

const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

type CandleSeries = { times: number[]; closes: number[] };

/**
 * Daily closes via Yahoo's keyless chart API. Fallback for Finnhub's
 * /stock/candle, which returns HTTP 403 on free plans — without this,
 * price_change_pct (and therefore priced_in_pct) stayed permanently null.
 */
async function fetchYahooDailyCloses(
  ticker: string,
  fromSec: number,
  toSec: number,
): Promise<CandleSeries | null> {
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(ticker)}?period1=${Math.floor(fromSec)}&period2=${Math.floor(toSec)}&interval=1d`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROPAGATION_TIMEOUT_MS);

  try {
    const res = await fetch(url, { headers: YAHOO_HEADERS, signal: controller.signal });
    if (!res.ok) {
      console.warn(`[propagation] Yahoo candle ${ticker}: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const result = data.chart?.result?.[0];
    const rawTimes = result?.timestamp ?? [];
    const rawCloses = result?.indicators?.quote?.[0]?.close ?? [];

    const times: number[] = [];
    const closes: number[] = [];
    for (let i = 0; i < rawTimes.length; i++) {
      const close = rawCloses[i];
      if (close == null || !Number.isFinite(close) || close <= 0) continue;
      times.push(rawTimes[i]!);
      closes.push(close);
    }
    if (closes.length === 0) return null;
    return { times, closes };
  } catch (err) {
    console.warn(
      `[propagation] Yahoo candle skip ${ticker}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCandle(
  ticker: string,
  eventUnixSec: number,
  token: string,
): Promise<{ changePct: number; firstClose: number; lastClose: number } | null> {
  const from = eventUnixSec - 86400;
  const to = Math.floor(Date.now() / 1000);
  const url = `${finnhubApiBase()}/stock/candle?symbol=${encodeURIComponent(ticker)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(token)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROPAGATION_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`[propagation] Finnhub candle ${ticker}: HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { s?: string; c?: number[] };
    if (data.s !== "ok" || !data.c?.length || data.c.length < 2) return null;

    const first = data.c[0]!;
    const last = data.c[data.c.length - 1]!;
    if (first === 0) return null;

    return { changePct: ((last - first) / first) * 100, firstClose: first, lastClose: last };
  } finally {
    clearTimeout(timer);
  }
}

export type LatestPrice = {
  price: number;
  /** Where the freshest print came from. */
  source: "yahoo-extended" | "finnhub-quote";
};

/**
 * Latest traded price INCLUDING pre/post-market sessions, via Yahoo's keyless
 * 1-minute chart with includePrePost. Critical for the priced-in check: an
 * event that lands after the close is often absorbed entirely in extended
 * trading — measuring against the stale regular-session close would call the
 * window "open" when the move has already happened.
 */
async function fetchYahooLatestExtended(
  ticker: string,
): Promise<{ price: number; at: number } | null> {
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(ticker)}?range=1d&interval=1m&includePrePost=true`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROPAGATION_TIMEOUT_MS);

  try {
    const res = await fetch(url, { headers: YAHOO_HEADERS, signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const result = data.chart?.result?.[0];
    const times = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    for (let i = times.length - 1; i >= 0; i--) {
      const close = closes[i];
      if (close != null && Number.isFinite(close) && close > 0) {
        return { price: close, at: times[i]! };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Freshest available price: Yahoo extended-hours print first (covers pre/post
 * sessions), Finnhub regular quote as fallback.
 */
export async function fetchLatestPrice(ticker: string): Promise<LatestPrice | null> {
  const extended = await fetchYahooLatestExtended(ticker);
  if (extended) {
    return { price: Math.round(extended.price * 100) / 100, source: "yahoo-extended" };
  }
  const quote = await fetchCurrentPrice(ticker);
  if (quote != null && quote > 0) {
    return { price: quote, source: "finnhub-quote" };
  }
  return null;
}

/** Pick the close whose timestamp is nearest to the target moment. */
function nearestClose(series: CandleSeries, aroundUnixSec: number): number | null {
  if (series.times.length === 0) return null;
  let bestIdx = 0;
  let bestDist = Math.abs(series.times[0]! - aroundUnixSec);
  for (let i = 1; i < series.times.length; i++) {
    const dist = Math.abs(series.times[i]! - aroundUnixSec);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  const px = series.closes[bestIdx]!;
  return px > 0 ? Math.round(px * 100) / 100 : null;
}

/** Close nearest to a historical unix timestamp (for backfilling price_at_signal). */
export async function fetchPriceNear(
  ticker: string,
  aroundUnixSec: number,
): Promise<number | null> {
  const from = aroundUnixSec - 3 * 86400;
  const to = aroundUnixSec + 3 * 86400;

  // Finnhub first (paid plans have the candle endpoint)…
  const token = process.env.FINNHUB_API_KEY?.trim();
  if (token) {
    const url = `${finnhubApiBase()}/stock/candle?symbol=${encodeURIComponent(ticker)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(token)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROPAGATION_TIMEOUT_MS);

    try {
      const res = await withTimeout(
        fetch(url, { signal: controller.signal }),
        PROPAGATION_TIMEOUT_MS,
        `candle-near ${ticker}`,
      );
      if (res.ok) {
        const data = (await res.json()) as { s?: string; c?: number[]; t?: number[] };
        if (data.s === "ok" && data.c?.length && data.t?.length) {
          const px = nearestClose({ times: data.t, closes: data.c }, aroundUnixSec);
          if (px != null) return px;
        }
      }
    } catch {
      // fall through to Yahoo
    } finally {
      clearTimeout(timer);
    }
  }

  // …Yahoo keyless fallback (Finnhub candle is 403 on free plans).
  const yahoo = await fetchYahooDailyCloses(ticker, from, to);
  if (!yahoo) return null;
  return nearestClose(yahoo, aroundUnixSec);
}

/** Current last price via Finnhub quote (for outcome tracking). */
export async function fetchCurrentPrice(ticker: string): Promise<number | null> {
  const token = process.env.FINNHUB_API_KEY?.trim();
  if (!token) return null;

  const url = `${finnhubApiBase()}/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROPAGATION_TIMEOUT_MS);

  try {
    const res = await withTimeout(
      fetch(url, { signal: controller.signal }),
      PROPAGATION_TIMEOUT_MS,
      `quote ${ticker}`,
    );
    if (!res.ok) {
      console.warn(`[propagation] Finnhub quote ${ticker}: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { c?: number };
    const price = typeof data.c === "number" && data.c > 0 ? data.c : null;
    return price;
  } catch (err) {
    console.warn(
      `[propagation] quote skip ${ticker}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkPricedIn(
  ticker: string,
  eventUnixSec: number,
  signalDirection: EventDirection,
): Promise<PricedInResult> {
  const token = process.env.FINNHUB_API_KEY?.trim();
  if (!token) {
    console.warn(`[propagation] price fetch ${ticker}: FINNHUB_API_KEY missing`);
    return { price_change_pct: null, priced_in_status: "not yet reflected", price_at_signal: null };
  }

  try {
    // Always fetch BOTH at signal-creation time: the candle series (for the
    // change since the event) and the freshest print (for price_at_signal).
    // The latest price INCLUDES pre/post-market sessions — an after-hours move
    // that already absorbed the news must count toward "already moved".
    const [result, latest] = await Promise.all([
      withTimeout(
        fetchCandle(ticker, eventUnixSec, token),
        PROPAGATION_TIMEOUT_MS,
        `price ${ticker}`,
      ).catch((err) => {
        console.warn(
          `[propagation] candle fetch skip ${ticker}:`,
          err instanceof Error ? err.message : err,
        );
        return null;
      }),
      fetchLatestPrice(ticker),
    ]);
    const liveQuote = latest?.price ?? null;

    // Candle series for "change since the event": Finnhub first (paid plans),
    // then Yahoo's keyless chart API — Finnhub /stock/candle is 403 on free
    // plans, which otherwise leaves price_change_pct/priced_in_pct null.
    let firstClose: number | null = result?.firstClose ?? null;
    let lastCandleClose: number | null = result?.lastClose ?? null;
    let candleSource = result ? "finnhub" : "none";
    if (firstClose == null) {
      const yahoo = await fetchYahooDailyCloses(
        ticker,
        eventUnixSec - 86400,
        Math.floor(Date.now() / 1000),
      );
      if (yahoo) {
        firstClose = yahoo.closes[0]!;
        lastCandleClose = yahoo.closes[yahoo.closes.length - 1]!;
        candleSource = "yahoo";
      }
    }

    const fetchedAt = new Date().toISOString();
    console.info(
      `[propagation] price ${ticker}: quote=${liveQuote ?? "n/a"} candle_first=${firstClose ?? "n/a"} candle_last=${lastCandleClose ?? "n/a"} candle_source=${candleSource} price_source=${latest?.source ?? (lastCandleClose != null ? "candle-close" : "none")} at=${fetchedAt}`,
    );

    const priceAtSignal =
      liveQuote != null && liveQuote > 0
        ? Math.round(liveQuote * 100) / 100
        : lastCandleClose != null
          ? Math.round(lastCandleClose * 100) / 100
          : null;

    if (firstClose == null || firstClose <= 0) {
      return {
        price_change_pct: null,
        priced_in_status: "not yet reflected",
        price_at_signal: priceAtSignal,
      };
    }

    // Change since the event: candle first close → freshest price we have.
    const endPrice = liveQuote != null && liveQuote > 0 ? liveQuote : lastCandleClose!;
    const changePct = Math.round(((endPrice - firstClose) / firstClose) * 100 * 100) / 100;

    let priced_in_status: PricedInStatus = "not yet reflected";
    if (signalDirection === "positive" && changePct > 2) priced_in_status = "likely priced in";
    if (signalDirection === "negative" && changePct < -2) priced_in_status = "likely priced in";

    return {
      price_change_pct: changePct,
      priced_in_status,
      price_at_signal: priceAtSignal,
    };
  } catch (err) {
    console.warn(
      `[propagation] price fetch skip ${ticker}:`,
      err instanceof Error ? err.message : err,
    );
    return { price_change_pct: null, priced_in_status: "not yet reflected", price_at_signal: null };
  }
}
