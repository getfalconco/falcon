/**
 * Server mirror of propagation runs (Supabase `propagation_runs`).
 *
 * Why: runs are produced locally and lived only in each install's runs.json.
 * A fresh install opened on an empty Insight card until its own engine had
 * something to say, and no two installs saw the same network. The server copy
 * is the shared one: at start every install pulls the runs it hasn't seen and
 * merges them into its store, and every run it produces is pushed back.
 *
 * Security model — no privileged key on the desktop (same as the tracker
 * universe mirror):
 *   * reads  use the PUBLIC anon key (RLS: select for anon/authenticated)
 *   * writes use the USER's own JWT (RLS: insert/update for authenticated)
 * Both arrive from the renderer over the session bridge. Writes that happen
 * before the user is signed in wait and flush when the token shows up.
 */

import type { PropagationRun } from "@meridian/research/propagation/engine";
import { getRendererSession, onRendererSession } from "../session-bridge";

const TABLE = "propagation_runs";
const TIMEOUT_MS = 15_000;
/** Runs older than this are not pulled — the card only shows current ones. */
const PULL_DAYS = 120;

type Endpoint = { url: string; anonKey: string; accessToken: string | null };

function endpoint(): Endpoint | null {
  const session = getRendererSession();
  const url = (
    session.supabaseUrl ??
    process.env.SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    ""
  ).trim();
  const anonKey = (
    session.anonKey ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    ""
  ).trim();
  if (!url || !anonKey) return null;
  return { url: url.replace(/\/+$/, ""), anonKey, accessToken: session.accessToken };
}

function headers(ep: Endpoint, extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: ep.anonKey,
    Authorization: `Bearer ${ep.accessToken ?? ep.anonKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function withTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- reads (anon is enough) -------------------------------------------------

/**
 * Every current run on the server, newest first. Null when the server can't
 * be reached or the table isn't there yet — the caller keeps its local runs.
 */
export async function pullRemoteRuns(): Promise<PropagationRun[] | null> {
  const ep = endpoint();
  if (!ep) {
    console.warn("[propagation] runs server: no Supabase URL/anon key yet — local-only");
    return null;
  }
  const since = new Date(Date.now() - PULL_DAYS * 86_400_000).toISOString();
  try {
    const res = await withTimeout(
      `${ep.url}/rest/v1/${TABLE}?select=run&produced_at=gte.${encodeURIComponent(since)}&order=produced_at.desc&limit=500`,
      { headers: headers(ep) },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[propagation] runs server: HTTP ${res.status} — local-only` +
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
      // The document is what an install's own engine wrote; only the fields the
      // store keys on need to be present for it to be usable.
      if (run && typeof run === "object" && typeof run.run_id === "string" && run.run_id) {
        runs.push(run);
      }
    }
    return runs;
  } catch (err) {
    console.warn(
      "[propagation] runs server fetch failed — local-only:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// --- writes (authenticated) -------------------------------------------------

const pending = new Map<string, { run: PropagationRun; source: string }>();
let flushing = false;

function canWrite(): Endpoint | null {
  const ep = endpoint();
  return ep && ep.accessToken ? ep : null;
}

function toRow(run: PropagationRun, source: string) {
  return {
    run_id: run.run_id,
    incident_id: run.incident_id,
    root_ticker: run.root_ticker,
    produced_at: run.produced_at,
    superseded: run.superseded_by != null,
    synthetic: run.synthetic === true,
    run,
    pushed_by: source,
    updated_at: new Date().toISOString(),
  };
}

async function doUpsert(ep: Endpoint, batch: Array<{ run: PropagationRun; source: string }>): Promise<boolean> {
  const res = await withTimeout(`${ep.url}/rest/v1/${TABLE}?on_conflict=run_id`, {
    method: "POST",
    headers: headers(ep, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(batch.map((b) => toRow(b.run, b.source))),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`[propagation] runs server push: HTTP ${res.status} ${body.slice(0, 160)}`);
  }
  return res.ok;
}

/** Send everything that is waiting, if a user token is available. */
export async function flushPendingRunWrites(): Promise<void> {
  if (flushing) return;
  const ep = canWrite();
  if (!ep || pending.size === 0) return;
  flushing = true;
  try {
    const batch = [...pending.values()];
    // Keep the body modest: a handful of runs per request.
    for (let i = 0; i < batch.length; i += 20) {
      const slice = batch.slice(i, i + 20);
      if (await doUpsert(ep, slice)) {
        for (const b of slice) pending.delete(b.run.run_id);
      } else {
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

/**
 * Queue runs for the server. Synthetic fixture runs never leave the machine —
 * they are test data, and would show up on every other install as real.
 */
export function pushRemoteRuns(runs: PropagationRun[], source: string): void {
  for (const run of runs) {
    if (run.synthetic) continue;
    pending.set(run.run_id, { run, source });
  }
  void flushPendingRunWrites();
}

// A token arriving later (the user signs in after boot) releases the queue.
onRendererSession(() => {
  void flushPendingRunWrites();
});
