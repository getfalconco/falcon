import { FUNNEL_TEST_MODE, apiUrl } from "./env";
import { currentUserId, memberOnboarding } from "./home";
import { loadHoldings, nameHoldings, saveHoldings, type Holdings } from "./holdings";
import { tickerNames } from "./onboarding";
import { accessToken } from "./supabase";

/**
 * The Portfolio tab's focus list beyond this phone: the website's welcome
 * answers (GET /api/onboarding) seed it when the phone has none, and edits go
 * back as the same answers' watchlist (POST /api/onboarding { stocks }), so
 * the website's Workspace opens with the same tickers. Never throws; the phone
 * keeps working on its own copy when the site can't be reached.
 */

const SYNC_DELAY_MS = 900;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** Sends the current tickers a moment after the last edit. Signed-in members only. */
export function syncFocusList(): void {
  if (FUNNEL_TEST_MODE) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void pushFocusList();
  }, SYNC_DELAY_MS);
}

async function pushFocusList(): Promise<void> {
  const token = await accessToken();
  const holdings = await loadHoldings();
  if (!token || !holdings) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(apiUrl("/api/onboarding"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ stocks: holdings.stocks.map((s) => ({ ticker: s.ticker })) }),
      signal: controller.signal,
    });
  } catch {
    // The phone's copy stays; the next edit tries again.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * When the phone has no focus list yet and a member is signed in, takes the
 * tickers from their website answers. Then fills in missing company names.
 */
export async function hydrateFocusList(): Promise<Holdings | null> {
  let holdings = await loadHoldings();
  if (holdings === null && !FUNNEL_TEST_MODE) {
    const member = await memberOnboarding();
    if (member && member.watchlist.length > 0 && (await loadHoldings()) === null) {
      saveHoldings(
        member.watchlist.map((ticker) => ({ ticker, name: "" })),
        [],
        await currentUserId(),
      );
      holdings = await loadHoldings();
    }
  }
  const unnamed = (holdings?.stocks ?? []).filter((s) => !s.name).map((s) => s.ticker);
  if (unnamed.length > 0) nameHoldings(await tickerNames(unnamed));
  return holdings;
}
