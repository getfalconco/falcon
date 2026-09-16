import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "..");
const repoRoot = resolve(workerDir, "../..");

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function applyEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = stripQuotes(trimmed.slice(eq + 1).trim());
    if (!key || !value) continue;
    // Empty placeholders in an earlier file must not block a later real value.
    // Already-set process.env keys win (Railway / shell).
    if (!process.env[key]?.trim()) process.env[key] = value;
  }
}

/** Fill empty keys from a later file (desktop .env.local holds SnapTrade keys). */
function fillEmptyFrom(envPath: string, keys: string[]): void {
  if (!existsSync(envPath)) return;
  const want = new Set(keys);
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = stripQuotes(trimmed.slice(eq + 1).trim());
    if (!want.has(key) || !value) continue;
    if (!process.env[key]?.trim()) process.env[key] = value;
  }
}

/**
 * Load env from cwd, the worker dir, desktop, and the repo root.
 * Production injects the same names on Railway; locally they live in
 * `apps/desktop/.env` / `.env.local` and root `.env.local`.
 * `DISCORD_ERROR_LOG_WEBHOOK_URL` often lives in root `.env` / `.env.discord`.
 * Already-set process.env keys win (Railway / shell). Empty placeholders lose.
 */
export function loadEnvFile(): void {
  const seen = new Set<string>();
  // Highest priority first. Later files only fill keys that are still empty.
  const candidates = [
    join(workerDir, ".env"),
    resolve(process.cwd(), "apps/research-worker/.env"),
    resolve(process.cwd(), ".env"),
    join(repoRoot, "apps/desktop/.env"),
    join(repoRoot, "apps/desktop/.env.local"),
    join(repoRoot, ".env.local"),
    join(repoRoot, ".env"),
    join(repoRoot, ".env.discord"),
    resolve(process.cwd(), ".env.discord"),
  ];

  for (const envPath of candidates) {
    const abs = resolve(envPath);
    if (seen.has(abs)) continue;
    seen.add(abs);
    applyEnvFile(abs);
  }

  fillEmptyFrom(join(repoRoot, "apps/desktop/.env.local"), [
    "SNAPTRADE_CLIENT_ID",
    "SNAPTRADE_CONSUMER_KEY",
  ]);
}
