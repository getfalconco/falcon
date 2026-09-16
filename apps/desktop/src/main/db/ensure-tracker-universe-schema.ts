import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadDesktopEnv } from "../load-desktop-env";

const { Client } = pg;

let ensured = false;

function migrationSqlPath(): string {
  const candidates = [
    path.join(process.cwd(), "apps/desktop/supabase/tracker_universe.sql"),
    path.join(process.cwd(), "supabase/tracker_universe.sql"),
    path.join(__dirname, "../../../supabase/tracker_universe.sql"),
    path.join(__dirname, "../../supabase/tracker_universe.sql"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/**
 * Create the `tracker_universe` table if DATABASE_URL is available (dev
 * machines). Packaged installs normally have no direct DB URL — there the
 * table is expected to exist already; the REST sync degrades to local-only
 * with a clear log line if it does not.
 */
export async function ensureTrackerUniverseSchema(): Promise<boolean> {
  if (ensured) return true;
  loadDesktopEnv(true);

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.info(
      "[db] DATABASE_URL not set — skipping tracker_universe migration (apply apps/desktop/supabase/tracker_universe.sql once in Supabase).",
    );
    return false;
  }
  const sqlPath = migrationSqlPath();
  if (!existsSync(sqlPath)) {
    console.warn("[db] tracker_universe.sql not found — skipping migration.");
    return false;
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query(readFileSync(sqlPath, "utf8"));
    ensured = true;
    console.info("[db] tracker_universe schema ensured");
    return true;
  } catch (err) {
    console.warn("[db] tracker_universe migration failed:", err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
