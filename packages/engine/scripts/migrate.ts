/**
 * Applies the sightings_cards migrations, in order, to the Supabase database
 * in DATABASE_URL (from the environment or apps/web/.env.local). The SQL is
 * idempotent (create/add ... if not exists), so the daily workflow runs it
 * before every run.
 *
 *   pnpm --filter @falcon/engine run migrate
 */

import fs from "node:fs";
import path from "node:path";
import { env } from "../src/env.ts";
import { ENGINE_ROOT } from "../src/http.ts";
import { runSql } from "../src/supabase.ts";

const DIR = path.resolve(ENGINE_ROOT, "..", "..", "apps", "web", "supabase", "migrations");
const FILES = ["20261112_sightings_cards.sql", "20261113_sightings_cards_stale.sql"];

async function main() {
  const url = env("DATABASE_URL");
  if (!url) throw new Error("DATABASE_URL is not set (environment or apps/web/.env.local)");
  for (const name of FILES) {
    await runSql(url, fs.readFileSync(path.join(DIR, name), "utf8"));
    console.log(`applied ${name}`);
  }
}

main().catch((err) => {
  // pg errors can carry the connection string in some messages; print only the message class and code.
  const e = err as { code?: string; message?: string };
  const msg = (e.message ?? String(err)).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***");
  console.error(`migration failed${e.code ? ` (${e.code})` : ""}: ${msg}`);
  process.exit(1);
});
