import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/**
 * Client-side Falcon errors (especially FAL-NET-01 / FAL-JOB-03) never reach
 * apps/research-worker, so Discord must be posted from this Netlify/Next route.
 *
 * Server-only webhook env (never EXPO_PUBLIC_* / NEXT_PUBLIC_*):
 *   DISCORD_ERROR_LOG_WEBHOOK_URL  — same name as research-worker / root .env
 *   FALCON_ERROR_LOG_WEBHOOK_URL   — alias if Netlify isn't using the worker name yet
 *
 * Never DISCORD_WEBHOOK_URL (that's git push/pull).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const SKIP_PREFIXES = ["FAL-AUTH-", "FAL-REQ-"];
const CODE_RE = /^FAL-[A-Z]+-\d+$/;
const SAMPLE_PLACEHOLDER_EMAIL = "trail@getfalcon.co";

function webhookUrl(): string {
  return (
    process.env.DISCORD_ERROR_LOG_WEBHOOK_URL?.trim() ||
    process.env.FALCON_ERROR_LOG_WEBHOOK_URL?.trim() ||
    ""
  );
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: CORS });
}

function redact(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/gi, "[webhook]")
    .replace(/\n+/g, " ")
    .trim();
}

function looksLikeSecretUrl(value: string): boolean {
  return /discord(?:app)?\.com\/api\/webhooks/i.test(value) || /sk-[A-Za-z0-9_-]{8,}/.test(value);
}

function looksLikeRealEmail(value: string | null | undefined): value is string {
  if (!value) return false;
  const email = value.trim();
  return email.includes("@") && !email.startsWith("(");
}

function isPlaceholderEmail(value: string): boolean {
  const email = value.trim();
  if (!email || email.startsWith("(")) return true;
  if (/^\(mobile/i.test(email)) return true;
  if (email.toLowerCase() === SAMPLE_PLACEHOLDER_EMAIL) return true;
  return false;
}

function displayNameFromMetadata(
  meta: Record<string, unknown> | undefined,
  email: string | null,
): string | null {
  if (meta) {
    for (const key of ["full_name", "name", "display_name"]) {
      const value = meta[key];
      if (typeof value === "string" && value.trim() && !value.trim().startsWith("(")) {
        return value.trim();
      }
    }
  }
  const local = email?.split("@")[0]?.trim();
  return local && !local.startsWith("(") ? local : null;
}

function emailFromIdentities(identities: unknown, fromJwt = false): string | null {
  if (!Array.isArray(identities)) return null;
  for (const identity of identities) {
    if (!identity || typeof identity !== "object") continue;
    const data = (identity as { identity_data?: unknown }).identity_data;
    if (!data || typeof data !== "object") continue;
    const nested = (data as { email?: unknown }).email;
    if (typeof nested !== "string" || !looksLikeRealEmail(nested)) continue;
    // Sample placeholder is only rejected on client-supplied body, not JWT lookup.
    if (!fromJwt && isPlaceholderEmail(nested)) continue;
    return nested.trim();
  }
  return null;
}

function formatLine(input: {
  code: string;
  message: string;
  ticker: string | null;
  client: string;
  apiUrl: string | null;
  name: string | null;
  email: string | null;
}): string {
  const parts = [
    input.code,
    `user: ${input.name || "(unknown)"}`,
    `email: ${input.email || "(unknown)"}`,
  ];
  if (input.ticker) parts.push(`ticker: ${input.ticker}`);
  if (input.client) parts.push(`client: ${input.client}`);
  if (input.apiUrl && !looksLikeSecretUrl(input.apiUrl)) {
    parts.push(`api: ${input.apiUrl.slice(0, 180)}`);
  }
  const message = redact(input.message).slice(0, 400);
  if (message) parts.push(message);
  return parts.join(" · ").slice(0, 1800);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token.length > 0 ? token : null;
}

function identityFromBody(user: Record<string, unknown>): {
  name: string | null;
  email: string | null;
} {
  const rawEmail = typeof user.email === "string" ? user.email.trim() : "";
  const email =
    looksLikeRealEmail(rawEmail) && !isPlaceholderEmail(rawEmail) ? rawEmail.slice(0, 120) : null;
  const rawName =
    typeof user.name === "string"
      ? user.name.trim()
      : typeof user.displayName === "string"
        ? user.displayName.trim()
        : "";
  const name = rawName && !rawName.startsWith("(") ? rawName.slice(0, 80) : null;
  return { name, email };
}

/** JWT identity wins. Missing admin config must not block Discord. */
async function identityFromJwt(
  request: Request,
): Promise<{ name: string | null; email: string | null } | null> {
  const token = bearerToken(request);
  if (!token) return null;

  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return null;

    const rawEmail =
      data.user.email?.trim() || emailFromIdentities(data.user.identities, true);
    const email = looksLikeRealEmail(rawEmail) ? rawEmail.trim().slice(0, 120) : null;
    const name = displayNameFromMetadata(
      data.user.user_metadata as Record<string, unknown> | undefined,
      email,
    );
    return { name, email };
  } catch {
    return null;
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(request: Request) {
  // Public + CORS-open relay to a Discord webhook — cap per IP to stop spam.
  const limit = rateLimit(`falcon-error:${clientIp(request)}`, {
    limit: 20,
    windowMs: 60_000,
  });
  if (!limit.ok) {
    return json({ error: "rate_limited" }, 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "unreadable" }, 400);
  }

  const row = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = typeof row.code === "string" ? row.code.trim() : "";
  if (!CODE_RE.test(code)) {
    return json({ error: "code required" }, 400);
  }
  if (SKIP_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    return json({ ok: true, skipped: true });
  }

  const user =
    row.user && typeof row.user === "object" ? (row.user as Record<string, unknown>) : {};
  const fromJwt = await identityFromJwt(request);
  const fromBody = identityFromBody(user);
  const line = formatLine({
    code,
    message: typeof row.message === "string" ? row.message : "",
    ticker: typeof row.ticker === "string" ? row.ticker.trim().slice(0, 16) : null,
    client: typeof row.client === "string" ? row.client.trim().slice(0, 32) : "mobile",
    apiUrl: typeof row.apiUrl === "string" ? row.apiUrl.trim() : null,
    name: fromJwt?.name || fromBody.name,
    email: fromJwt?.email || fromBody.email,
  });

  const hook = webhookUrl();
  if (!hook) {
    console.warn(
      "[api/falcon-error] no DISCORD_ERROR_LOG_WEBHOOK_URL or FALCON_ERROR_LOG_WEBHOOK_URL",
    );
    return json({ ok: true, forwarded: false });
  }

  try {
    const res = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: line }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[api/falcon-error] discord failed", res.status, text.slice(0, 200));
    }
  } catch (err) {
    console.warn("[api/falcon-error] discord fetch", err instanceof Error ? err.message : err);
  }

  return json({ ok: true });
}
