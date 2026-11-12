/**
 * JSON cache: memory first, then one file per key on disk. Disk errors are
 * ignored (a read-only filesystem just means memory only).
 *
 * Where the files go (`defaultCacheDir`):
 *   1. FALCON_BACKTEST_CACHE_DIR when set;
 *   2. on serverless hosts (Netlify, AWS Lambda) the OS temp dir, the only writable place;
 *   3. otherwise packages/backtest/.cache (gitignored), found from the working directory;
 *   4. else the OS temp dir.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Entry<T> = { savedAt: number; value: T };

const MEMORY_MAX = 300;

export function defaultCacheDir(cwd = process.cwd()): string {
  const fromEnv = process.env.FALCON_BACKTEST_CACHE_DIR?.trim();
  if (fromEnv) return fromEnv;
  const tmp = path.join(os.tmpdir(), "falcon-backtest-cache");
  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT) return tmp;
  for (const dir of [cwd, path.join(cwd, "packages", "backtest"), path.join(cwd, "..", "..", "packages", "backtest")]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "@falcon/backtest") return path.join(dir, ".cache");
    } catch {
      // not here
    }
  }
  return tmp;
}

function fileName(key: string): string {
  return `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

export class JsonCache {
  private memory = new Map<string, Entry<unknown>>();

  constructor(private dir: string | null) {}

  async get<T>(key: string, maxAgeMs: number, now = Date.now()): Promise<T | null> {
    let entry = this.memory.get(key) as Entry<T> | undefined;
    if (!entry && this.dir) {
      try {
        entry = JSON.parse(await fsp.readFile(path.join(this.dir, fileName(key)), "utf8")) as Entry<T>;
        this.remember(key, entry);
      } catch {
        entry = undefined;
      }
    }
    if (!entry || typeof entry.savedAt !== "number" || now - entry.savedAt > maxAgeMs) return null;
    return entry.value;
  }

  async set<T>(key: string, value: T, now = Date.now()): Promise<void> {
    const entry: Entry<T> = { savedAt: now, value };
    this.remember(key, entry);
    if (!this.dir) return;
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      const file = path.join(this.dir, fileName(key));
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(entry));
      await fsp.rename(tmp, file);
    } catch {
      // memory only
    }
  }

  private remember(key: string, entry: Entry<unknown>): void {
    this.memory.delete(key);
    this.memory.set(key, entry);
    if (this.memory.size > MEMORY_MAX) this.memory.delete(this.memory.keys().next().value!);
  }
}
