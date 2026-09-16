import { NextResponse } from "next/server";

/**
 * Best-effort in-memory rate limiter for unauthenticated API routes.
 *
 * These routes (waitlist, ensure-email, falcon-error, admin login) take no auth
 * and several page through every Supabase user on each call, so without a limit
 * a single client can brute-force the admin password or amplify a cheap request
 * into an expensive one. The state is per server instance — on a serverless
 * platform (Netlify) that means the ceiling is per warm lambda, not global — but
 * it still raises the bar for scripted abuse without adding external infra.
 * Swap in a shared store (Upstash/Redis) if a hard global limit is required.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  // forEach avoids the downlevel-iteration requirement of `for..of` over a Map.
  buckets.forEach((bucket, key) => {
    if (bucket.resetAt <= now) buckets.delete(key);
  });
}

/** Derive the caller IP from the platform/proxy headers (Netlify, generic). */
export function clientIp(request: Request): string {
  const h = request.headers;
  const candidates = [
    h.get("x-nf-client-connection-ip"),
    h.get("x-real-ip"),
    h.get("x-forwarded-for")?.split(",")[0],
    h.get("cf-connecting-ip"),
  ];
  for (const candidate of candidates) {
    const ip = candidate?.trim();
    if (ip) return ip;
  }
  return "unknown";
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number };

/**
 * Fixed-window counter. Returns `ok:false` with a `retryAfter` (seconds) once
 * `limit` hits are seen for `key` inside `windowMs`.
 */
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

/** Standard 429 response, preserving any caller headers (e.g. CORS). */
export function tooManyRequests(
  retryAfter: number,
  extraHeaders?: Record<string, string>,
): NextResponse {
  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfter), ...(extraHeaders ?? {}) },
    },
  );
}
