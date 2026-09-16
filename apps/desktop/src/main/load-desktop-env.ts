import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Packaged builds read no .env at all. The repo files don't ship, and the
 * cwd-relative candidates below would otherwise pick up whatever directory the
 * exe happens to be started from. Provider access in a packaged build comes
 * from the research-worker (see provider-routing.ts); anything else must be a
 * real OS environment variable.
 */
function isPackagedBuild(): boolean {
  // Avoid importing electron here: this module also runs in plain-node scripts.
  return process.env.FALCON_PACKAGED === "1" || /[\\/]app\.asar[\\/]/.test(__dirname);
}

export function loadDesktopEnv(overrideDesktop = false): void {
  if (isPackagedBuild()) return;
  const desktopDir = path.join(__dirname, "../..");
  const desktopEnv = path.join(desktopDir, ".env");
  const desktopEnvLocal = path.join(desktopDir, ".env.local");
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), ".env.local"),
    path.join(process.cwd(), "apps/desktop/.env"),
    path.join(process.cwd(), "apps/desktop/.env.local"),
    desktopEnv,
    desktopEnvLocal,
  ];

  for (const envPath of candidates) {
    loadEnvFile(envPath);
  }

  if (overrideDesktop) {
    // Tracked .env may override shared keys, but never blank out secrets
    // already set from .env.local (a bare `SOME_KEY=` in the tracked file).
    loadEnvFile(desktopEnv, true, { skipEmptyOverride: true });
    // Local secrets always win.
    loadEnvFile(desktopEnvLocal, true);
  }
}

/** `KEY="v"` and `KEY='v'` both mean v. Only a matching pair is removed, so a
 *  value that legitimately contains a quote is left alone. */
function unquote(value: string): string {
  const match = value.match(/^(["'])([\s\S]*)\1$/);
  return match ? match[2] : value;
}

function loadEnvFile(
  envPath: string,
  override = false,
  opts?: { skipEmptyOverride?: boolean },
): void {
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    // Surrounding quotes are stripped, as every other .env reader does. Writing
    // KEY="value" is the normal way to paste a credential, and keeping the
    // quotes made the value silently wrong rather than obviously wrong: a
    // quoted key came back as `invalid x-api-key` from the provider, and a
    // quoted URL threw "Invalid URL" from deep inside an SDK — neither of which
    // points anywhere near this file.
    const value = unquote(trimmed.slice(separator + 1).trim());
    if (!key) continue;

    const existing = process.env[key];
    if (override) {
      if (opts?.skipEmptyOverride && !value && existing?.trim()) continue;
      process.env[key] = value;
      continue;
    }
    if (existing === undefined) {
      process.env[key] = value;
    }
  }
}
