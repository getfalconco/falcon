import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { logIdentity, scrubLogText, scrubLogUrl } from "@/lib/log-identity";

/**
 * Client-side Falcon errors (especially FAL-NET-01 / FAL-JOB-03) never reach
 * apps/research-worker, so Discord must be posted from this Netlify/Next route.
 *
 * Server-only webhook env (never EXPO_PUBLIC_* / NEXT_PUBLIC_*):
 *   DISCORD_ERROR_LOG_WEBHOOK_URL  — same name as research-worker / root .env
 *   FALCON_ERROR_LOG_WEBHOOK_URL   — alias if Netlify isn't using the worker name yet
 *
 * Never DISCORD_WEBHOOK_URL (that's git push/pull).
 *
 * Optional, server-only:
 *   ERROR_LOG_ID_SALT  secret used to turn the reporter's user id into a stable
 *                      pseudonym (lib/log-identity hashedUserId). Without it the
 *                      line falls back to a masked email (k***@yahoo.com).
 *
 * The line never carries a name, a full email, a token or an IP address.
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

function errorLogSalt(): string | null {
  return process.env.ERROR_LOG_ID_SALT?.trim() || null;
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

function formatLine(input: {
  code: string;
  message: string;
  ticker: string | null;
  client: string;
  apiUrl: string | null;
  who: string;
}): string {
  const parts = [input.code, `user: ${input.who}`];
  const ticker = scrubLogText(input.ticker);
  if (ticker) parts.push(`ticker: ${ticker}`);
  if (input.client) parts.push(`client: ${scrubLogText(input.client)}`);
  const api = scrubLogUrl(input.apiUrl);
  if (api) parts.push(`api: ${api}`);
  const message = scrubLogText(input.message).slice(0, 400);
  if (message) parts.push(message);
  return parts.join(" · ").slice(0, 1800);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token.length > 0 ? token : null;
}

/**
 * Unverified email a client put in the body. Only ever logged masked, and
 * names in the body are ignored outright.
 */
function emailFromBody(user: Record<string, unknown>): string | null {
  const rawEmail = typeof user.email === "string" ? user.email.trim() : "";
  return looksLikeRealEmail(rawEmail) && !isPlaceholderEmail(rawEmail)
    ? rawEmail.slice(0, 120)
    : null;
}

/** JWT identity wins. Missing admin config must not block Discord. */
async function identityFromJwt(
  request: Request,
): Promise<{ userId: string; email: string | null } | null> {
  const token = bearerToken(request);
  if (!token) return null;

  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return null;
    const email = data.user.email?.trim() || null;
    return { userId: data.user.id, email: looksLikeRealEmail(email) ? email : null };
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
  // A verified session gets the salted id tag (or its masked email without a
  // salt). An unverified body email is only ever shown masked.
  const who = fromJwt
    ? logIdentity({ userId: fromJwt.userId, email: fromJwt.email }, errorLogSalt())
    : logIdentity({ email: emailFromBody(user) }, null);
  const line = formatLine({
    code,
    message: typeof row.message === "string" ? row.message : "",
    ticker: typeof row.ticker === "string" ? row.ticker.trim().slice(0, 16) : null,
    client: typeof row.client === "string" ? row.client.trim().slice(0, 32) : "mobile",
    apiUrl: typeof row.apiUrl === "string" ? row.apiUrl.trim() : null,
    who,
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
      // No pings: client text must never reach @everyone or a role.
      body: JSON.stringify({ content: line, allowed_mentions: { parse: [] } }),
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
