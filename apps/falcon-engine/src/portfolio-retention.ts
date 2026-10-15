/**
 * Retention for `portfolio_snapshots`: downsample old rows in place.
 *
 * Thresholds live in snapshot-policy.ts (SNAPSHOT_RETENTION): rows older than
 * a day keep one per minute, older than a week one per hour, older than 90
 * days one per day. The last row of every bucket survives, so the chart's
 * long views keep each period's closing value.
 *
 * How: for every user with rows old enough to thin, page through those rows
 * oldest first with the service-role key, and delete the non-keepers in small
 * `id=in.(…)` batches. Every DELETE also filters on `user_id`, and this job
 * touches no other table. Idempotent: a second run over the same rows deletes
 * nothing. Bounded: a run stops after MAX_DELETES_PER_RUN and the next run
 * (scheduled sooner when a backlog remains) carries on where the data is.
 *
 * Index: both the per-user keyset walk and the distinct-user walk are range
 * scans on `(user_id, ts, id)`, added by
 * apps/web/supabase/migrations/20261015_portfolio_snapshots_retention.sql.
 * Without it the existing `(user_id, ts desc)` index still serves the walk,
 * with an extra sort on the id tie-break.
 */

import { DownsampleWalker, SNAPSHOT_RETENTION, type SnapshotRowRef } from "./snapshot-policy.js";
import { supabaseEndpoint, supabaseHeaders, type SupabaseEndpoint } from "./supabase.js";

/** Normal cadence, and the first run after boot. */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60_000;
export const RETENTION_FIRST_RUN_DELAY_MS = 10 * 60_000;
/** When a run stopped at its cap, the next one comes this soon. */
export const RETENTION_BACKLOG_INTERVAL_MS = 10 * 60_000;
/** Rows read per page (PostgREST's default max-rows is 1000). */
export const RETENTION_PAGE_SIZE = 1000;
/** Ids per DELETE request. */
export const RETENTION_DELETE_BATCH = 200;
/** Pause between DELETE requests, so the job never competes with live traffic. */
export const RETENTION_DELETE_PAUSE_MS = 100;
/** Hard ceiling per run. */
export const MAX_DELETES_PER_RUN = 100_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The REST surface the job needs, injectable for tests. */
export type RetentionClient = {
  /** Next user id (ascending) after `after` that has a row older than `before`. */
  nextUser(after: string | null, before: string): Promise<string | null>;
  /** Up to `limit` rows of `userId` older than `before`, ascending (ts, id), after the cursor. */
  page(userId: string, before: string, cursor: SnapshotRowRef | null, limit: number): Promise<SnapshotRowRef[]>;
  /** Delete these ids of `userId`. */
  remove(userId: string, ids: number[]): Promise<void>;
};

export type RetentionSummary = {
  users: number;
  scanned: number;
  deleted: number;
  capped: boolean;
  ms: number;
};

/** One retention pass. Pure orchestration over a client; never throws past a failed request. */
export async function runSnapshotRetention(
  client: RetentionClient,
  options: { now?: number; maxDeletes?: number; pageSize?: number; batch?: number; pauseMs?: number } = {},
): Promise<RetentionSummary> {
  const started = Date.now();
  const now = options.now ?? started;
  const maxDeletes = options.maxDeletes ?? MAX_DELETES_PER_RUN;
  const pageSize = options.pageSize ?? RETENTION_PAGE_SIZE;
  const batch = options.batch ?? RETENTION_DELETE_BATCH;
  const pauseMs = options.pauseMs ?? RETENTION_DELETE_PAUSE_MS;
  // Only rows past the youngest threshold can be thinned.
  const before = new Date(now - SNAPSHOT_RETENTION.minuteAfterMs).toISOString();

  const summary: RetentionSummary = { users: 0, scanned: 0, deleted: 0, capped: false, ms: 0 };
  let user: string | null = null;
  outer: for (;;) {
    user = await client.nextUser(user, before);
    if (!user) break;
    summary.users += 1;
    const walker = new DownsampleWalker(now);
    let cursor: SnapshotRowRef | null = null;
    let pending: number[] = [];
    const flush = async (): Promise<void> => {
      while (pending.length > 0) {
        const chunk = pending.slice(0, batch);
        pending = pending.slice(batch);
        await client.remove(user as string, chunk);
        summary.deleted += chunk.length;
        if (pauseMs > 0) await sleep(pauseMs);
      }
    };
    for (;;) {
      const rows = await client.page(user, before, cursor, pageSize);
      if (rows.length === 0) break;
      summary.scanned += rows.length;
      // The cursor is keyset on (ts, id), so deleting rows behind it never
      // shifts the next page.
      cursor = rows[rows.length - 1];
      pending.push(...walker.feed(rows));
      const room = maxDeletes - summary.deleted;
      if (pending.length >= room) {
        pending = pending.slice(0, Math.max(0, room));
        await flush();
        summary.capped = true;
        break outer;
      }
      if (pending.length >= batch) await flush();
      if (rows.length < pageSize) break;
    }
    await flush();
  }
  summary.ms = Date.now() - started;
  return summary;
}

// ---------------------------------------------------------------------------
// Supabase REST client (service role)
// ---------------------------------------------------------------------------

const TABLE = "portfolio_snapshots";

async function rest(ep: SupabaseEndpoint, path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${ep.url}/rest/v1/${path}`, {
      ...init,
      signal: controller.signal,
      headers: supabaseHeaders(ep, (init.headers as Record<string, string>) ?? {}),
    });
    if (!res.ok) {
      throw new Error(`${init.method ?? "GET"} ${TABLE} ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export function supabaseRetentionClient(ep: SupabaseEndpoint): RetentionClient {
  return {
    async nextUser(after, before) {
      const q = new URLSearchParams({ select: "user_id", ts: `lt.${before}`, order: "user_id.asc", limit: "1" });
      if (after) q.append("user_id", `gt.${after}`);
      const rows = (await (await rest(ep, `${TABLE}?${q}`)).json()) as Array<{ user_id?: string }>;
      return rows[0]?.user_id ?? null;
    },
    async page(userId, before, cursor, limit) {
      const q = new URLSearchParams({
        select: "id,ts",
        user_id: `eq.${userId}`,
        ts: `lt.${before}`,
        order: "ts.asc,id.asc",
        limit: String(limit),
      });
      if (cursor) {
        // Keyset on (ts, id). The plain `ts >= cursor` bound is what lets the
        // index start the scan at the cursor instead of re-reading every page
        // before it; the `or` only breaks ties at the cursor's own timestamp.
        // Quoted: a timestamp carries ':' and '+', which the logic-tree parser reserves.
        q.append("ts", `gte.${cursor.ts}`);
        q.append("or", `(ts.gt."${cursor.ts}",and(ts.eq."${cursor.ts}",id.gt.${cursor.id}))`);
      }
      const rows = (await (await rest(ep, `${TABLE}?${q}`)).json()) as Array<{ id?: number; ts?: string }>;
      return rows
        .filter((r): r is { id: number; ts: string } => typeof r.id === "number" && typeof r.ts === "string")
        .map((r) => ({ id: r.id, ts: r.ts }));
    },
    async remove(userId, ids) {
      if (ids.length === 0) return;
      const q = new URLSearchParams({ user_id: `eq.${userId}`, id: `in.(${ids.join(",")})` });
      await rest(ep, `${TABLE}?${q}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    },
  };
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

let lastRun: (RetentionSummary & { at: string }) | null = null;
let lastError: string | null = null;

export function snapshotRetentionHealth(): { last_run: (RetentionSummary & { at: string }) | null; last_error: string | null } {
  return { last_run: lastRun, last_error: lastError };
}

/** Fire-and-forget: first pass shortly after boot, then every few hours. */
export function startSnapshotRetention(): void {
  const ep = supabaseEndpoint();
  if (!ep) {
    console.info("[retention] supabase not configured — portfolio snapshot retention off");
    return;
  }
  const client = supabaseRetentionClient(ep);
  const tick = async (): Promise<void> => {
    let next = RETENTION_INTERVAL_MS;
    try {
      const summary = await runSnapshotRetention(client);
      lastRun = { ...summary, at: new Date().toISOString() };
      lastError = null;
      console.info(
        `[retention] portfolio_snapshots: ${summary.deleted} row(s) thinned across ${summary.users} user(s), ` +
          `${summary.scanned} scanned in ${summary.ms}ms${summary.capped ? " · cap reached, backlog remains" : ""}`,
      );
      if (summary.capped) next = RETENTION_BACKLOG_INTERVAL_MS;
    } catch (err) {
      lastError = `${new Date().toISOString()}: ${err instanceof Error ? err.message : String(err)}`;
      console.warn("[retention] pass failed:", lastError);
    }
    setTimeout(() => void tick(), next).unref?.();
  };
  setTimeout(() => void tick(), RETENTION_FIRST_RUN_DELAY_MS).unref?.();
  console.info(
    `[retention] portfolio_snapshots downsampling armed · minute>${SNAPSHOT_RETENTION.minuteAfterMs / 3_600_000}h ` +
      `hour>${SNAPSHOT_RETENTION.hourAfterMs / 86_400_000}d day>${SNAPSHOT_RETENTION.dayAfterMs / 86_400_000}d`,
  );
}
