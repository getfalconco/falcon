/**
 * Applies the sightings_cards migration to the Supabase database in
 * DATABASE_URL (from the environment or apps/web/.env.local). The SQL is
 * idempotent (create ... if not exists).
 *
 *   pnpm --filter @falcon/engine run migrate
 */

import fs from "node:fs";
import path from "node:path";
import { env } from "../src/env.ts";
import { ENGINE_ROOT } from "../src/http.ts";
import { runSql } from "../src/supabase.ts";

const FILE = path.resolve(ENGINE_ROOT, "..", "..", "apps", "web", "supabase", "migrations", "20261112_sightings_cards.sql");

async function main() {
  const url = env("DATABASE_URL");
  if (!url) throw new Error("DATABASE_URL is not set (environment or apps/web/.env.local)");
  await runSql(url, fs.readFileSync(FILE, "utf8"));
  console.log(`applied ${path.basename(FILE)}`);
}

main().catch((err) => {
  // pg errors can carry the connection string in some messages; print only the message class and code.
  const e = err as { code?: string; message?: string };
  const msg = (e.message ?? String(err)).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***");
  console.error(`migration failed${e.code ? ` (${e.code})` : ""}: ${msg}`);
  process.exit(1);
});
