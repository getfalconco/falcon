import { NextResponse } from "next/server";
import type { RippleOptions } from "@falcon/ripple";
import { ADMIN_COOKIE_NAME, requireFounderAdmin } from "@/lib/admin-session";
import {
  allForViewer,
  compactOf,
  earningsForViewer,
  earningsReleaseOf,
  emptyAll,
  emptyEarnings,
  emptyTicker,
  OPTIONS_SOURCE,
  tickerForViewer,
  type OptionsAll,
  type OptionsCompact,
  type OptionsEarnings,
  type OptionsEarningsRelease,
  type OptionsTicker,
} from "@/lib/options-api";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { optionsDisplayMode } from "@/lib/sightings-options";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * Options data for the whole universe (shapes and units: lib/options-api.ts).
 *
 *   GET /api/options?all=1        ->  200 OptionsAll
 *   GET /api/options?ticker=NVDA  ->  200 OptionsTicker
 *   GET /api/options?earnings=1   ->  200 OptionsEarnings
 *
 * Reads public.options_latest / public.options_daily (written once a trading
 * day by .github/workflows/options-daily.yml) with the service role. The
 * OPTIONS_DISPLAY rule of /api/sightings applies: viewers it does not allow
 * get the empty shapes, and an admin-only answer is never cached by the CDN.
 * The data changes once a day: 10 minutes in the browser and at the CDN.
 */

const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;
const PAGE = 1000;
const MAX_ROWS = 6000;
const HISTORY_ROWS = 90;
/** Sessions of stored straddles the earnings answer looks back over (calendar days). */
const EARNINGS_LOOKBACK_DAYS = 7;
const EARNINGS_ROWS = 2000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const CACHE_OK = "public, max-age=600, s-maxage=600, stale-while-revalidate=3600";
const CACHE_EMPTY = "public, max-age=0, s-maxage=60";

type LatestRow = { ticker: string; as_of: string; block: RippleOptions | null; iv_pct: number | null };
type DailyRow = { as_of: string; block: RippleOptions | null; ivPct: number | null; ivDays: number | null };

async function loadAll(): Promise<OptionsAll> {
  const db = getSupabaseAdmin();
  const tickers: Record<string, OptionsCompact> = {};
  let newest: string | null = null;
  // PostgREST answers at most 1000 rows a request: page through the view.
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const res = await db.from("options_latest").select("ticker, as_of, block, iv_pct").order("ticker").range(from, from + PAGE - 1);
    if (res.error) throw res.error;
    const rows = (res.data ?? []) as LatestRow[];
    for (const r of rows) {
      const c = compactOf(r.block, r.iv_pct);
      if (!c) continue;
      tickers[r.ticker] = c;
      if (!newest || r.as_of > newest) newest = r.as_of;
    }
    if (rows.length < PAGE) break;
  }
  return { asOf: newest, source: OPTIONS_SOURCE, count: Object.keys(tickers).length, tickers };
}

async function loadTicker(ticker: string): Promise<OptionsTicker> {
  const db = getSupabaseAdmin();
  const res = await db
    .from("options_daily")
    .select("as_of, block:metrics->block, ivPct:metrics->ivPct, ivDays:metrics->ivDays")
    .eq("ticker", ticker)
    .is("skip", null)
    .order("as_of", { ascending: false })
    .limit(HISTORY_ROWS);
  if (res.error) throw res.error;
  const rows = ((res.data ?? []) as unknown as DailyRow[]).filter((r) => r.block && typeof r.block.atmIv === "number");
  if (!rows.length) return emptyTicker(ticker);
  const latest = rows[0]!;
  const options: RippleOptions = { ...latest.block! };
  if (typeof latest.ivPct === "number") options.ivPct = latest.ivPct;
  return {
    ticker,
    date: latest.as_of,
    options,
    ivDays: typeof latest.ivDays === "number" ? latest.ivDays : 0,
    history: rows.map((r) => ({ date: r.as_of, atmIv: r.block!.atmIv })).reverse(),
  };
}

type StraddleRow = { ticker: string; as_of: string; straddle: unknown };

/** The pre-earnings straddles stored over the last week, the newest session's per ticker and release date. */
async function loadEarnings(): Promise<OptionsEarnings> {
  const since = new Date(Date.now() - EARNINGS_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const res = await getSupabaseAdmin()
    .from("options_daily")
    .select("ticker, as_of, straddle:metrics->earnings_straddle")
    .gte("as_of", since)
    .not("metrics->earnings_straddle", "is", null)
    .order("as_of", { ascending: false })
    .limit(EARNINGS_ROWS);
  if (res.error) throw res.error;
  const seen = new Set<string>();
  const releases: OptionsEarningsRelease[] = [];
  for (const r of (res.data ?? []) as unknown as StraddleRow[]) {
    const rel = earningsReleaseOf(r.ticker, r.as_of, r.straddle);
    if (!rel) continue;
    const key = `${rel.ticker}|${rel.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    releases.push(rel);
  }
  return { source: OPTIONS_SOURCE, releases };
}

/** A valid founder admin session cookie (lib/admin-session); false on any error. */
async function isFounderAdmin(): Promise<boolean> {
  try {
    return (await requireFounderAdmin()) !== null;
  } catch {
    return false;
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  const limit = rateLimit(`options:${clientIp(request)}`, { limit: 120, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter, CORS);

  const params = new URL(request.url).searchParams;
  const all = params.get("all");
  const earnings = params.get("earnings") === "1";
  const rawTicker = params.get("ticker");
  const ticker = rawTicker?.trim().toUpperCase() ?? null;
  if (!(all === "1" || all === "true") && !ticker && !earnings) {
    return NextResponse.json({ error: "Use ?all=1, ?earnings=1 or ?ticker=SYMBOL" }, { status: 400, headers: CORS });
  }
  if (ticker !== null && !(all === "1" || all === "true") && !earnings && !TICKER.test(ticker)) {
    return NextResponse.json({ error: "Bad ticker" }, { status: 400, headers: CORS });
  }

  const mode = optionsDisplayMode();
  const admin = mode === "admin" ? await isFounderAdmin() : false;
  const personal = mode === "admin" && admin;
  const allowed = mode === "all" || personal;

  let body: OptionsAll | OptionsTicker | OptionsEarnings;
  let ok = false;
  try {
    if (earnings) {
      const data = allowed ? await loadEarnings() : emptyEarnings();
      body = earningsForViewer(data, mode, admin);
      ok = allowed;
    } else if (all === "1" || all === "true") {
      const data = allowed ? await loadAll() : emptyAll();
      body = allForViewer(data, mode, admin);
      ok = body.count > 0;
    } else {
      const data = allowed ? await loadTicker(ticker!) : emptyTicker(ticker!);
      body = tickerForViewer(data, mode, admin);
      ok = body.options !== null || allowed;
    }
  } catch (error) {
    console.error("[api/options] supabase read failed", error);
    body = earnings ? emptyEarnings() : all === "1" || all === "true" ? emptyAll() : emptyTicker(ticker!);
  }

  const headers: Record<string, string> = {
    ...CORS,
    // An admin's answer carries data the public one does not: never kept by the CDN or shared caches.
    "Cache-Control": personal ? "private, no-store" : ok ? CACHE_OK : CACHE_EMPTY,
    "Netlify-Vary": `query=all|ticker|earnings,cookie=${ADMIN_COOKIE_NAME}`,
  };
  if (personal) headers["Netlify-CDN-Cache-Control"] = "no-store";
  return NextResponse.json(body, { headers });
}
