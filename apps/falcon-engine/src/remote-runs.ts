/**
 * The engine service's half of the shared run mirror (`propagation_runs`).
 *
 * Same table and same document shape the desktop reads — this is the writer
 * that keeps producing when no desktop is open, which is the whole point of
 * moving the chain here. Pushes are queued and retried rather than awaited:
 * a run that reaches the local store must not be lost because Supabase was
 * briefly unreachable, and the cycle must not block on the network.
 */

import type { PropagationRun, RemoteRuns } from "@meridian/research/propagation/engine";
import { supabaseEndpoint, supabaseFetch } from "./supabase.js";

const TABLE = "propagation_runs";
/** Runs older than this are not pulled — the cards only show current ones. */
const PULL_DAYS = 120;
const RETRY_MS = 30_000;

const pending = new Map<string, PropagationRun>();
let flushTimer: NodeJS.Timeout | null = null;

export async function pullRemoteRuns(): Promise<PropagationRun[] | null> {
  if (!supabaseEndpoint()) {
    console.warn("[engine] runs mirror: no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — local-only");
    return null;
  }
  const since = new Date(Date.now() - PULL_DAYS * 86_400_000).toISOString();
  try {
    const res = await supabaseFetch(
      `${TABLE}?select=run&produced_at=gte.${encodeURIComponent(since)}&order=produced_at.desc&limit=500`,
    );
    if (!res) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[engine] runs mirror: HTTP ${res.status} — local-only` +
          (res.status === 404 || /relation .* does not exist/i.test(body)
            ? " (table propagation_runs missing: apply apps/desktop/supabase/propagation_runs.sql)"
            : ""),
      );
      return null;
    }
    const rows = (await res.json()) as Array<{ run: unknown }>;
    const runs: PropagationRun[] = [];
    for (const row of rows) {
      const run = row?.run as PropagationRun | undefined;
      if (run && typeof run === "object" && typeof run.run_id === "string" && run.run_id) runs.push(run);
    }
    return runs;
  } catch (err) {
    console.warn(`[engine] runs mirror: pull failed — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function pushRemoteRuns(runs: PropagationRun[], source: string): void {
  for (const run of runs) {
    // Fixture runs are never shared — they are not in anyone’s rubric.
    if (run?.synthetic) continue;
    if (run && typeof run.run_id === "string" && run.run_id) pending.set(run.run_id, run);
  }
  if (pending.size === 0) return;
  void flushPendingRunWrites(source);
}

export async function flushPendingRunWrites(source = "engine"): Promise<void> {
  if (pending.size === 0 || !supabaseEndpoint()) return;
  const batch = [...pending.values()];
  // The columns the table actually has (apps/desktop/supabase/propagation_runs.sql):
  // `superseded` is a boolean, not the id, and the writer is `pushed_by`. The
  // document in `run` is the whole truth; these are the fields queries filter on.
  const rows = batch.map((run) => ({
    run_id: run.run_id,
    incident_id: run.incident_id,
    root_ticker: run.root_ticker,
    produced_at: run.produced_at,
    superseded: run.superseded_by != null,
    synthetic: run.synthetic === true,
    run,
    pushed_by: source,
    updated_at: new Date().toISOString(),
  }));
  try {
    const res = await supabaseFetch(`${TABLE}?on_conflict=run_id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (res?.ok) {
      for (const run of batch) pending.delete(run.run_id);
      console.info(`[engine] runs mirror: pushed ${batch.length} run(s)`);
      return;
    }
    const body = await res?.text().catch(() => "");
    console.warn(`[engine] runs mirror: push HTTP ${res?.status} ${String(body).slice(0, 200)} — will retry`);
  } catch (err) {
    console.warn(`[engine] runs mirror: push failed — ${err instanceof Error ? err.message : String(err)}`);
  }
  // Anything still pending is retried on a timer; the queue is keyed by run_id,
  // so a retry can never duplicate a run.
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushPendingRunWrites(source);
    }, RETRY_MS);
    flushTimer.unref?.();
  }
}

export function pendingRunWrites(): number {
  return pending.size;
}

/** The `RemoteRuns` seam the shared Propagation host is wired to. */
export const remoteRuns: RemoteRuns = {
  pull: () => pullRemoteRuns(),
  push: (runs, source) => pushRemoteRuns(runs, source === "host" ? "engine" : source),
};
