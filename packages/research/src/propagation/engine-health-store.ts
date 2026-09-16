/**
 * Heartbeat writer for always-on engines (the Railway news-worker).
 *
 * Mirrors the opportunities Supabase pattern: service-role key, best-effort
 * (never throws into the run loop), no-op when Supabase is not configured.
 * One row per engine id in public.engine_health, upserted every cycle.
 */

const SUPABASE_HEADERS = {
  "User-Agent": "MeridianWorker/1.0",
  "Content-Type": "application/json",
};

export type EngineHealthPayload = {
  /** Engine identifier, e.g. "news-worker". */
  id: string;
  status: "ok" | "error";
  startedAt: string;
  lastError?: string | null;
  lastPollAt?: string | null;
  lastSummary?: string | null;
  articlesChecked?: number | null;
  newEvents?: number | null;
  signalsSaved?: number | null;
  eventsDeduped?: number | null;
  cycleMs?: number | null;
  pollIntervalMs?: number | null;
  cycles?: number | null;
  errors?: number | null;
  version?: string | null;
};

function supabaseConfig(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

export function isEngineHealthBackendConfigured(): boolean {
  return supabaseConfig() !== null;
}

/** Upsert a heartbeat row (merge on id). Best-effort — logs and returns on failure. */
export async function persistEngineHealth(payload: EngineHealthPayload): Promise<void> {
  const config = supabaseConfig();
  if (!config) return;

  const row = {
    id: payload.id,
    updated_at: new Date().toISOString(),
    started_at: payload.startedAt,
    status: payload.status,
    last_error: payload.lastError ?? null,
    last_poll_at: payload.lastPollAt ?? null,
    last_summary: payload.lastSummary ?? null,
    articles_checked: payload.articlesChecked ?? null,
    new_events: payload.newEvents ?? null,
    signals_saved: payload.signalsSaved ?? null,
    events_deduped: payload.eventsDeduped ?? null,
    cycle_ms: payload.cycleMs ?? null,
    poll_interval_ms: payload.pollIntervalMs ?? null,
    cycles: payload.cycles ?? null,
    errors: payload.errors ?? null,
    version: payload.version ?? null,
  };

  try {
    const res = await fetch(`${config.url}/rest/v1/engine_health`, {
      method: "POST",
      headers: {
        ...SUPABASE_HEADERS,
        apikey: config.serviceKey,
        Authorization: `Bearer ${config.serviceKey}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([row]),
    });
    if (!res.ok) {
      console.warn(
        "[engine-health] Supabase upsert failed:",
        res.status,
        (await res.text().catch(() => "")).slice(0, 300),
      );
    }
  } catch (err) {
    console.warn(
      "[engine-health] Supabase upsert failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
