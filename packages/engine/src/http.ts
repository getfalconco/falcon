/**
 * Polite HTTP for the free sources the engine reads.
 *
 * SEC asks automated clients for a descriptive User-Agent and at most 10
 * requests a second; we stay at 4 a second or less through one queue. The UA
 * is a generic app address, never a person's.
 *
 * Responses are cached on disk under packages/engine/.cache so a rerun on the
 * same day does not hit the sources again (submissions for an hour, archived
 * documents for good: an accession never changes).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const SEC_USER_AGENT = "Falcon research@getfalcon.co";
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ENGINE_ROOT = path.resolve(here, "..");
const CACHE_DIR = path.join(ENGINE_ROOT, ".cache", "http");

/** Minimum spacing between SEC requests: 4 a second at most. */
const SEC_SPACING_MS = 260;
let secChain: Promise<unknown> = Promise.resolve();
let lastSecAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function cachePath(url: string): string {
  const key = crypto.createHash("sha1").update(url).digest("hex");
  return path.join(CACHE_DIR, key.slice(0, 2), key);
}

function readCache(url: string, maxAgeMs: number): string | null {
  if (maxAgeMs <= 0) return null;
  try {
    const file = cachePath(url);
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function writeCache(url: string, body: string): void {
  try {
    const file = cachePath(url);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  } catch {
    // A cache that cannot be written only costs a refetch.
  }
}

export type FetchOptions = {
  /** How long a cached copy stays good, ms. 0 = always fetch. */
  maxAgeMs?: number;
  headers?: Record<string, string>;
};

async function fetchWithRetry(url: string, headers: Record<string, string>): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} for ${url}`);
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, url);
      return await res.text();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      lastError = err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`fetch failed for ${url}`);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

/** GET a SEC URL (data.sec.gov or www.sec.gov) through the spaced queue. */
export function secGet(url: string, opts: FetchOptions = {}): Promise<string> {
  const cached = readCache(url, opts.maxAgeMs ?? 0);
  if (cached !== null) return Promise.resolve(cached);
  const run = async () => {
    const wait = lastSecAt + SEC_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastSecAt = Date.now();
    const body = await fetchWithRetry(url, {
      "User-Agent": SEC_USER_AGENT,
      "Accept-Encoding": "gzip, deflate",
      ...opts.headers,
    });
    writeCache(url, body);
    return body;
  };
  const next = secChain.then(run, run);
  secChain = next.catch(() => undefined);
  return next;
}

/** GET any other URL (no queue), with the same disk cache. */
export async function plainGet(url: string, opts: FetchOptions = {}): Promise<string> {
  const cached = readCache(url, opts.maxAgeMs ?? 0);
  if (cached !== null) return cached;
  const body = await fetchWithRetry(url, { "User-Agent": BROWSER_USER_AGENT, ...opts.headers });
  writeCache(url, body);
  return body;
}

export const HOUR_MS = 3_600_000;
export const FOREVER_MS = 365 * 24 * HOUR_MS;
