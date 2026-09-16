import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal .env loader (no dependency). On Railway, env vars are injected by the
 * platform so no file exists — this just helps local `pnpm --filter falcon-engine dev`.
 */
export function loadEnvFile(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "apps/falcon-engine/.env"),
    resolve(process.cwd(), "apps/desktop/.env"),
    resolve(process.cwd(), "../desktop/.env"),
  ];

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;

    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    break;
  }
}
