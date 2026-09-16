import type { IncomingMessage } from "node:http";

/**
 * Tiny in-memory per-IP rate limiter for the compute worker's unauthenticated
 * endpoints. The provider health checks each make a real (billable) OpenAI /
 * Perplexity call, so without a cap a public URL is a cost-amplification target.
 * Per-process only — good enough for a single Railway instance; move to a shared
 * store if the worker is ever scaled out.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return first?.trim() || req.socket.remoteAddress || "unknown";
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number };

export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true };
  }

  if (bucket.count >= opts.limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  bucket.count += 1;
  return { ok: true };
}
