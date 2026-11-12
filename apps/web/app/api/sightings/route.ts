import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import type { RippleCard, SightingsFeed } from "@falcon/ripple";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * The Ripple Engine's Sightings feed (packages/engine writes it).
 *
 *   GET /api/sightings                      ->  200 SightingsFeed
 *   GET /api/sightings?tickers=NVDA,AMD     ->  200 SightingsFeed & { portfolio, opportunities }
 *
 * With `tickers`, `portfolio` holds the cards whose event company or any hit
 * is one of them, and `opportunities` the rest (cards stay whole either way).
 *
 * Reads the newest run in public.sightings_cards; when that table is empty
 * or unreachable outside production, the engine's local output
 * (packages/engine/out/sightings.json) instead. Read-only public data, so any
 * origin may read it (the iPhone app's web preview calls it cross-origin).
 */

const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;
const MAX_TICKERS = 50;
const MAX_CARDS = 50;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

type Source = "supabase" | "local" | "empty";

async function fromSupabase(): Promise<SightingsFeed | null> {
  const db = getSupabaseAdmin();
  const latest = await db.from("sightings_cards").select("generated_at").order("generated_at", { ascending: false }).limit(1);
  if (latest.error) throw latest.error;
  const generatedAt = latest.data?.[0]?.generated_at as string | undefined;
  if (!generatedAt) return null;
  const rows = await db
    .from("sightings_cards")
    .select("card")
    .eq("generated_at", generatedAt)
    .order("event_at", { ascending: false })
    .limit(MAX_CARDS);
  if (rows.error) throw rows.error;
  const cards = (rows.data ?? []).map((r) => r.card as RippleCard).filter((c) => c && Array.isArray(c.hits));
  if (cards.length === 0) return null;
  return { generatedAt: new Date(generatedAt).toISOString(), cards };
}

async function fromLocalFile(): Promise<SightingsFeed | null> {
  // `next dev` runs in apps/web; the engine writes next to it in the monorepo.
  const file = path.resolve(process.cwd(), "..", "..", "packages", "engine", "out", "sightings.json");
  try {
    const feed = JSON.parse(await fs.readFile(file, "utf8")) as SightingsFeed;
    return Array.isArray(feed.cards) ? feed : null;
  } catch {
    return null;
  }
}

async function loadFeed(): Promise<{ feed: SightingsFeed; source: Source }> {
  let fromDb: SightingsFeed | null = null;
  try {
    fromDb = await fromSupabase();
  } catch (error) {
    console.error("[api/sightings] supabase read failed", error);
  }
  if (fromDb) return { feed: fromDb, source: "supabase" };
  if (process.env.NODE_ENV !== "production") {
    const local = await fromLocalFile();
    if (local) return { feed: local, source: "local" };
  }
  return { feed: { generatedAt: new Date().toISOString(), cards: [] }, source: "empty" };
}

/** Whether a card touches any of the tickers (its event company or a hit). */
function touches(card: RippleCard, held: Set<string>): boolean {
  return held.has(card.event.ticker) || card.hits.some((h) => held.has(h.ticker));
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  const limit = rateLimit(`sightings:${clientIp(request)}`, { limit: 120, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter, CORS);

  const param = new URL(request.url).searchParams.get("tickers");
  const tickers =
    param === null
      ? null
      : param
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter((s) => TICKER.test(s))
          .slice(0, MAX_TICKERS);

  const { feed, source } = await loadFeed();
  const headers = { ...CORS, "Cache-Control": "public, max-age=60", "X-Sightings-Source": source };

  if (tickers === null) return NextResponse.json(feed, { headers });

  const held = new Set(tickers);
  const portfolio = feed.cards.filter((c) => touches(c, held));
  const opportunities = feed.cards.filter((c) => !touches(c, held));
  return NextResponse.json({ ...feed, portfolio, opportunities }, { headers });
}
