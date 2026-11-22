import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Temporary: market news from Finnhub, to test pulling news into Falcon.
 *
 *   GET /api/news  ->  200 { items: NewsItem[], fetchedAt }
 *                  ->  503 { error } when FINNHUB_API_KEY is not set
 *
 * Reads Finnhub's general and merger news (all companies) with the server-only
 * FINNHUB_API_KEY; the key never reaches the browser. Cached for 90 seconds.
 */

export type NewsItem = {
  id: number;
  category: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  image: string;
  related: string[];
  /** ISO time the story was published. */
  datetime: string;
};

type FinnhubNews = {
  id?: number;
  category?: string;
  datetime?: number;
  headline?: string;
  image?: string;
  related?: string;
  source?: string;
  summary?: string;
  url?: string;
};

const CATEGORIES = ["general", "merger"] as const;
const REVALIDATE = 90;

async function fetchCategory(category: string, key: string): Promise<FinnhubNews[]> {
  const res = await fetch(`https://finnhub.io/api/v1/news?category=${category}`, {
    headers: { "X-Finnhub-Token": key },
    next: { revalidate: REVALIDATE },
  });
  if (!res.ok) throw new Error(`Finnhub ${category} news: HTTP ${res.status}`);
  const body: unknown = await res.json();
  return Array.isArray(body) ? (body as FinnhubNews[]) : [];
}

function toItem(n: FinnhubNews): NewsItem | null {
  if (!n.headline || !n.url || typeof n.datetime !== "number") return null;
  return {
    id: n.id ?? 0,
    category: n.category ?? "",
    headline: n.headline,
    summary: n.summary ?? "",
    source: n.source ?? "",
    url: n.url,
    image: n.image ?? "",
    related: (n.related ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    datetime: new Date(n.datetime * 1000).toISOString(),
  };
}

export async function GET(request: Request) {
  const limit = rateLimit(`news:${clientIp(request)}`, { limit: 60, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);

  const key = process.env.FINNHUB_API_KEY?.trim();
  if (!key) {
    return NextResponse.json({ error: "FINNHUB_API_KEY is not set" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const results = await Promise.allSettled(CATEGORIES.map((c) => fetchCategory(c, key)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length === results.length) {
    return NextResponse.json({ error: String(failed[0].reason instanceof Error ? failed[0].reason.message : failed[0].reason) }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  const seen = new Set<string>();
  const items: NewsItem[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const raw of r.value) {
      const item = toItem(raw);
      if (!item || seen.has(item.url)) continue;
      seen.add(item.url);
      items.push(item);
    }
  }
  items.sort((a, b) => Date.parse(b.datetime) - Date.parse(a.datetime));

  return NextResponse.json(
    { items, fetchedAt: new Date().toISOString() },
    { headers: { "Cache-Control": `public, max-age=60, s-maxage=${REVALIDATE}, stale-while-revalidate=300` } },
  );
}
