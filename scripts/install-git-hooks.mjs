#!/usr/bin/env node
/**
 * Point this clone at committed .githooks so Discord one-liners fire on push/pull.
 * Safe to run repeatedly (postinstall).
 */
import { execSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
  execSync("git rev-parse --git-dir", { cwd: root, stdio: "ignore" });
} catch {
  process.exit(0);
}

const hooks = ["pre-push", "post-merge"];
for (const name of hooks) {
  const p = join(root, ".githooks", name);
  if (existsSync(p)) {
    try {
      chmodSync(p, 0o755);
    } catch {
      // ignore on Windows
    }
  }
}

try {
  execSync("git config core.hooksPath .githooks", { cwd: root, stdio: "ignore" });
} catch {
  process.exit(0);
}
