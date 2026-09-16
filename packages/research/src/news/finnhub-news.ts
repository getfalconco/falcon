import { finnhubApiBase } from "../finnhub.js";

export type FinnhubNewsArticle = {
  id: number;
  datetime: number;
  headline: string;
  summary: string;
  url: string;
  source: string;
  category?: string;
};

export type FinnhubFetchResult =
  | { ok: true; articles: FinnhubNewsArticle[] }
  | { ok: false; error: string; status?: number };

const FETCH_TIMEOUT_MS = 10_000;

function ymdFromDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function fetchFinnhubCompanyNews(
  symbol: string,
  fromYmd: string,
  toYmd: string,
): Promise<FinnhubFetchResult> {
  const token = process.env.FINNHUB_API_KEY?.trim();
  if (!token) {
    console.warn(`[events] Finnhub ${symbol}: skipped — FINNHUB_API_KEY not set`);
    return { ok: false, error: "FINNHUB_API_KEY not configured" };
  }

  const endpoint = `${finnhubApiBase()}/company-news?symbol=${encodeURIComponent(symbol)}&from=${fromYmd}&to=${toYmd}`;
  const url = `${endpoint}&token=${encodeURIComponent(token)}`;
  const safeLogUrl = `${endpoint}&token=***`;

  console.info(`[events] Finnhub GET ${symbol} ${fromYmd}→${toYmd} ${safeLogUrl}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    console.info(`[events] Finnhub ${symbol}: HTTP ${res.status}`);

    if (res.status === 401) {
      return { ok: false, error: "Finnhub 401 — invalid FINNHUB_API_KEY", status: 401 };
    }
    if (res.status === 429) {
      return { ok: false, error: "Finnhub 429 — rate limit exceeded", status: 429 };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Finnhub HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`,
        status: res.status,
      };
    }

    const data = (await res.json()) as FinnhubNewsArticle[];
    const articles = Array.isArray(data) ? data : [];
    return { ok: true, articles };
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `Finnhub timeout after ${FETCH_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn(`[events] Finnhub ${symbol}: ${message}`);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export function newsWindowDates(): { fromYmd: string; toYmd: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 3);
  return { fromYmd: ymdFromDate(from), toYmd: ymdFromDate(to) };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
