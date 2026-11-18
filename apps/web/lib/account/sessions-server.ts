import pg from "pg";

/**
 * Reads and ends a member's Supabase auth sessions straight from Postgres
 * (auth.sessions, auth.refresh_tokens): the Supabase client has no API for
 * listing sessions. Connects with DATABASE_URL, server only. Every query is
 * scoped to the verified user id the route passes in; the listing runs in a
 * read-only transaction and never selects the IP column.
 */

let pool: pg.Pool | null = null;

function getPool(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
    pool = new pg.Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 2, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 });
    pool.on("error", () => undefined);
  }
  return pool;
}

export type SessionRow = { id: string; user_agent: string | null; created_at: Date; last_active_at: Date };

export class SessionsUnavailable extends Error {}

/** Unexpired sessions of `userId`. Throws SessionsUnavailable when the database cannot be reached or read. */
export async function listSessions(userId: string): Promise<SessionRow[]> {
  const p = getPool();
  if (!p) throw new SessionsUnavailable("no_database_url");
  let client: pg.PoolClient | null = null;
  try {
    client = await p.connect();
    await client.query("begin read only");
    // refreshed_at is a timestamp without time zone, written in UTC.
    const { rows } = await client.query<SessionRow>(
      `select id, user_agent, created_at,
              greatest(created_at, coalesce(updated_at, created_at), coalesce(refreshed_at at time zone 'UTC', created_at)) as last_active_at
         from auth.sessions
        where user_id = $1 and (not_after is null or not_after > now())
        order by last_active_at desc
        limit 50`,
      [userId],
    );
    await client.query("commit");
    return rows;
  } catch (err) {
    await client?.query("rollback").catch(() => undefined);
    throw new SessionsUnavailable(err instanceof Error && "code" in err ? String((err as { code?: unknown }).code) : "query_failed");
  } finally {
    client?.release();
  }
}

/** Ends one session of `userId` (and its refresh tokens). False when no such session belongs to them. */
export async function endSession(userId: string, sessionId: string): Promise<boolean> {
  const p = getPool();
  if (!p) throw new SessionsUnavailable("no_database_url");
  let client: pg.PoolClient | null = null;
  try {
    client = await p.connect();
    await client.query("begin");
    const owned = await client.query("select 1 from auth.sessions where id = $1 and user_id = $2 for update", [sessionId, userId]);
    if (!owned.rowCount) {
      await client.query("rollback");
      return false;
    }
    await client.query("delete from auth.refresh_tokens where session_id = $1 and user_id = $2::text", [sessionId, userId]);
    await client.query("delete from auth.sessions where id = $1 and user_id = $2", [sessionId, userId]);
    await client.query("commit");
    return true;
  } catch (err) {
    await client?.query("rollback").catch(() => undefined);
    throw new SessionsUnavailable(err instanceof Error && "code" in err ? String((err as { code?: unknown }).code) : "query_failed");
  } finally {
    client?.release();
  }
}
