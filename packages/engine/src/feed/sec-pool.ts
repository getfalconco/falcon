/**
 * Bulk SEC archive reads with several requests in flight.
 *
 * `secGet` (src/http.ts) runs one request at a time, so its real rate is one
 * per round trip (about 1/s from here, measured 2026-11-14: 0.8 to 1.0 s per
 * archive read), not the 4/s its spacing allows. A week of Form 4s (about
 * 2,600 submission texts) would take 45+ minutes that way. This pool starts
 * requests at most SEC_POOL_RATE a second with up to SEC_POOL_IN_FLIGHT open
 * at once, which, together with the secGet queue (4/s) running beside it,
 * stays under SEC's 10 requests a second. Same User-Agent, same retries
 * policy, and the same on-disk cache as secGet (same key and layout), so a
 * document read by either is never read again.
 *
 * Suggested change to src/http.ts (owned elsewhere): space request starts
 * instead of whole requests, with a small in-flight cap; then this file can
 * go.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { backoffMs, ENGINE_ROOT, HttpError, MAX_ATTEMPTS, retryableStatus, SEC_USER_AGENT } from "../http.ts";

export const SEC_POOL_RATE = 6;
export const SEC_POOL_IN_FLIGHT = 8;

/** FALCON_SEC_POOL_CACHE points the pool at another cache folder (to time a cold run). */
const CACHE_DIR = process.env.FALCON_SEC_POOL_CACHE || path.join(ENGINE_ROOT, ".cache", "http");

function cachePath(url: string): string {
  const key = crypto.createHash("sha1").update(url).digest("hex");
  return path.join(CACHE_DIR, key.slice(0, 2), key);
}

function readCache(url: string, maxAgeMs: number): string | null {
  try {
    const file = cachePath(url);
    if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) return null;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let nextStartAt = 0;
let inFlight = 0;
const waiters: Array<() => void> = [];

async function slot(): Promise<void> {
  while (inFlight >= SEC_POOL_IN_FLIGHT) await new Promise<void>((r) => waiters.push(r));
  inFlight++;
  const now = Date.now();
  const at = Math.max(now, nextStartAt);
  nextStartAt = at + Math.ceil(1000 / SEC_POOL_RATE);
  if (at > now) await sleep(at - now);
}

function release(): void {
  inFlight--;
  waiters.shift()?.();
}

export const poolStats = { network: 0, cached: 0, retries: 0 };

/** GET a sec.gov URL through the pool, cached on disk for `maxAgeMs`. */
export async function secPoolGet(url: string, maxAgeMs: number): Promise<string> {
  const cached = readCache(url, maxAgeMs);
  if (cached !== null) {
    poolStats.cached++;
    return cached;
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      poolStats.retries++;
      await sleep(backoffMs(attempt - 1, (lastError as { retryAfter?: string | null })?.retryAfter ?? null));
    }
    await slot();
    try {
      poolStats.network++;
      const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        const err = new HttpError(res.status, url, res.headers.get("retry-after"));
        if (!retryableStatus(res.status)) throw err;
        lastError = err;
        continue;
      }
      const body = await res.text();
      writeCache(url, body);
      return body;
    } catch (err) {
      if (err instanceof HttpError && !retryableStatus(err.status)) throw err;
      lastError = err;
    } finally {
      release();
    }
  }
  throw new Error(`gave up after ${MAX_ATTEMPTS} tries: ${lastError instanceof Error ? lastError.message : String(lastError)} (${url})`);
}
