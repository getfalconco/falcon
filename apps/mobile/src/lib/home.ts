import type { Href } from "expo-router";
import { FUNNEL_TEST_MODE, apiUrl } from "./env";
import { clearHoldings, loadHoldings, saveHoldings } from "./holdings";
import { accessToken, getSupabase } from "./supabase";

/** The home tabs' first screen. */
export const HOME_ROUTE = "/today" as const satisfies Href;

/**
 * The website's GET /api/onboarding for the signed-in member: whether the
 * welcome funnel is done and the tickers it saved. Null on any failure.
 */
async function memberOnboarding(): Promise<{ completed: boolean; watchlist: string[] } | null> {
  const token = await accessToken();
  if (!token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(apiUrl("/api/onboarding"), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { completed?: unknown; watchlist?: unknown };
    const watchlist = Array.isArray(body.watchlist)
      ? body.watchlist.filter((t): t is string => typeof t === "string")
      : [];
    return { completed: body.completed === true, watchlist };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where a signed-in member goes: the home tabs once the welcome funnel is
 * done (on this phone, or per the website for a new phone, whose saved
 * tickers then become the holdings), otherwise the funnel. Funnel test mode
 * always runs the funnel.
 */
export async function signedInRoute(): Promise<Href> {
  if (FUNNEL_TEST_MODE) return "/welcome";
  const userId = await currentUserId();
  const saved = await loadHoldings();
  if (saved && (!saved.userId || !userId || saved.userId === userId)) return HOME_ROUTE;
  // Someone else's holdings from an earlier session on this phone.
  if (saved) clearHoldings();
  const member = await memberOnboarding();
  if (!member?.completed) return "/welcome";
  saveHoldings(
    member.watchlist.map((ticker) => ({ ticker, name: "" })),
    [],
    userId,
  );
  return HOME_ROUTE;
}

/** The signed-in member's Supabase user id, or null. */
export async function currentUserId(): Promise<string | null> {
  try {
    return (await getSupabase()?.auth.getSession())?.data.session?.user.id ?? null;
  } catch {
    return null;
  }
}
