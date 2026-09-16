/**
 * Creates the `tracker_universe` table (server-authoritative Tracker universe)
 * and seeds it with every ticker this machine currently tracks, so packaged
 * installs on other machines pull the same list instead of only their own
 * portfolio holdings.
 *
 *   pnpm --filter desktop migrate:tracker-universe
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));

function loadDesktopEnv(): void {
  const envPath = path.resolve(here, "../.env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i === -1) continue;
    const key = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function localUniverse(): string[] {
  const stateDir = path.resolve(here, "../data/tracker/state");
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5).toUpperCase())
    .filter((t) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(t) && t !== "SPY")
    .sort();
}

async function main(): Promise<void> {
  loadDesktopEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Missing DATABASE_URL in apps/desktop/.env — use the Supabase pooler connection string.");
    process.exit(1);
  }

  const sql = readFileSync(path.resolve(here, "../supabase/tracker_universe.sql"), "utf8");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(sql);
    console.log("tracker_universe schema ensured");

    const tickers = localUniverse();
    if (tickers.length === 0) {
      console.log("no local tracker state found — nothing to seed");
    } else {
      // Seed as active; never flip an existing row's `active` back on here —
      // a deliberate removal elsewhere must survive a re-run of this script.
      const res = await client.query(
        `insert into public.tracker_universe (ticker, active, source)
         select unnest($1::text[]), true, 'seed'
         on conflict (ticker) do nothing`,
        [tickers],
      );
      console.log(`seeded ${res.rowCount ?? 0} new ticker(s) from ${tickers.length} local: ${tickers.join(", ")}`);
    }

    const { rows } = await client.query(
      `select count(*) filter (where active) as active, count(*) filter (where not active) as inactive from public.tracker_universe`,
    );
    console.log(`server universe now: ${rows[0].active} active, ${rows[0].inactive} inactive`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
