/**
 * The tracked universe, read from and written to the shared `tracker_universe`
 * table with the service-role key.
 *
 * Which names the engine follows is a product decision that belongs to the
 * account, not to whichever machine happens to be running — so the service
 * takes the server list as its starting point exactly as a desktop install
 * does, and publishes anything its own discovery adds back.
 */

import { supabaseEndpoint, supabaseFetch } from "./supabase.js";

const TABLE = "tracker_universe";

export type RemoteUniverse = { active: string[]; inactive: string[] };

export async function loadRemoteUniverse(): Promise<RemoteUniverse | null> {
  if (!supabaseEndpoint()) {
    console.warn("[engine] universe: no Supabase service key — local-only");
    return null;
  }
  try {
    const res = await supabaseFetch(`${TABLE}?select=ticker,active&order=ticker.asc`);
    if (!res) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[engine] universe: HTTP ${res.status} — local-only` +
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
    console.warn(`[engine] universe: fetch failed — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function publishUniverse(tickers: string[], source: string): Promise<void> {
  if (tickers.length === 0 || !supabaseEndpoint()) return;
  const now = new Date().toISOString();
  const rows = tickers.map((ticker) => ({
    ticker: ticker.toUpperCase(),
    active: true,
    source,
    updated_at: now,
  }));
  try {
    const res = await supabaseFetch(`${TABLE}?on_conflict=ticker`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (!res?.ok) {
      console.warn(`[engine] universe: publish HTTP ${res?.status}`);
      return;
    }
    console.info(`[engine] universe: published ${rows.length} ticker(s)`);
  } catch (err) {
    console.warn(`[engine] universe: publish failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function deactivateTicker(ticker: string): Promise<void> {
  if (!supabaseEndpoint()) return;
  try {
    await supabaseFetch(`${TABLE}?ticker=eq.${encodeURIComponent(ticker.toUpperCase())}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
    });
  } catch (err) {
    console.warn(`[engine] universe: deactivate failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}
