/**
 * The Supabase side of account deletion: the `account_deletion_tasks` retry
 * queue (apps/web/supabase/migrations/20261015_account_deletion_tasks.sql)
 * and the two GoTrue calls, all over REST with the service-role key.
 *
 * fetch is injected so the queue can be driven against a fake in tests.
 */

import type { CleanupTask, DeletionQueue, PlannedTask, QueuedTask } from "./account-deletion.js";

export type SupabaseAdminConfig = { url: string; serviceKey: string; anonKey: string | null };

export function supabaseAdminConfig(): SupabaseAdminConfig | null {
  const url = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL)?.replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? null;
  return { url, serviceKey, anonKey };
}

function serviceHeaders(c: SupabaseAdminConfig): Record<string, string> {
  return { "Content-Type": "application/json", apikey: c.serviceKey, Authorization: `Bearer ${c.serviceKey}` };
}

type TaskRow = {
  id: string;
  user_id: string;
  task: CleanupTask;
  payload: Record<string, string> | null;
  attempts: number | null;
};

function fromRow(row: TaskRow): QueuedTask {
  return { id: row.id, userId: row.user_id, task: row.task, payload: row.payload ?? {}, attempts: row.attempts ?? 0 };
}

export function createDeletionQueue(config: () => SupabaseAdminConfig | null, doFetch: typeof fetch = fetch): DeletionQueue {
  const need = (): SupabaseAdminConfig => {
    const c = config();
    if (!c) throw new Error("Supabase is not configured.");
    return c;
  };
  const table = (c: SupabaseAdminConfig) => `${c.url}/rest/v1/account_deletion_tasks`;
  const patch = async (url: string, body: Record<string, unknown>, c: SupabaseAdminConfig) => {
    const res = await doFetch(url, { method: "PATCH", headers: serviceHeaders(c), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`account_deletion_tasks update failed: ${res.status}`);
  };

  return {
    async enqueue(tasks: PlannedTask[]): Promise<QueuedTask[]> {
      const c = need();
      const stamp = new Date().toISOString();
      const res = await doFetch(table(c), {
        method: "POST",
        headers: { ...serviceHeaders(c), Prefer: "return=representation" },
        body: JSON.stringify(
          tasks.map((t) => ({
            user_id: t.userId,
            task: t.task,
            payload: t.payload,
            status: "pending",
            attempts: 0,
            next_attempt_at: stamp,
          })),
        ),
      });
      if (!res.ok) throw new Error(`account_deletion_tasks insert failed: ${res.status}`);
      const rows = (await res.json()) as TaskRow[];
      if (!Array.isArray(rows) || rows.length !== tasks.length) throw new Error("account_deletion_tasks insert returned no rows");
      return rows.map(fromRow);
    },

    async complete(id: string): Promise<void> {
      const c = need();
      await patch(`${table(c)}?id=eq.${encodeURIComponent(id)}`, { status: "done", last_error: null, updated_at: new Date().toISOString() }, c);
    },

    async fail(task: QueuedTask, error: string, nextAttemptAt: Date, giveUp: boolean): Promise<void> {
      const c = need();
      await patch(
        `${table(c)}?id=eq.${encodeURIComponent(task.id)}`,
        {
          status: giveUp ? "failed" : "pending",
          attempts: task.attempts + 1,
          last_error: error.slice(0, 500),
          next_attempt_at: nextAttemptAt.toISOString(),
          updated_at: new Date().toISOString(),
        },
        c,
      );
    },

    async cancelPending(userId: string): Promise<void> {
      const c = need();
      await patch(
        `${table(c)}?user_id=eq.${encodeURIComponent(userId)}&status=eq.pending`,
        { status: "cancelled", updated_at: new Date().toISOString() },
        c,
      );
    },

    async due(now: Date, limit: number): Promise<QueuedTask[]> {
      const c = need();
      const res = await doFetch(
        `${table(c)}?status=eq.pending&next_attempt_at=lte.${encodeURIComponent(now.toISOString())}` +
          `&select=id,user_id,task,payload,attempts&order=next_attempt_at.asc&limit=${Math.max(1, Math.floor(limit))}`,
        { headers: serviceHeaders(c) },
      );
      if (!res.ok) throw new Error(`account_deletion_tasks read failed: ${res.status}`);
      return ((await res.json()) as TaskRow[]).map(fromRow);
    },
  };
}

/** Ends every session of the account the token belongs to. */
export async function signOutEverywhere(c: SupabaseAdminConfig, accessToken: string, doFetch: typeof fetch = fetch): Promise<void> {
  const res = await doFetch(`${c.url}/auth/v1/logout?scope=global`, {
    method: "POST",
    headers: { apikey: c.anonKey ?? c.serviceKey, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 401 && res.status !== 404) throw new Error(`logout failed: ${res.status}`);
}

/** Deletes the auth user; one that is already gone counts as deleted. */
export async function deleteAuthUser(c: SupabaseAdminConfig, userId: string, doFetch: typeof fetch = fetch): Promise<void> {
  const res = await doFetch(`${c.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: serviceHeaders(c),
  });
  if (!res.ok && res.status !== 404) throw new Error(`auth delete failed: ${res.status}`);
}
