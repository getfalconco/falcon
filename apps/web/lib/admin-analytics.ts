import type { User } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabase-admin";
import { getOpportunitiesData } from "./admin-signals";

/**
 * Server-only data layer for the admin "Analytics" tab. Produces real daily
 * time-series (SeriesPoint[]) that feed the ProgressMetricCard component.
 * Real data only — degrades to empty series (the card shows "No data yet")
 * rather than fabricating numbers.
 *
 * Sources (all reachable from the web server):
 *   - Auth users → daily new signups + cumulative user total
 *   - second_order_signals (via admin-signals) → daily opportunities
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Matches the ProgressMetricCard `SeriesPoint` shape (structural typing). */
export type SeriesPoint = {
  value: number;
  date: string;
};

export type AnalyticsData = {
  generatedAt: string;
  windowDays: number;
  totalUsers: number;
  signupsToday: number;
  signupsDaily: SeriesPoint[];
  usersCumulative: SeriesPoint[];
  opportunitiesDaily: SeriesPoint[];
  /** Supabase auth users could not be read. */
  degraded: boolean;
  /** second_order_signals table absent → opportunities series is empty. */
  signalsMissingTable: boolean;
};

const LABEL_FMT = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});

/** Start-of-UTC-day timestamps for the last `days` days, oldest first. */
function dayStarts(days: number): number[] {
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: number[] = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(todayStart - i * DAY_MS);
  return out;
}

async function listAllUsers(): Promise<User[]> {
  const admin = getSupabaseAdmin();
  const users: User[] = [];
  let page = 1;
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 200) break;
    page += 1;
  }
  return users;
}

function emptyAnalytics(days: number, opts: { degraded?: boolean; signalsMissingTable?: boolean }): AnalyticsData {
  const zero = dayStarts(days).map((ts) => ({ value: 0, date: LABEL_FMT.format(ts) }));
  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    totalUsers: 0,
    signupsToday: 0,
    signupsDaily: zero,
    usersCumulative: zero,
    opportunitiesDaily: zero,
    degraded: opts.degraded ?? false,
    signalsMissingTable: opts.signalsMissingTable ?? false,
  };
}

export async function getAnalyticsData(options?: { days?: number }): Promise<AnalyticsData> {
  const days = options?.days ?? 30;
  const starts = dayStarts(days);
  const windowStart = starts[0];

  let users: User[];
  try {
    users = await listAllUsers();
  } catch (error) {
    console.error("[admin analytics] user fetch failed", error);
    return emptyAnalytics(days, { degraded: true });
  }

  const createdTimes = users
    .map((u) => Date.parse(u.created_at))
    .filter((t) => Number.isFinite(t));

  // Daily new signups + running cumulative total across the window.
  const signupsDaily: SeriesPoint[] = [];
  const usersCumulative: SeriesPoint[] = [];
  const usersBeforeWindow = createdTimes.filter((t) => t < windowStart).length;
  let running = usersBeforeWindow;

  for (const start of starts) {
    const end = start + DAY_MS;
    const label = LABEL_FMT.format(start);
    const dayCount = createdTimes.filter((t) => t >= start && t < end).length;
    running += dayCount;
    signupsDaily.push({ value: dayCount, date: label });
    usersCumulative.push({ value: running, date: label });
  }

  // Second-order signals per day (reuses the Signals data layer + its flags).
  const opps = await getOpportunitiesData({ days });
  const oppByDay = new Map<number, number>();
  for (const s of opps.signals) {
    const t = Date.parse(s.generatedAt);
    if (!Number.isFinite(t)) continue;
    const key = Date.UTC(
      new Date(t).getUTCFullYear(),
      new Date(t).getUTCMonth(),
      new Date(t).getUTCDate(),
    );
    oppByDay.set(key, (oppByDay.get(key) ?? 0) + 1);
  }
  const opportunitiesDaily: SeriesPoint[] = starts.map((start) => ({
    value: oppByDay.get(start) ?? 0,
    date: LABEL_FMT.format(start),
  }));

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    totalUsers: createdTimes.length,
    signupsToday: signupsDaily[signupsDaily.length - 1]?.value ?? 0,
    signupsDaily,
    usersCumulative,
    opportunitiesDaily,
    degraded: false,
    signalsMissingTable: opps.missingTable,
  };
}
