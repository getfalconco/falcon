import { getSupabaseAdmin } from "./supabase-admin";

/**
 * Server-only reader for the news-worker's health heartbeat. The Railway worker
 * upserts a row into public.engine_health every cycle; here we read it and derive
 * a freshness-aware status. Degrades gracefully (missing table / no heartbeat).
 */

const ENGINE_ID = "news-worker";
const MIN_STALE_MS = 5 * 60 * 1000; // consider stale after 5 min with no heartbeat

export type EngineHealthStatus = "healthy" | "stale" | "error" | "down";

export type EngineHealth = {
  /** Derived overall status. */
  status: EngineHealthStatus;
  /** A heartbeat row exists at all. */
  present: boolean;
  updatedAt: string | null;
  startedAt: string | null;
  reportedStatus: string | null;
  lastError: string | null;
  lastPollAt: string | null;
  lastSummary: string | null;
  articlesChecked: number | null;
  newEvents: number | null;
  signalsSaved: number | null;
  eventsDeduped: number | null;
  cycleMs: number | null;
  pollIntervalMs: number | null;
  cycles: number | null;
  errors: number | null;
  version: string | null;
  /** True when the engine_health table does not exist yet. */
  missingTable: boolean;
  /** True when Supabase could not be reached. */
  degraded: boolean;
};

type HealthRow = {
  updated_at: string | null;
  started_at: string | null;
  status: string | null;
  last_error: string | null;
  last_poll_at: string | null;
  last_summary: string | null;
  articles_checked: number | null;
  new_events: number | null;
  signals_saved: number | null;
  events_deduped: number | null;
  cycle_ms: number | null;
  poll_interval_ms: number | null;
  cycles: number | null;
  errors: number | null;
  version: string | null;
};

function isMissingTableError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /engine_health/.test(error.message ?? "") && /exist/i.test(error.message ?? "");
}

function empty(opts: { missingTable?: boolean; degraded?: boolean }): EngineHealth {
  return {
    status: "down",
    present: false,
    updatedAt: null,
    startedAt: null,
    reportedStatus: null,
    lastError: null,
    lastPollAt: null,
    lastSummary: null,
    articlesChecked: null,
    newEvents: null,
    signalsSaved: null,
    eventsDeduped: null,
    cycleMs: null,
    pollIntervalMs: null,
    cycles: null,
    errors: null,
    version: null,
    missingTable: opts.missingTable ?? false,
    degraded: opts.degraded ?? false,
  };
}

export async function getEngineHealth(): Promise<EngineHealth> {
  let row: HealthRow | null;
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from("engine_health")
      .select(
        "updated_at, started_at, status, last_error, last_poll_at, last_summary, articles_checked, new_events, signals_saved, events_deduped, cycle_ms, poll_interval_ms, cycles, errors, version",
      )
      .eq("id", ENGINE_ID)
      .maybeSingle();

    if (error) {
      if (isMissingTableError(error)) return empty({ missingTable: true });
      console.error("[admin engine-health] fetch failed", error);
      return empty({ degraded: true });
    }
    row = (data as HealthRow | null) ?? null;
  } catch (error) {
    console.error("[admin engine-health] fetch threw", error);
    return empty({ degraded: true });
  }

  if (!row) return empty({});

  const updatedMs = row.updated_at ? Date.parse(row.updated_at) : NaN;
  const staleAfter = Math.max(MIN_STALE_MS, 3 * (row.poll_interval_ms ?? 0));
  const isStale = !Number.isFinite(updatedMs) || Date.now() - updatedMs > staleAfter;

  const status: EngineHealthStatus = isStale
    ? "stale"
    : row.status === "error"
      ? "error"
      : "healthy";

  return {
    status,
    present: true,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    reportedStatus: row.status,
    lastError: row.last_error,
    lastPollAt: row.last_poll_at,
    lastSummary: row.last_summary,
    articlesChecked: row.articles_checked,
    newEvents: row.new_events,
    signalsSaved: row.signals_saved,
    eventsDeduped: row.events_deduped,
    cycleMs: row.cycle_ms,
    pollIntervalMs: row.poll_interval_ms,
    cycles: row.cycles,
    errors: row.errors,
    version: row.version,
    missingTable: false,
    degraded: false,
  };
}
