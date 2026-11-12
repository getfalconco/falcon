/**
 * Polite HTTP for the free sources the engine reads.
 *
 * SEC asks automated clients for a descriptive User-Agent and at most 10
 * requests a second; we stay at 4 a second or less through one queue. The UA
 * is a generic app address, never a person's. Every try, retries included,
 * goes through the queue, so retries never push the rate above that.
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
  /** When every try fails, use a cached copy of any age instead of failing (data that rarely changes). */
  staleOk?: boolean;
};

/** Statuses worth another try: timeouts, rate limits and server errors. Pure. */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Wait before retry `attempt` (0-based): exponential from `baseMs`, capped,
 * with up to 25% jitter, or the server's Retry-After when it asks for longer
 * (capped too). `random` is injectable for tests. Pure apart from it.
 */
export function backoffMs(attempt: number, retryAfter: string | null = null, baseMs = 1000, capMs = 20_000, random = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  const jittered = Math.round(exp * (1 + 0.25 * random()));
  let asked = 0;
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) asked = secs * 1000;
    else {
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) asked = at - Date.now();
    }
  }
  return Math.min(capMs, Math.max(jittered, asked));
}

export const MAX_ATTEMPTS = 4;

/**
 * GET with retries: network errors, timeouts and retryable statuses get up
 * to MAX_ATTEMPTS tries with exponential backoff; other HTTP errors fail at
 * once. `beforeAttempt` runs before every try (the SEC queue spaces each one).
 */
async function fetchWithRetry(url: string, headers: Record<string, string>, beforeAttempt?: () => Promise<void>): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt - 1, (lastError as { retryAfter?: string | null })?.retryAfter ?? null));
    if (beforeAttempt) await beforeAttempt();
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        const err = new HttpError(res.status, url, res.headers.get("retry-after"));
        if (!retryableStatus(res.status)) throw err;
        lastError = err;
        continue;
      }
      return await res.text();
    } catch (err) {
      if (err instanceof HttpError && !retryableStatus(err.status)) throw err;
      lastError = err;
    }
  }
  const why = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`gave up after ${MAX_ATTEMPTS} tries: ${why}${why.includes(url) ? "" : ` (${url})`}`);
}

/**
 * fetch() with the same retries, returning the Response (for callers that
 * need headers or cookies, like Yahoo's session). Network errors always get
 * retried; retryable statuses only when `retryStatuses` is on. The last
 * Response is returned as is, ok or not.
 */
export async function fetchResponse(url: string, init: RequestInit & { timeoutMs?: number } = {}, retryStatuses = true): Promise<Response> {
  const { timeoutMs = 15_000, ...rest } = init;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt - 1, (lastError as { retryAfter?: string | null })?.retryAfter ?? null));
    try {
      const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
      if (retryStatuses && retryableStatus(res.status) && attempt < MAX_ATTEMPTS - 1) {
        lastError = new HttpError(res.status, url, res.headers.get("retry-after"));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`fetch failed for ${url}`);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly retryAfter: string | null = null,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

/** GET a SEC URL (data.sec.gov or www.sec.gov) through the spaced queue. */
export function secGet(url: string, opts: FetchOptions = {}): Promise<string> {
  const cached = readCache(url, opts.maxAgeMs ?? 0);
  if (cached !== null) return Promise.resolve(cached);
  const spaced = async () => {
    const wait = lastSecAt + SEC_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastSecAt = Date.now();
  };
  const run = async () => {
    const body = await fetchWithRetry(
      url,
      { "User-Agent": SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate", ...opts.headers },
      spaced,
    );
    writeCache(url, body);
    return body;
  };
  const next = secChain.then(run, run);
  secChain = next.catch(() => undefined);
  if (!opts.staleOk) return next;
  return next.catch((err) => {
    const stale = readCache(url, FOREVER_MS * 10);
    if (stale !== null) return stale;
    throw err;
  });
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
