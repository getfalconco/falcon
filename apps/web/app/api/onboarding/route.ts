import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { bearerToken, userFromAccessToken } from "@/lib/waitlist-membership";
import {
  FRUSTRATIONS,
  GOALS,
  HEARD_ABOUT,
  MAX_OTHER_LENGTH,
  MAX_STOCKS,
  MISSED_MOVES,
  NOTIFICATION_ANSWERS,
  PORTFOLIO_SIZES,
  RESEARCH_TIMES,
  SECTORS,
  TENURES,
  TICKER_PATTERN,
  isOneOf,
} from "@/lib/onboarding";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The welcome flow's answers for the signed-in member, on their row in
 * public.onboarding_responses (one per user).
 *
 * Who is asking comes only from the Supabase access token in the
 * Authorization header, verified server-side; nobody can read or write
 * anyone else's row. Every value is checked against the fixed option lists
 * (portfolio_size feeds pricing, so only its four ids are ever stored).
 *
 * Columns that predate the flow (investing_tenure, research_frustration,
 * sectors, watchlist, heard_about) are written first; the newer ones from
 * supabase/migrations/20261109_welcome_flow_answers.sql in a second step, so
 * a missing migration loses only those.
 *
 *   GET  /api/onboarding            -> 200 { completed, watchlist }
 *   POST /api/onboarding {answers}  -> 200 { saved: "all" | "partial" }
 *   401 missing or invalid token, 429 rate limited, 502 save failed
 */

function unauthorized() {
  return NextResponse.json({ error: "Sign in first." }, { status: 401, headers: NO_STORE });
}

export async function GET(request: Request) {
  const limit = rateLimit(`onboarding-get:${clientIp(request)}`, { limit: 30, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);

  try {
    const user = await userFromAccessToken(bearerToken(request));
    if (!user) return unauthorized();

    const { data, error } = await getSupabaseAdmin()
      .from("onboarding_responses")
      .select("welcome_completed_at, watchlist")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;

    const row = data as { welcome_completed_at?: string | null; watchlist?: unknown } | null;
    // The focus list the Workspace opens with (tickers from the welcome flow).
    const watchlist = Array.isArray(row?.watchlist)
      ? row.watchlist.filter((t): t is string => typeof t === "string" && TICKER_PATTERN.test(t)).slice(0, MAX_STOCKS)
      : [];
    return NextResponse.json({ completed: Boolean(row?.welcome_completed_at), watchlist }, { headers: NO_STORE });
  } catch (error) {
    console.error("[api/onboarding GET]", error);
    return NextResponse.json({ error: "Failed to load." }, { status: 500, headers: NO_STORE });
  }
}

type Columns = Record<string, unknown>;

function columnsFrom(body: Record<string, unknown>): { base: Columns; extra: Columns } {
  const base: Columns = {};
  const extra: Columns = {};

  if (isOneOf(TENURES, body.tenure)) base.investing_tenure = body.tenure;
  if (isOneOf(FRUSTRATIONS, body.frustration)) base.research_frustration = body.frustration;
  if (Array.isArray(body.sectors)) {
    base.sectors = Array.from(new Set(body.sectors.filter((s) => isOneOf(SECTORS, s))));
  }
  if (Array.isArray(body.stocks)) {
    const tickers = body.stocks
      .map((s) => (typeof s === "object" && s !== null ? (s as { ticker?: unknown }).ticker : null))
      .filter((t): t is string => typeof t === "string" && TICKER_PATTERN.test(t));
    base.watchlist = Array.from(new Set(tickers)).slice(0, MAX_STOCKS);
  }
  if (isOneOf(HEARD_ABOUT, body.heardAbout)) {
    base.heard_about = body.heardAbout;
    extra.heard_about_other =
      body.heardAbout === "other" && typeof body.heardAboutOther === "string"
        ? body.heardAboutOther.trim().slice(0, MAX_OTHER_LENGTH) || null
        : null;
  }

  if (isOneOf(GOALS, body.goal)) extra.main_goal = body.goal;
  if (isOneOf(PORTFOLIO_SIZES, body.portfolioSize)) extra.portfolio_size = body.portfolioSize;
  if (isOneOf(MISSED_MOVES, body.missedMoves)) extra.missed_moves = body.missedMoves;
  if (isOneOf(RESEARCH_TIMES, body.researchTime)) extra.research_time = body.researchTime;
  if (NOTIFICATION_ANSWERS.includes(body.notifications as (typeof NOTIFICATION_ANSWERS)[number])) {
    extra.notifications_permission = body.notifications;
  }
  if (body.committed === true) extra.morning_commitment = true;
  if (body.completed === true) extra.welcome_completed_at = new Date().toISOString();

  return { base, extra };
}

export async function POST(request: Request) {
  // One save per answered step, so a little headroom over the flow's length.
  const limit = rateLimit(`onboarding-post:${clientIp(request)}`, { limit: 40, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);

  try {
    const user = await userFromAccessToken(bearerToken(request));
    if (!user) return unauthorized();

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid body." }, { status: 400, headers: NO_STORE });
    }

    const { base, extra } = columnsFrom(body);
    const now = new Date().toISOString();
    const admin = getSupabaseAdmin();

    const { error } = await admin
      .from("onboarding_responses")
      .upsert({ ...base, user_id: user.id, updated_at: now }, { onConflict: "user_id" });
    if (error) throw error;

    if (Object.keys(extra).length > 0) {
      const { error: extraError } = await admin
        .from("onboarding_responses")
        .update(extra)
        .eq("user_id", user.id);
      if (extraError) {
        console.error("[api/onboarding POST] newer columns", extraError.message);
        return NextResponse.json({ saved: "partial" }, { headers: NO_STORE });
      }
    }

    return NextResponse.json({ saved: "all" }, { headers: NO_STORE });
  } catch (error) {
    // The client moves on regardless; this only tells it the save missed.
    console.error("[api/onboarding POST]", error);
    return NextResponse.json({ saved: false }, { status: 502, headers: NO_STORE });
  }
}
