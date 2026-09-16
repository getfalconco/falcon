import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadDesktopEnv } from "../load-desktop-env";

const { Client } = pg;

let ensured = false;

function migrationSqlPath(): string {
  const candidates = [
    path.join(process.cwd(), "apps/desktop/supabase/onboarding_responses.sql"),
    path.join(process.cwd(), "supabase/onboarding_responses.sql"),
    path.join(__dirname, "../../../supabase/onboarding_responses.sql"),
    path.join(__dirname, "../../supabase/onboarding_responses.sql"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export async function ensureOnboardingSchema(): Promise<boolean> {
  if (ensured) return true;

  loadDesktopEnv(true);

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.warn(
      "[db] DATABASE_URL not set — skipping onboarding_responses migration. Paste supabase/onboarding_responses.sql in the Supabase SQL editor.",
    );
    return false;
  }

  if (!existsSync(migrationSqlPath())) {
    console.warn("[db] onboarding_responses.sql not found — skipping migration.");
    return false;
  }

  const sql = readFileSync(migrationSqlPath(), "utf8");
  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();
    await client.query(sql);
    ensured = true;
    console.info("[db] onboarding_responses schema ensured");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[db] onboarding_responses migration failed:", message);
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
