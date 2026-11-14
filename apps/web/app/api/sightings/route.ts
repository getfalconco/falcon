import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { cardLive, isMeasured, isWeakSignal, opportunityCards, type RippleCard, type SightingsFeed } from "@falcon/ripple";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * The Ripple Engine's Sightings feed (packages/engine writes it, daily from
 * .github/workflows/sightings.yml).
 *
 *   GET /api/sightings                      ->  200 SightingsFeed
 *   GET /api/sightings?tickers=NVDA,AMD     ->  200 SightingsFeed & { portfolio, opportunities }
 *
 * `cards` are the live cards, newest event first: a card is served until its
 * `expiresAt` (publish time + its longest hit window), and an older card
 * without one for 7 days after its event. Watch-tier cards are included (the
 * screens list them last, collapsed, under "Watch list"). `generatedAt` is
 * when the newest of them was written. With `tickers`, `portfolio` holds the
 * cards whose event company or any hit is one of them, and `opportunities`
 * the other cards, each with only the hits @falcon/ripple `opportunityCards`
 * allows: Measured hits, or while no hit is Measured, Documented own-firm
 * hits with exact evidence (the interim rule, env
 * OPPORTUNITIES_INTERIM_DOCUMENTED, on unless "0"/"false"). Neither list
 * holds a weak signal (`isWeakSignal`); the rules live in the engine and in
 * @falcon/ripple, never re-derived here.
 *
 * Reads public.sightings_cards (not stale, event in the window); when that
 * is empty or unreachable outside production, the engine's local output
 * (packages/engine/out/sightings.json) instead. Read-only public data, so any
 * origin may read it (the iPhone app's web preview calls it cross-origin),
 * and the CDN may keep it for 5 minutes (the engine runs once a day).
 */

const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;
const MAX_TICKERS = 50;
const MAX_CARDS = 50;
/** Rows read before the expiry filter: cards live at most about 95 days (a 63-session window x1.5). */
const MAX_ROWS = 200;
const LOOKBACK_DAYS = 120;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** A feed with cards: short browser cache, 5 minutes at the CDN, served stale while it refreshes. */
const CACHE_OK = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";
/** An empty answer (nothing yet, or the database unreachable) is not kept for long. */
const CACHE_EMPTY = "public, max-age=0, s-maxage=30";

type Source = "supabase" | "local" | "empty";

type Row = { card: RippleCard; generated_at: string; event_at: string };

function newestFirst(a: RippleCard, b: RippleCard): number {
  return b.event.occurredAt.localeCompare(a.event.occurredAt) || b.generatedAt.localeCompare(a.generatedAt) || a.id.localeCompare(b.id);
}

function feedOf(cards: RippleCard[], fallbackAt: string): SightingsFeed {
  const sorted = [...cards].sort(newestFirst);
  const newest = sorted.reduce<string | null>((m, c) => (c.generatedAt && (!m || c.generatedAt > m) ? c.generatedAt : m), null);
  return { generatedAt: new Date(newest ?? fallbackAt).toISOString(), cards: sorted };
}

async function fromSupabase(): Promise<SightingsFeed | null> {
  const db = getSupabaseAdmin();
  const now = Date.now();
  const since = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString();
  const query = (withStale: boolean) => {
    let q = db.from("sightings_cards").select("card, generated_at, event_at").gte("event_at", since);
    if (withStale) q = q.eq("stale", false);
    return q.order("event_at", { ascending: false }).order("generated_at", { ascending: false }).limit(MAX_ROWS);
  };
  let res = await query(true);
  // Before the stale column's migration (20261113) the window alone decides.
  if (res.error?.code === "42703") res = await query(false);
  if (res.error) throw res.error;
  const rows = (res.data ?? []) as Row[];
  const cards = rows
    .map((r) => (r.card && Array.isArray(r.card.hits) ? { ...r.card, generatedAt: r.card.generatedAt ?? r.generated_at } : null))
    .filter((c): c is RippleCard => c !== null)
    // Served until expiresAt; an older card without it, 7 days after its event (@falcon/ripple cardLive).
    .filter((c) => cardLive(c, now))
    .slice(0, MAX_CARDS);
  if (cards.length === 0) return null;
  const newestRow = rows.reduce((m, r) => (r.generated_at > m ? r.generated_at : m), rows[0]!.generated_at);
  return feedOf(cards, newestRow);
}

async function fromLocalFile(): Promise<SightingsFeed | null> {
  // `next dev` runs in apps/web; the engine writes next to it in the monorepo.
  const file = path.resolve(process.cwd(), "..", "..", "packages", "engine", "out", "sightings.json");
  try {
    const feed = JSON.parse(await fs.readFile(file, "utf8")) as SightingsFeed;
    if (!Array.isArray(feed.cards)) return null;
    return { ...feedOf(feed.cards, feed.generatedAt), ...(feed.meta ? { meta: feed.meta } : {}) };
  } catch {
    return null;
  }
}

async function loadFeed(): Promise<{ feed: SightingsFeed; source: Source }> {
  // Dev only: SIGHTINGS_SOURCE=local previews the engine's dry-run output
  // (packages/engine/out/sightings.json) instead of the database.
  if (process.env.NODE_ENV !== "production" && process.env.SIGHTINGS_SOURCE === "local") {
    const local = await fromLocalFile();
    if (local) return { feed: local, source: "local" };
  }
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
  const headers = {
    ...CORS,
    "Cache-Control": feed.cards.length ? CACHE_OK : CACHE_EMPTY,
    // Netlify's CDN keys the cache on `tickers` only, so other query strings share one entry.
    "Netlify-Vary": "query=tickers",
    "X-Sightings-Source": source,
  };

  if (tickers === null) return NextResponse.json(feed, { headers });

  const held = new Set(tickers);
  const portfolio = feed.cards.filter((c) => touches(c, held) && !isWeakSignal(c));
  const interim = process.env.OPPORTUNITIES_INTERIM_DOCUMENTED;
  const interimDocumented = interim === undefined || interim.trim() === "" || !/^(0|false|off|no)$/i.test(interim.trim());
  // The interim rule looks at the whole feed (no Measured hit anywhere); cards touching the holdings are left out first.
  const anyMeasured = feed.cards.some((c) => c.hits.some(isMeasured));
  const opportunities = opportunityCards(
    feed.cards.filter((c) => !touches(c, held)),
    held,
    { interimDocumented: interimDocumented && !anyMeasured },
  );
  return NextResponse.json({ ...feed, portfolio, opportunities }, { headers });
}
