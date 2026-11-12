/**
 * Secrets come from the process environment first, then from the website's
 * apps/web/.env.local (never committed). Values are never printed.
 */

import fs from "node:fs";
import path from "node:path";
import { ENGINE_ROOT } from "./http.ts";

export const WEB_ENV_PATH = path.resolve(ENGINE_ROOT, "..", "..", "apps", "web", ".env.local");

/** KEY=value lines; quotes and inline comments stripped. Pure. */
export function parseEnv(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if (/^"/.test(v)) v = v.replace(/^"((?:[^"\\]|\\.)*)".*$/, "$1").replace(/\\n/g, "\n");
    else if (/^'/.test(v)) v = v.replace(/^'([^']*)'.*$/, "$1");
    else v = v.replace(/\s+#.*$/, "").trim();
    out[m[1]!] = v;
  }
  return out;
}

let fileEnv: Record<string, string> | null = null;

export function env(name: string): string | null {
  const fromProcess = process.env[name]?.trim();
  if (fromProcess) return fromProcess;
  if (fileEnv === null) {
    try {
      fileEnv = parseEnv(fs.readFileSync(WEB_ENV_PATH, "utf8"));
    } catch {
      fileEnv = {};
    }
  }
  const v = fileEnv[name]?.trim();
  return v ? v : null;
}
