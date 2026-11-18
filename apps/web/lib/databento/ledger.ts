/**
 * The persistent Databento spend ledger, Supabase public.options_spend
 * (migration apps/web/supabase/migrations/20261119_options_daily.sql): one
 * row per charge or refund, the same table and columns the engine's daily
 * options job writes (packages/engine/src/options/store.ts), so one monthly
 * cap can see every Databento dollar. Read and written with the service role
 * over PostgREST (plain fetch, no extra client), never from the browser.
 *
 * Month = UTC calendar month, as the engine's monthBounds. Server-only.
 */

export type SpendLine = {
  at: string;
  caller: string;
  kind: "charge" | "refund";
  dataset: string;
  schema: string;
  symbols: number;
  start_at: string;
  end_at: string;
  cost_usd: number;
  key: string;
  note: string | null;
};

const PAGE = 1000;
const MAX_PAGES = 60;

function config(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? { url, key } : null;
}

export function ledgerConfigured(): boolean {
  return config() !== null;
}

export function monthBounds(nowMs: number): { month: string; start: string; end: string } {
  const d = new Date(nowMs);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { month: start.toISOString().slice(0, 7), start: start.toISOString(), end: end.toISOString() };
}

function headers(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json", ...extra };
}

export class LedgerError extends Error {}

/**
 * This UTC month's spend: every caller (`totalUsd`) and the callers whose
 * name starts with `prefix` (`callerUsd`). Pages through the rows (PostgREST
 * aggregates are off), first page with an exact count, the rest in parallel.
 */
export async function monthSpend(prefix: string, nowMs: number, signal?: AbortSignal): Promise<{ totalUsd: number; callerUsd: number; rows: number }> {
  const c = config();
  if (!c) throw new LedgerError("spend ledger not configured");
  const { start, end } = monthBounds(nowMs);
  const base = `${c.url}/rest/v1/options_spend?select=caller,cost_usd&at=gte.${encodeURIComponent(start)}&at=lt.${encodeURIComponent(end)}&order=id.asc`;
  const page = async (from: number, count: boolean) => {
    const res = await fetch(base, {
      headers: headers(c.key, { "Range-Unit": "items", Range: `${from}-${from + PAGE - 1}`, ...(count ? { Prefer: "count=exact" } : {}) }),
      signal,
    });
    if (!res.ok && res.status !== 206) throw new LedgerError(`spend ledger HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ caller: string; cost_usd: number }>;
    const total = Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1] ?? NaN);
    return { rows, total };
  };
  const first = await page(0, true);
  const all = [...first.rows];
  const total = Number.isFinite(first.total) ? first.total : first.rows.length;
  if (total > PAGE * MAX_PAGES) throw new LedgerError("spend ledger too large to read");
  const rest = await Promise.all(Array.from({ length: Math.max(0, Math.ceil(total / PAGE) - 1) }, (_, i) => page((i + 1) * PAGE, false)));
  for (const r of rest) all.push(...r.rows);
  let totalUsd = 0;
  let callerUsd = 0;
  for (const r of all) {
    const v = Number(r.cost_usd);
    if (!Number.isFinite(v)) continue;
    totalUsd += v;
    if (String(r.caller).startsWith(prefix)) callerUsd += v;
  }
  return { totalUsd, callerUsd, rows: all.length };
}

/** Appends ledger lines (duplicates of (caller, key, kind, at) are ignored). */
export async function appendSpend(lines: readonly SpendLine[], signal?: AbortSignal): Promise<void> {
  if (!lines.length) return;
  const c = config();
  if (!c) throw new LedgerError("spend ledger not configured");
  const res = await fetch(`${c.url}/rest/v1/options_spend?on_conflict=caller,key,kind,at`, {
    method: "POST",
    headers: headers(c.key, { "Content-Type": "application/json", Prefer: "return=minimal,resolution=ignore-duplicates" }),
    body: JSON.stringify(lines),
    signal,
  });
  if (!res.ok) throw new LedgerError(`spend ledger write HTTP ${res.status}`);
}
