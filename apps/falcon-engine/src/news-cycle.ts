import path from "node:path";
import {
  runNewsEventPoll,
  listStoredEvents,
  persistEventsToSupabase,
  isNewsEventBackendConfigured,
} from "@meridian/research/news";
import {
  persistGraphToSupabase,
  loadGraphFile,
  persistEngineHealth,
} from "@meridian/research/propagation";

/**
 * The news-events pipeline, moved here from the retired apps/news-worker.
 *
 * Every tick: poll Finnhub company-news for the seeded tickers, classify new
 * articles (Claude) into MaterialNewsEvents on disk, and when anything landed,
 * sync the events and the relationship graph to Supabase — that feed is what
 * the mobile events screen and graph views render. Runs beside the Tracker on
 * purpose: the Tracker reads the same headlines but mints tracker messages for
 * the deterministic chain, while this produces the human-readable event feed.
 * Same shape as portfolio-tracker.ts: fire-and-forget loop, never throws out.
 *
 * The heartbeat keeps the old `news-worker` id because the web admin's
 * engine-health card queries exactly that row (apps/web/lib/admin-engine-health
 * .ts) and the web deploys manually via Netlify — renaming the id here would
 * silently blank that card until someone remembers to ship the web too.
 */

const POLL_INTERVAL_MS = Math.max(
  10_000,
  Number.parseInt(process.env.NEWS_POLL_INTERVAL_MS ?? "60000", 10) || 60_000,
);

function eventsDir(): string {
  return (
    process.env.FALCON_EVENTS_DATA_DIR?.trim() ??
    path.resolve(process.cwd(), "data", "events")
  );
}

function graphPath(): string {
  return (
    process.env.FALCON_GRAPH_PATH?.trim() ??
    path.resolve(process.cwd(), "apps", "desktop", "data", "graph.json")
  );
}

const ENGINE_ID = "news-worker";
const VERSION =
  process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ??
  process.env.npm_package_version ??
  null;
const STARTED_AT = new Date().toISOString();

let cycleRunning = false;
let totalCycles = 0;
let totalErrors = 0;
let lastRunAt: string | null = null;
let lastError: string | null = null;
let lastSummary: string | null = null;

/** For /health — a stalled news feed is otherwise invisible until mobile goes quiet. */
export function newsCycleHealth(): {
  last_run_at: string | null;
  age_s: number | null;
  cycles: number;
  errors: number;
  last_summary: string | null;
  last_error: string | null;
} {
  return {
    last_run_at: lastRunAt,
    age_s: lastRunAt ? Math.round((Date.now() - new Date(lastRunAt).getTime()) / 1000) : null,
    cycles: totalCycles,
    errors: totalErrors,
    last_summary: lastSummary,
    last_error: lastError,
  };
}

async function runCycle(): Promise<void> {
  if (cycleRunning) return;
  cycleRunning = true;

  const cycleStart = Date.now();
  let errored = false;
  let errorMessage: string | null = null;
  let lastPollAt: string | null = null;
  let articlesChecked: number | null = null;
  let newEvents: number | null = null;

  try {
    const status = await runNewsEventPoll({ dataDir: eventsDir(), graphPath: graphPath() });
    lastPollAt = status.lastPollAt;
    lastSummary = status.lastSummary;
    articlesChecked = status.articlesChecked;
    newEvents = status.lastNewEvents;
    if (status.lastError) {
      errored = true;
      errorMessage = status.lastError;
      console.warn(`[news] poll reported error: ${status.lastError}`);
    }

    if (status.lastNewEvents > 0) {
      console.info(`[news] ${status.lastNewEvents} new event(s) — syncing`);

      // Share the classified events themselves, so mobile/web can show a real
      // news feed rather than inferring one from downstream products.
      try {
        const stored = await listStoredEvents(eventsDir(), { days: 2 });
        await persistEventsToSupabase(stored);
      } catch (err) {
        console.warn("[news] event sync skipped:", err instanceof Error ? err.message : err);
      }

      // The graph only changes when step1 re-runs, but syncing it here keeps
      // one writer and costs a single upsert per cycle that lands new events.
      try {
        const graph = await loadGraphFile(graphPath());
        await persistGraphToSupabase(graph.edges);
      } catch (err) {
        console.warn("[news] graph sync skipped:", err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    errored = true;
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[news] cycle failed:", err instanceof Error ? err.stack ?? err.message : err);
  } finally {
    cycleRunning = false;
    totalCycles += 1;
    if (errored) totalErrors += 1;
    lastRunAt = new Date().toISOString();
    lastError = errorMessage;

    // Best-effort heartbeat — never throws.
    await persistEngineHealth({
      id: ENGINE_ID,
      status: errored ? "error" : "ok",
      startedAt: STARTED_AT,
      lastError: errorMessage,
      lastPollAt,
      lastSummary,
      articlesChecked,
      newEvents,
      eventsDeduped: null,
      cycleMs: Date.now() - cycleStart,
      pollIntervalMs: POLL_INTERVAL_MS,
      cycles: totalCycles,
      errors: totalErrors,
      version: VERSION,
    });
  }
}

/** Fire-and-forget loop, independent of the chain's own cadence. */
export function startNewsCycle(): void {
  if (!isNewsEventBackendConfigured()) {
    console.warn(
      "[news] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — events stay local-only, " +
        "the mobile feed will not advance.",
    );
  }
  console.info(`[news] cycle starting — every ${POLL_INTERVAL_MS}ms, events dir ${eventsDir()}`);

  void (async () => {
    for (;;) {
      try {
        await runCycle();
      } catch (err) {
        console.warn("[news] tick failed:", err instanceof Error ? err.message : err);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  })();
}
