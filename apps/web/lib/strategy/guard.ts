import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { isApproved } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { bearerToken, userFromAccessToken } from "@/lib/waitlist-membership";

/**
 * Shared guard for /api/strategy/* and /api/help (design 2.5): an Origin
 * allowlist, a signed-in approved member (requireMember), rate limits per IP
 * and per member (per warm instance, like the other routes), body size caps
 * and JSON helpers. Database quotas come with the Supabase migration.
 *
 * Allowed origins: getfalcon.co, www.getfalcon.co, app.getfalcon.co, any
 * localhost / 127.0.0.1 port (web dev and the Expo web preview), the site's
 * own host (same-origin, e.g. a deploy preview), and STRATEGY_ALLOWED_ORIGINS
 * (comma-separated). Requests without an Origin header (the native iPhone app,
 * server-to-server) pass the origin check (they still need a member token);
 * browsers always send one on POST.
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

export const SIGN_IN_REQUIRED = "Sign in to use this.";

export type MemberCheck = { ok: true; userId: string | null } | { ok: false; status: 401 | 503; error: string };

/**
 * Who is calling: the Supabase access token in `Authorization: Bearer`,
 * verified server-side, of a member approved in app_metadata (isApproved, the
 * same rule as the /app gate). Anything else is a 401.
 *
 * The one exception is the development preview (/app?preview=1), which has no
 * Supabase user: with no token at all, a request passes only when the server
 * itself runs with NODE_ENV === "development" (`next dev`). Nothing in the
 * request (header, query, body) can turn that on, and a production build
 * always requires the token. `verify` is swappable for tests.
 */
export async function requireMember(
  request: Request,
  verify: (token: string) => Promise<User | null> = userFromAccessToken,
): Promise<MemberCheck> {
  const token = bearerToken(request);
  if (!token) {
    return process.env.NODE_ENV === "development" ? { ok: true, userId: null } : { ok: false, status: 401, error: SIGN_IN_REQUIRED };
  }
  let user: User | null;
  try {
    user = await verify(token);
  } catch (error) {
    console.error("[guard] token check failed", error instanceof Error ? error.message : "unknown");
    return { ok: false, status: 503, error: "Sign-in could not be checked right now. Try again in a minute." };
  }
  if (!user || !isApproved(user)) return { ok: false, status: 401, error: SIGN_IN_REQUIRED };
  return { ok: true, userId: user.id };
}

/** perIp: counted per IP and, once signed in, per member too; otherwise one counter for the whole instance. */
export type Limits = readonly (readonly [suffix: string, limit: number, windowMs: number, perIp: boolean])[];

/**
 * Origin, member, rate limits and a size-capped JSON object body. Returns the
 * body or a response to send. Per-IP limits run before the token check (so
 * strangers cannot make it call Supabase without limit); the per-member and
 * instance-wide limits only count members, so 401s cannot use them up.
 */
export async function guard(
  request: Request,
  route: string,
  limits: Limits,
  maxBytes: number,
): Promise<{ ok: true; body: Record<string, unknown>; origin: string | null; userId: string | null } | { ok: false; response: NextResponse }> {
  const o = originAllowed(request);
  if (!o.ok) return { ok: false, response: json({ error: "This origin is not allowed." }, 403) };
  const limited = (key: string, limit: number, windowMs: number) => {
    const r = rateLimit(key, { limit, windowMs });
    return r.ok
      ? null
      : ({
          ok: false,
          response: json({ error: "Too many requests in a short time. Try again in a minute." }, 429, o.origin, { "Retry-After": String(r.retryAfter) }),
        } as const);
  };
  const ip = clientIp(request);
  for (const [suffix, limit, windowMs, perIp] of limits) {
    const hit = perIp ? limited(`${route}-${suffix}:${ip}`, limit, windowMs) : null;
    if (hit) return hit;
  }
  const member = await requireMember(request);
  if (!member.ok) return { ok: false, response: json({ error: member.error }, member.status, o.origin) };
  for (const [suffix, limit, windowMs, perIp] of limits) {
    const key = perIp ? (member.userId ? `${route}-${suffix}:user:${member.userId}` : null) : `${route}-${suffix}`;
    const hit = key ? limited(key, limit, windowMs) : null;
    if (hit) return hit;
  }
  const raw = await request.text();
  if (raw.length > maxBytes) return { ok: false, response: json({ error: "Request body is too large." }, 413, o.origin) };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return { ok: true, body: parsed as Record<string, unknown>, origin: o.origin, userId: member.userId };
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
