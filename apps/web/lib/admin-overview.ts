import type { User } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabase-admin";
import { getEngineHealth } from "./admin-engine-health";

/**
 * Server-only data layer for the admin Overview tab.
 *
 * Real data only. Anything the web server genuinely cannot see is returned as
 * `null` so the UI can render an honest "not tracked yet" state instead of a
 * fabricated number. Reachable sources (Supabase, service role):
 *   - Auth users      → totals, waitlist, weekly-active (last_sign_in_at)
 *   - daily_top_signals → the shared daily signal (one row per market date)
 * Not reachable (desktop-local JSON / in-memory, no sync path to the web):
 *   - propagation runs, graph node/edge counts, poller status, engine cost
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type ChangeDirection = "up" | "down" | "neutral";

export type MetricChange = {
  label: string;
  direction: ChangeDirection;
} | null;

export type OverviewMetrics = {
  totalUsers: number;
  totalUsersChange: MetricChange;
  waitlistPending: number;
  waitlistTodayLabel: string;
  weeklyActive: number;
  retentionLabel: string | null;
  /** null → no data source yet (render "—" + "not tracked yet"). */
  engineCostLabel: string | null;
};

export type ActivityEventType = "signup" | "waitlist" | "signal";

export type ActivityEvent = {
  id: string;
  type: ActivityEventType;
  text: string;
  ts: string;
};

export type SparkPoint = {
  date: string;
  count: number;
};

export type EngineHealth = {
  /** Real: daily_top_signals rows generated today. */
  signalsToday: number | null;
  /** Real: most recent daily_top_signals row. */
  latestSignal: { headline: string; generatedAt: string } | null;
  /** null → desktop-local / in-memory, not synced to the web. */
  propagationRun: { at: string; status: string } | null;
  pollerStatus: "healthy" | "error" | null;
  graphCounts: { nodes: number; edges: number } | null;
};

export type OverviewData = {
  generatedAt: string;
  metrics: OverviewMetrics;
  activity: ActivityEvent[];
  sparkline: SparkPoint[];
  engine: EngineHealth;
  /** True when Supabase could not be reached — UI shows "—" throughout. */
  degraded: boolean;
};

function isApproved(user: User): boolean {
  const meta = user.user_metadata ?? {};
  const app = user.app_metadata ?? {};
  const waitlisted = meta.waitlist === true || app.waitlist === true;
  // Approval counts only from app_metadata (service-role writes); a forged
  // client-side user_metadata flag must not show up as approved here. Legacy
  // pre-waitlist accounts (no flags at all) still display as approved.
  return app.approved === true || !waitlisted;
}

async function listAllUsers(): Promise<User[]> {
  const admin = getSupabaseAdmin();
  const users: User[] = [];
  let page = 1;

  // Supabase caps perPage at 1000; loop until a short page.
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 200) break;
    page += 1;
  }

  return users;
}

type DailySignalRow = {
  headline: string | null;
  generated_at: string | null;
  signal_date: string | null;
};

async function listRecentSignals(): Promise<DailySignalRow[]> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("daily_top_signals")
    .select("headline, generated_at, signal_date")
    .order("generated_at", { ascending: false })
    .limit(30);

  if (error) throw error;
  return (data ?? []) as DailySignalRow[];
}

function dayKey(iso: string | number | Date): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

function emptyOverview(degraded: boolean): OverviewData {
  return {
    generatedAt: new Date().toISOString(),
    metrics: {
      totalUsers: 0,
      totalUsersChange: null,
      waitlistPending: 0,
      waitlistTodayLabel: "+0 today",
      weeklyActive: 0,
      retentionLabel: null,
      engineCostLabel: null,
    },
    activity: [],
    sparkline: buildSparkline([]),
    engine: {
      signalsToday: null,
      latestSignal: null,
      propagationRun: null,
      pollerStatus: null,
      graphCounts: null,
    },
    degraded,
  };
}

function buildSparkline(createdDates: string[]): SparkPoint[] {
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const buckets = new Map<string, number>();

  for (let i = 13; i >= 0; i -= 1) {
    const key = dayKey(todayStart - i * DAY_MS);
    buckets.set(key, 0);
  }

  for (const iso of createdDates) {
    const key = dayKey(iso);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  return Array.from(buckets.entries()).map(([date, count]) => ({ date, count }));
}

export async function getOverviewData(): Promise<OverviewData> {
  let users: User[];
  try {
    users = await listAllUsers();
  } catch (error) {
    console.error("[admin overview] user fetch failed", error);
    return emptyOverview(true);
  }

  const now = Date.now();
  const weekAgo = now - 7 * DAY_MS;
  const todayStart = (() => {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  })();

  const approved = users.filter(isApproved);
  const pending = users.filter((u) => !isApproved(u));

  // Total users = active/approved accounts. Waitlist pending is tracked
  // separately (both are Supabase auth rows; there is no distinct users table).
  const totalUsers = approved.length;
  const totalWeekAgo = approved.filter((u) => Date.parse(u.created_at) < weekAgo).length;
  const totalUsersChange = ((): MetricChange => {
    if (totalWeekAgo > 0) {
      const pct = ((totalUsers - totalWeekAgo) / totalWeekAgo) * 100;
      const rounded = Math.round(pct);
      if (rounded === 0) return { label: "0%", direction: "neutral" };
      return {
        label: `${rounded > 0 ? "+" : ""}${rounded}%`,
        direction: rounded > 0 ? "up" : "down",
      };
    }
    const added = totalUsers;
    if (added > 0) return { label: `+${added} new`, direction: "up" };
    return null;
  })();

  const waitlistPending = pending.length;
  const waitlistToday = pending.filter((u) => Date.parse(u.created_at) >= todayStart).length;

  const weeklyActive = users.filter((u) => {
    const last = u.last_sign_in_at ? Date.parse(u.last_sign_in_at) : NaN;
    return Number.isFinite(last) && last >= weekAgo;
  }).length;
  const retentionLabel =
    totalUsers > 0 ? `${Math.round((weeklyActive / totalUsers) * 100)}% of users` : null;

  // Signals (daily_top_signals) — degrade gracefully if the table is absent.
  let signals: DailySignalRow[] = [];
  try {
    signals = await listRecentSignals();
  } catch (error) {
    console.error("[admin overview] signal fetch failed", error);
  }

  const signalsToday = signals.filter(
    (s) => s.generated_at && Date.parse(s.generated_at) >= todayStart,
  ).length;
  const latestSignal = signals.find((s) => s.generated_at)
    ? {
        headline: signals[0].headline?.trim() || "Daily signal",
        generatedAt: signals[0].generated_at as string,
      }
    : null;

  // Activity feed — merge real event sources, newest first.
  const activity: ActivityEvent[] = [
    ...approved.map<ActivityEvent>((u) => ({
      id: `signup-${u.id}`,
      type: "signup",
      text: u.email ?? "New user",
      ts: u.created_at,
    })),
    ...pending.map<ActivityEvent>((u) => ({
      id: `waitlist-${u.id}`,
      type: "waitlist",
      text: u.email ?? "New waitlist entry",
      ts: u.created_at,
    })),
    ...signals
      .filter((s) => s.generated_at)
      .map<ActivityEvent>((s) => ({
        id: `signal-${s.signal_date ?? s.generated_at}`,
        type: "signal",
        text: s.headline?.trim() || "Daily signal generated",
        ts: s.generated_at as string,
      })),
  ]
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, 10);

  const sparkline = buildSparkline(users.map((u) => u.created_at));

  // News-worker heartbeat (Railway) — real poller + last-run status.
  const health = await getEngineHealth();
  const pollerStatus: "healthy" | "error" | null = health.present
    ? health.status === "healthy"
      ? "healthy"
      : "error"
    : null;
  const propagationRun =
    health.present && health.updatedAt
      ? { at: health.updatedAt, status: health.status }
      : null;

  return {
    generatedAt: new Date().toISOString(),
    metrics: {
      totalUsers,
      totalUsersChange,
      waitlistPending,
      waitlistTodayLabel: `+${waitlistToday} today`,
      weeklyActive,
      retentionLabel,
      engineCostLabel: null, // no API usage log reachable from the web server
    },
    activity,
    sparkline,
    engine: {
      signalsToday,
      latestSignal,
      propagationRun, // from the news-worker heartbeat
      pollerStatus, // from the news-worker heartbeat
      graphCounts: null, // desktop-local graph.json, not synced yet
    },
    degraded: false,
  };
}
