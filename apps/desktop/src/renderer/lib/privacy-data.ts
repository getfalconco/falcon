import type { User } from "@supabase/supabase-js";
import type { CloudTableExport, PrivacyExportRendererPart } from "../../shared/privacy-types";
import { supabase } from "@/lib/supabase";
import { snapshotBrowserStorage } from "@/lib/browser-storage";
import { readAllPages } from "@/lib/table-pages";

/**
 * The renderer's half of Settings → Privacy: what the app keeps in its browser
 * storage, and the account's rows Supabase lets this session read. The main
 * process adds the files on disk (main/privacy) and writes the export.
 */

/**
 * The account's tables, as the app writes them (lib/portfolio-sync,
 * lib/broker-links, lib/research-jobs, main/onboarding), each with the unique
 * column its rows are paged on. Each is read with the session's own rights,
 * so a table RLS keeps from the renderer comes back as an error in the export
 * rather than being left out silently.
 */
const TABLE_KEYS = {
  paper_portfolios: "user_id",
  portfolio_snapshots: "id",
  broker_links: "user_id",
  research_jobs: "id",
  onboarding_responses: "id",
} as const;

export const ACCOUNT_TABLES = Object.keys(TABLE_KEYS) as Array<keyof typeof TABLE_KEYS>;

/** Every row of the table under this account, page by page (lib/table-pages). */
async function readTable(table: keyof typeof TABLE_KEYS, userId: string): Promise<CloudTableExport> {
  const client = supabase;
  if (!client) return { error: "Supabase is not configured in this build" };
  const key = TABLE_KEYS[table];
  return readAllPages(async (after, size) => {
    let query = client.from(table).select("*").eq("user_id", userId);
    if (after !== null) query = query.gt(key, after);
    const { data, error } = await query.order(key, { ascending: true }).limit(size);
    if (error) return { error: error.message };
    return { rows: (data ?? []) as Array<Record<string, unknown>> };
  }, key);
}

/** The account as the session knows it: who, and what Falcon keeps in its metadata. */
function accountRecord(user: User): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email ?? null,
    created_at: user.created_at,
    last_sign_in_at: user.last_sign_in_at ?? null,
    profile: user.user_metadata ?? {},
    access: user.app_metadata ?? {},
  };
}

export async function gatherRendererExport(user: User | null): Promise<PrivacyExportRendererPart> {
  let browserStorage: Record<string, string> = {};
  try {
    browserStorage = snapshotBrowserStorage(window.localStorage);
  } catch {
    // Storage can be unavailable; the export still carries the rest.
  }
  const cloud: Record<string, CloudTableExport> = {};
  if (user) {
    const results = await Promise.all(ACCOUNT_TABLES.map((t) => readTable(t, user.id)));
    ACCOUNT_TABLES.forEach((t, i) => {
      cloud[t] = results[i]!;
    });
  }
  return { account: user ? accountRecord(user) : null, browserStorage, cloud };
}

/**
 * Research jobs recorded under this account — the rows the research worker
 * writes when it starts one, and the app writes when a local run finishes
 * (lib/research-jobs). The same table the worker's research allowance counts.
 */
export async function countAccountResearch(
  userId: string,
  monthStart: Date,
): Promise<{ ok: true; total: number; thisMonth: number } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: "Supabase is not configured in this build" };
  try {
    const base = () =>
      supabase!.from("research_jobs").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("kind", "step1");
    const [all, month] = await Promise.all([base(), base().gte("created_at", monthStart.toISOString())]);
    const error = all.error ?? month.error;
    if (error) return { ok: false, error: error.message };
    return { ok: true, total: all.count ?? 0, thisMonth: month.count ?? 0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The session's access token, for main-process calls that act as this account. */
export async function currentAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}
