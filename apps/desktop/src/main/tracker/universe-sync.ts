/**
 * Server mirror of the Tracker universe (Supabase `tracker_universe`).
 *
 * Why: the universe used to be discovered purely from local caches. A packaged
 * install on a fresh machine has no caches, so it tracked only the user's
 * portfolio holdings. The server list is now authoritative: every install
 * pulls it at start and merges it with whatever it discovers locally, and
 * local additions/removals are pushed back so all installs converge.
 *
 * Security model — no privileged key on the desktop:
 *   * reads  use the PUBLIC anon key (RLS: select for anon/authenticated)
 *   * writes use the USER's own JWT (RLS: insert/update for authenticated)
 * Both come from the renderer over the session bridge; the env-file values
 * are only a development convenience. A service-role key is never required
 * and never read here. Writes that arrive before the user is signed in wait
 * and flush when the token shows up.
 */

import { getRendererSession, onRendererSession } from "../session-bridge";

export type RemoteUniverse = { active: string[]; inactive: string[] };

const TABLE = "tracker_universe";
const TIMEOUT_MS = 10_000;

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
    // With a user token the request runs as `authenticated`; without it, as
    // `anon` — which RLS allows for reads only.
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

/** Pull the server universe. Null when not configured / unreachable / table missing. */
export async function loadRemoteUniverse(): Promise<RemoteUniverse | null> {
  const ep = endpoint();
  if (!ep) {
    console.warn("[tracker] universe server: no Supabase URL/anon key yet — local-only");
    return null;
  }
  try {
    const res = await withTimeout(
      `${ep.url}/rest/v1/${TABLE}?select=ticker,active&order=ticker.asc`,
      { headers: headers(ep) },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[tracker] universe server: HTTP ${res.status} — local-only` +
          (res.status === 404 || /relation .* does not exist/i.test(body)
            ? " (table tracker_universe missing: apply apps/desktop/supabase/tracker_universe.sql)"
            : ""),
      );
      return null;
    }
    const rows = (await res.json()) as Array<{ ticker: string; active: boolean }>;
    const active: string[] = [];
    const inactive: string[] = [];
    for (const row of rows) {
      const t = String(row.ticker ?? "").trim().toUpperCase();
      if (!t) continue;
      (row.active ? active : inactive).push(t);
    }
    return { active, inactive };
  } catch (err) {
    console.warn("[tracker] universe server fetch failed — local-only:", err instanceof Error ? err.message : err);
    return null;
  }
}

// --- writes (authenticated) -------------------------------------------------

const pendingUpsert = new Map<string, string>(); // ticker → source
const pendingDeactivate = new Set<string>();
let flushing = false;

function canWrite(): Endpoint | null {
  const ep = endpoint();
  return ep && ep.accessToken ? ep : null;
}

async function doUpsert(ep: Endpoint, tickers: Array<[string, string]>): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = tickers.map(([ticker, source]) => ({ ticker, active: true, source, updated_at: now }));
  const res = await withTimeout(`${ep.url}/rest/v1/${TABLE}?on_conflict=ticker`, {
    method: "POST",
    headers: headers(ep, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) console.warn(`[tracker] universe server push: HTTP ${res.status}`);
  return res.ok;
}

async function doDeactivate(ep: Endpoint, ticker: string): Promise<boolean> {
  const res = await withTimeout(`${ep.url}/rest/v1/${TABLE}?ticker=eq.${encodeURIComponent(ticker)}`, {
    method: "PATCH",
    headers: headers(ep, { Prefer: "return=minimal" }),
    body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) console.warn(`[tracker] universe server deactivate ${ticker}: HTTP ${res.status}`);
  return res.ok;
}

/** Send everything that is waiting, if a user token is available. */
export async function flushPendingUniverseWrites(): Promise<void> {
  if (flushing) return;
  const ep = canWrite();
  if (!ep) return;
  flushing = true;
  try {
    if (pendingUpsert.size > 0) {
      const batch = [...pendingUpsert.entries()];
      pendingUpsert.clear();
      const ok = await doUpsert(ep, batch).catch((err) => {
        console.warn("[tracker] universe server push failed:", err instanceof Error ? err.message : err);
        return false;
      });
      if (!ok) for (const [t, s] of batch) pendingUpsert.set(t, s); // retry next flush
      else console.info(`[tracker] universe server: published ${batch.length} ticker(s)`);
    }
    for (const t of [...pendingDeactivate]) {
      const ok = await doDeactivate(ep, t).catch(() => false);
      if (ok) pendingDeactivate.delete(t);
    }
  } finally {
    flushing = false;
  }
}

/** Upsert symbols as active (queued until a user token is available). */
export function pushRemoteUniverse(tickers: string[], source: string): void {
  for (const raw of tickers) {
    const t = raw.trim().toUpperCase();
    if (!t) continue;
    pendingDeactivate.delete(t);
    pendingUpsert.set(t, source);
  }
  void flushPendingUniverseWrites();
}

/** Mark a symbol inactive server-wide (queued until a user token is available). */
export function deactivateRemoteTicker(ticker: string): void {
  const t = ticker.trim().toUpperCase();
  if (!t) return;
  pendingUpsert.delete(t);
  pendingDeactivate.add(t);
  void flushPendingUniverseWrites();
}

export function pendingUniverseWrites(): { upserts: number; deactivations: number } {
  return { upserts: pendingUpsert.size, deactivations: pendingDeactivate.size };
}

// As soon as the renderer hands over a session (sign-in / token refresh),
// drain whatever accumulated while we had no token.
onRendererSession((session) => {
  if (session.accessToken) void flushPendingUniverseWrites();
});
