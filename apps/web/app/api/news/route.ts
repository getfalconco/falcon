import { NextResponse } from "next/server";
import type pg from "pg";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { createNewsPool, readNews } from "@/lib/news/store";

export const dynamic = "force-dynamic";

/**
 * Temporary: company news for every US-listed company, to test pulling news
 * into Falcon.
 *
 *   GET /api/news[?symbol=AAPL][&limit=200][&before=ISO]
 *     ->  200 { items: NewsItem[], nextBefore, fetchedAt }
 *     ->  400 { error } on a bad symbol or time
 *     ->  503 { error } when DATABASE_URL is not set or the table cannot be read
 *
 * Reads public.news_items, which the news sweeper fills from Finnhub's
 * company news (lib/news/store.ts, netlify/functions/news-sweep.mts). Newest
 * first; `before` is the previous page's nextBefore.
 */

export type NewsItem = {
  id: number;
  category: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  image: string;
  /** Tickers the article was listed under. */
  related: string[];
  /** ISO time the story was published. */
  datetime: string;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

let pool: pg.Pool | null = null;

export async function GET(request: Request) {
  const limited = rateLimit(`news:${clientIp(request)}`, { limit: 60, windowMs: 60_000 });
  if (!limited.ok) return tooManyRequests(limited.retryAfter);

  const noStore = { "Cache-Control": "no-store" };
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: "DATABASE_URL is not set" }, { status: 503, headers: noStore });

  const params = new URL(request.url).searchParams;
  const symbol = (params.get("symbol") ?? "").trim().toUpperCase();
  if (symbol && !/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(symbol)) return NextResponse.json({ error: "Bad symbol" }, { status: 400, headers: noStore });
  const before = params.get("before") ?? "";
  if (before && Number.isNaN(Date.parse(before))) return NextResponse.json({ error: "Bad before time" }, { status: 400, headers: noStore });
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(params.get("limit")) || DEFAULT_LIMIT)));

  pool ??= createNewsPool(url, 2);
  let rows;
  try {
    rows = await readNews(pool, { symbol: symbol || undefined, limit, before: before ? new Date(before).toISOString() : undefined });
  } catch {
    return NextResponse.json({ error: "Could not read news" }, { status: 503, headers: noStore });
  }

  const items: NewsItem[] = rows.map((r) => ({
    id: r.id,
    category: r.category,
    headline: r.headline,
    summary: r.summary,
    source: r.source,
    url: r.url,
    image: r.image,
    related: r.symbols,
    datetime: r.publishedAt,
  }));

  return NextResponse.json(
    { items, nextBefore: items.length === limit ? items[items.length - 1].datetime : null, fetchedAt: new Date().toISOString() },
    { headers: { "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=120" } },
  );
}
