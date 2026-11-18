import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { logoSources, logoSymbol } from "@/lib/logo";

export const dynamic = "force-dynamic";

/**
 * A company's (or a coin's) logo, served from Falcon's own host so the
 * browser never asks a third party for the member's tickers (which would
 * leak their holdings and IP address). Sources and their terms: lib/logo.ts.
 *
 *   GET /api/logo/AAPL              -> 200 image/png in brand colours, cached a week
 *   GET /api/logo/AAPL?style=mono   -> 200 image/png, a light mark the UI draws as a silhouette
 *   GET /api/logo/BTC?kind=crypto   -> 200 image/png
 *   404 when no source has it (the UI falls back to a monogram), 400 bad symbol, 429 rate limited
 *
 * Held in memory per server instance, up to MAX_ENTRIES: hits a week, misses
 * (every source said no) 12 hours, failures (a timeout, a 5xx) 5 minutes.
 */

const MAX_ENTRIES = 600;
const MAX_BYTES = 256 * 1024;
const HIT_TTL_MS = 7 * 24 * 3_600_000;
const MISS_TTL_MS = 12 * 3_600_000;
const FAIL_TTL_MS = 5 * 60_000;
// FMP's logo host can take several seconds on a first read.
const TIMEOUT_MS = 20_000;

type Entry = { at: number; body: ArrayBuffer | null; type: string; failed?: boolean };
const cache = new Map<string, Entry>();

function remember(key: string, entry: Entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
}

/** One source: the image, "miss" when it has none, "failed" when it did not answer (tried again sooner). */
async function fetchLogo(url: string): Promise<{ body: ArrayBuffer; type: string } | "miss" | "failed"> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store", headers: { Accept: "image/png,image/*" } });
    if (res.status >= 500 || res.status === 429) return "failed";
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(png|jpeg|webp)/.test(type)) return "miss";
    const body = await res.arrayBuffer();
    return body.byteLength > 0 && body.byteLength <= MAX_BYTES ? { body, type: type.split(";")[0]! } : "miss";
  } catch {
    return "failed";
  }
}

function reply(entry: Entry) {
  if (!entry.body) {
    return new NextResponse(null, { status: 404, headers: { "Cache-Control": entry.failed ? "no-store" : "public, max-age=86400" } });
  }
  return new NextResponse(entry.body, {
    headers: {
      "Content-Type": entry.type,
      "Cache-Control": "public, max-age=604800, stale-while-revalidate=2592000",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}

export async function GET(request: Request, { params }: { params: { symbol: string } }) {
  const limit = rateLimit(`logo:${clientIp(request)}`, { limit: 600, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);
  const search = new URL(request.url).searchParams;
  const crypto = search.get("kind") === "crypto";
  const style = search.get("style") === "mono" ? "mono" : "color";
  const symbol = logoSymbol(params.symbol, crypto);
  if (!symbol) return NextResponse.json({ error: "Not a symbol." }, { status: 400 });

  const key = `${crypto ? "c" : "s"}:${style}:${symbol}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.body ? HIT_TTL_MS : hit.failed ? FAIL_TTL_MS : MISS_TTL_MS)) return reply(hit);

  let found: { body: ArrayBuffer; type: string } | null = null;
  let failed = false;
  for (const url of logoSources(symbol, crypto, style)) {
    const got = await fetchLogo(url);
    if (got === "failed") failed = true;
    else if (got !== "miss") {
      found = got;
      break;
    }
  }
  const entry: Entry = { at: Date.now(), body: found?.body ?? null, type: found?.type ?? "image/png", failed: !found && failed };
  remember(key, entry);
  return reply(entry);
}
