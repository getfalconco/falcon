/**
 * One-off: push the runs in a local propagation store up to the Supabase
 * `propagation_runs` mirror, so every install sees them.
 *
 *   pnpm --filter desktop exec tsx scripts/seed-propagation-runs.mts
 *
 * Reads apps/desktop/.env for the project URL and a key. The table's RLS
 * allows inserts for `authenticated` users only, so either:
 *   - SUPABASE_SERVICE_ROLE_KEY  (bypasses RLS; the key never leaves this
 *     machine, it is only read here), or
 *   - SUPABASE_ACCESS_TOKEN      (a user's JWT, e.g. copied from the app's
 *     session) together with the anon key.
 *
 * Synthetic fixture runs are skipped — they are test data. Existing rows are
 * upserted on run_id, so re-running is safe.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...loadEnv(path.join(desktopRoot, ".env")), ...process.env };
const url = (env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "");
const anon = env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? "";
const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const userToken = env.SUPABASE_ACCESS_TOKEN ?? "";

if (!url) throw new Error("SUPABASE_URL / VITE_SUPABASE_URL not set");
const bearer = serviceRole || userToken;
if (!bearer) {
  throw new Error(
    "Need SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ACCESS_TOKEN to write (RLS allows authenticated only)",
  );
}
const apikey = serviceRole || anon;
if (!apikey) throw new Error("SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY not set");

const runsFile = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(desktopRoot, "data", "propagation", "runs.json");
const parsed = JSON.parse(fs.readFileSync(runsFile, "utf8")) as {
  runs?: Record<string, Record<string, unknown>>;
};
const all = Object.values(parsed.runs ?? {});
const rows = all
  .filter((r) => r && typeof r.run_id === "string" && r.synthetic !== true)
  .map((r) => ({
    run_id: r.run_id,
    incident_id: r.incident_id,
    root_ticker: r.root_ticker,
    produced_at: r.produced_at,
    superseded: r.superseded_by != null,
    synthetic: false,
    run: r,
    pushed_by: "seed",
    updated_at: new Date().toISOString(),
  }));

console.log(`source: ${runsFile}`);
console.log(`runs on disk: ${all.length}, to push: ${rows.length} (synthetic skipped: ${all.length - rows.length})`);
console.log(`auth: ${serviceRole ? "service role" : "user token"}`);

const res = await fetch(`${url}/rest/v1/propagation_runs?on_conflict=run_id`, {
  method: "POST",
  headers: {
    apikey,
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=representation",
  },
  body: JSON.stringify(rows),
});

if (!res.ok) {
  console.error(`push failed: HTTP ${res.status}`);
  console.error((await res.text()).slice(0, 600));
  process.exit(1);
}
const returned = (await res.json()) as Array<{ run_id: string; root_ticker: string }>;
console.log(`upserted ${returned.length} row(s):`);
for (const r of returned) console.log(`  ${r.root_ticker.padEnd(5)} ${r.run_id}`);
