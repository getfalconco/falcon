import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/**
 * Shared guard for /api/strategy/* (design 2.5): an Origin allowlist, per-IP
 * rate limits (per warm instance, like the other routes), body size caps and
 * JSON helpers. Auth and database quotas come with the Supabase migration.
 *
 * Allowed origins: getfalcon.co, www.getfalcon.co, app.getfalcon.co, any
 * localhost / 127.0.0.1 port (web dev and the Expo web preview), the site's
 * own host (same-origin, e.g. a deploy preview), and STRATEGY_ALLOWED_ORIGINS
 * (comma-separated). Requests without an Origin header (the native iPhone app,
 * server-to-server) pass; browsers always send one on POST.
 */

const FIXED = new Set(["https://getfalcon.co", "https://www.getfalcon.co", "https://app.getfalcon.co"]);

export function originAllowed(request: Request): { ok: boolean; origin: string | null } {
  const origin = request.headers.get("origin");
  if (!origin) return { ok: true, origin: null };
  if (FIXED.has(origin)) return { ok: true, origin };
  const extra = (process.env.STRATEGY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes(origin)) return { ok: true, origin };
  try {
    const u = new URL(origin);
    if ((u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") && (u.protocol === "http:" || u.protocol === "https:")) {
      return { ok: true, origin };
    }
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (host && u.host === host) return { ok: true, origin };
  } catch {
    // not a URL
  }
  return { ok: false, origin };
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function json(body: unknown, status = 200, origin: string | null = null, extra: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...corsHeaders(origin), "Cache-Control": "no-store", ...extra } });
}

export function preflight(request: Request) {
  const o = originAllowed(request);
  if (!o.ok) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, { status: 204, headers: corsHeaders(o.origin) });
}

export type Limits = readonly (readonly [suffix: string, limit: number, windowMs: number, perIp: boolean])[];

/** Origin, rate limits and a size-capped JSON object body. Returns the body or a response to send. */
export async function guard(
  request: Request,
  route: string,
  limits: Limits,
  maxBytes: number,
): Promise<{ ok: true; body: Record<string, unknown>; origin: string | null } | { ok: false; response: NextResponse }> {
  const o = originAllowed(request);
  if (!o.ok) return { ok: false, response: json({ error: "This origin is not allowed." }, 403) };
  const ip = clientIp(request);
  for (const [suffix, limit, windowMs, perIp] of limits) {
    const r = rateLimit(`${route}-${suffix}${perIp ? `:${ip}` : ""}`, { limit, windowMs });
    if (!r.ok) {
      return {
        ok: false,
        response: json({ error: "Too many requests in a short time. Try again in a minute." }, 429, o.origin, { "Retry-After": String(r.retryAfter) }),
      };
    }
  }
  const raw = await request.text();
  if (raw.length > maxBytes) return { ok: false, response: json({ error: "Request body is too large." }, 413, o.origin) };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return { ok: true, body: parsed as Record<string, unknown>, origin: o.origin };
  } catch {
    return { ok: false, response: json({ error: "Send a JSON object." }, 400, o.origin) };
  }
}

/** Numbers rounded for the wire: about a third of the bytes, no visible change. */
export function roundDeep<T>(value: T, digits = 6): T {
  const f = 10 ** digits;
  const go = (v: unknown): unknown => {
    if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * f) / f : null;
    if (Array.isArray(v)) return v.map(go);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, go(x)]));
    return v;
  };
  return go(value) as T;
}
