/**
 * Cloud sync for the paper portfolio.
 *
 * Up: pushes cash + positions to Supabase whenever the local account changes,
 * so the 24/7 falcon-engine can price it and record net-worth snapshots while
 * the desktop app is closed.
 *
 * Down: reads the snapshot series back for the portfolio chart.
 */

import {
  hasRealPaperAccount,
  readRealPaperAccount,
  readPaperUpdatedAt,
  seedPaperAccount,
  subscribePaperAccount,
  type PaperAccount,
} from "@/lib/paper-account";
import { supabase } from "@/lib/supabase";

export type CloudSnapshot = { ts: string; value: number };

async function pushPortfolio(): Promise<void> {
  if (!supabase) return;
  try {
    // Never push an empty local account — it would wipe the user's cloud copy
    // (e.g. right after signing in on a fresh machine).
    if (!hasRealPaperAccount()) return;

    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user.id;
    if (!userId) return;

    const account = readRealPaperAccount();
    await supabase.from("paper_portfolios").upsert({
      user_id: userId,
      cash: account.cash,
      positions: account.positions,
      updated_at: new Date().toISOString(),
    });
  } catch {
    /* best-effort — the worker just keeps tracking the last synced state */
  }
}

/** Seeds the local account from the signed-in user's cloud copy, if any. */
async function pullPortfolio(): Promise<void> {
  if (!supabase) return;
  try {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session) return;

    const { data, error } = await supabase
      .from("paper_portfolios")
      .select("cash,positions,updated_at")
      .eq("user_id", auth.session.user.id)
      .maybeSingle();
    if (error || !data) return;

    const cash = Number(data.cash);
    const account: PaperAccount = {
      cash: Number.isFinite(cash) ? cash : 0,
      positions:
        data.positions && typeof data.positions === "object"
          ? (data.positions as PaperAccount["positions"])
          : {},
    };

    // Nothing here yet (fresh machine, cleared storage) — take the cloud copy.
    if (!hasRealPaperAccount()) {
      seedPaperAccount(account);
      return;
    }

    // Local holds an account but no positions, while the cloud still has
    // them: restore, unless this device deliberately reset more recently
    // than the cloud copy was written (that reset must stand).
    const local = readRealPaperAccount();
    const cloudHasPositions = Object.keys(account.positions).length > 0;
    if (Object.keys(local.positions).length === 0 && cloudHasPositions) {
      const localAt = readPaperUpdatedAt();
      const cloudAt = new Date(String(data.updated_at ?? 0)).getTime();
      if (localAt == null || !Number.isFinite(cloudAt) || localAt < cloudAt) {
        seedPaperAccount(account);
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Starts cloud sync for the signed-in user: pulls their portfolio down first
 * (fresh machine / account switch), then pushes local changes up (debounced).
 * Returns an unsubscribe function.
 */
export function startPortfolioSync(): () => void {
  let timer: number | null = null;

  const schedule = () => {
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      void pushPortfolio();
    }, 1_500);
  };

  void pullPortfolio().then(() => pushPortfolio());
  const unsubscribe = subscribePaperAccount(schedule);
  return () => {
    if (timer != null) window.clearTimeout(timer);
    unsubscribe();
  };
}

/**
 * Deletes the signed-in user's recorded snapshot series — used when a paper
 * account is reset so the chart starts a fresh trajectory. Best-effort.
 */
export async function clearCloudSnapshots(): Promise<void> {
  if (!supabase) return;
  try {
    const { data: auth } = await supabase.auth.getSession();
    const userId = auth.session?.user.id;
    if (!userId) return;
    await supabase.from("portfolio_snapshots").delete().eq("user_id", userId);
  } catch {
    /* best-effort — stale rows only stretch the chart's history */
  }
}

/**
 * PostgREST answers at most this many rows per request whatever `.limit()`
 * asks for — the cap is the server's, not ours, which is why asking for more
 * silently returns 1000 instead of failing.
 */
const PAGE = 1000;
/** Ceiling on the whole walk, so a huge window cannot turn into 100 requests. */
const MAX_PAGES = 24;

/**
 * Snapshot series for the chart — last `days` days, oldest first.
 *
 * Paged, newest first, and reversed at the end. Both of those matter and
 * neither is cosmetic:
 *
 * A single capped request returns whichever end of the window the sort puts
 * first. Ascending, that is the OLDEST rows and everything recent is dropped —
 * which is what happened here: the worker moved from writing every five
 * minutes to every five seconds, one page stopped being seventeen days and
 * became under two hours, and the Day chart drew a flat line across the whole
 * night while the rows sat in the table. Nothing errored; the series was
 * simply short.
 *
 * So: walk pages from the newest backwards until the window is covered. The
 * far end of a long window still thins out at MAX_PAGES, and that is the right
 * end to lose — the recorded daily closes already carry the long tail, while
 * nothing else can reconstruct the last few hours.
 */
export async function fetchCloudSnapshots(days: number): Promise<CloudSnapshot[]> {
  if (!supabase) return [];
  try {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session) return [];

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffIso = cutoff.toISOString();

    const rows: Array<{ ts: string; value: number }> = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE;
      const { data, error } = await supabase
        .from("portfolio_snapshots")
        .select("ts,value")
        .gte("ts", cutoffIso)
        .order("ts", { ascending: false })
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      for (const row of data) {
        if (typeof row.ts === "string" && Number.isFinite(Number(row.value))) {
          rows.push({ ts: row.ts, value: Number(row.value) });
        }
      }
      // A short page is the end of the series, not a hint to ask again.
      if (data.length < PAGE) break;
    }

    rows.reverse();
    return rows;
  } catch {
    return [];
  }
}
