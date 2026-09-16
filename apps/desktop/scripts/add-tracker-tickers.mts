/**
 * Add tickers to the server-authoritative Tracker universe.
 *
 *   pnpm --filter desktop tracker:add -- MU MRVL NXPI
 *   pnpm --filter desktop tracker:add -- --file tickers.txt
 *
 * Every desktop install merges this list at start, so the tickers are tracked
 * everywhere on the next launch. Existing rows are reactivated (a ticker that
 * was deactivated and is now explicitly re-added should come back).
 */
import { existsSync, readFileSync } from "node:fs";
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

function parseTickers(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--file" || arg === "-f") {
      const file = argv[++i];
      if (!file) throw new Error("--file requires a path");
      for (const line of readFileSync(path.resolve(file), "utf8").split(/\r?\n/)) {
        const t = line.replace(/#.*/, "").trim().toUpperCase();
        if (t) out.push(t);
      }
      continue;
    }
    if (arg.startsWith("-")) continue;
    out.push(arg.trim().toUpperCase());
  }
  return [...new Set(out)].filter((t) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(t) && t !== "SPY");
}

async function main(): Promise<void> {
  loadDesktopEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Missing DATABASE_URL in apps/desktop/.env");
    process.exit(1);
  }
  const tickers = parseTickers(process.argv.slice(2));
  if (tickers.length === 0) {
    console.error("Usage: tracker:add -- TICKER [TICKER...] | --file tickers.txt");
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `insert into public.tracker_universe (ticker, active, source)
       select unnest($1::text[]), true, 'manual'
       on conflict (ticker) do update
         set active = true, source = 'manual', updated_at = now()`,
      [tickers],
    );
    const { rows } = await client.query(
      `select count(*) filter (where active) as active, count(*) filter (where not active) as inactive
         from public.tracker_universe`,
    );
    console.log(`added/reactivated ${tickers.length}: ${tickers.join(", ")}`);
    console.log(`server universe now: ${rows[0].active} active, ${rows[0].inactive} inactive`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
