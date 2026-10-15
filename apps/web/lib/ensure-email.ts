import type { User } from "@supabase/supabase-js";

/**
 * The logic behind POST /api/auth/ensure-email, kept free of Next and of the
 * Supabase admin client so it can be tested with fakes (ensure-email.test.ts).
 *
 * This route used to look an email up and mark it confirmed for any approved
 * or waitlisted account, with no proof that the caller owns the address, and
 * its answer (`not_found`, `unknown_account`, `already`, `fixed`) told anyone
 * whether an email had an account. It now works like this:
 *
 * - Without a token: nothing is looked up and nothing is changed. Every
 *   well-formed request gets the same 200 `{ ok: true, confirmed: false }`
 *   after the same minimum delay, so it cannot tell an existing email from a
 *   new one. Unconfirmed accounts confirm through the email code (OTP) step
 *   the sign-in screens already have.
 *
 * - With `Authorization: Bearer <access token>`: only the token's own account
 *   is considered. It reports `confirmed: true` when the address is already
 *   confirmed, and confirms it only when that session itself came from an
 *   email code or link (the `amr` claim), which is proof of control. A
 *   password session alone proves nothing about the mailbox.
 *
 * Current clients no longer call this route. It stays so older builds get a
 * harmless answer and fall through to their OTP step.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 320;

/**
 * Session methods that can only succeed for someone who received a message
 * at the account's address (Supabase Auth `amr` values). `oauth` is left out
 * on purpose: a provider's email claim is the provider's word, not ours.
 */
export const EMAIL_PROOF_METHODS: ReadonlySet<string> = new Set([
  "otp",
  "magiclink",
  "email/signup",
  "recovery",
  "invite",
  "email_change",
]);

export type RateLimitFn = (
  key: string,
  opts: { limit: number; windowMs: number },
) => { ok: true } | { ok: false; retryAfter: number };

export type EnsureEmailDeps = {
  /** Verifies a Supabase access token; null when missing, expired or revoked. */
  userFromAccessToken(token: string): Promise<User | null>;
  /** Sets email_confirmed_at on the account (service role). */
  confirmEmail(userId: string): Promise<void>;
  /** The shared limiter (lib/rate-limit.ts), injected for tests. */
  rateLimit: RateLimitFn;
  /** Unauthenticated answers take at least this long. */
  minAnonymousMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type EnsureEmailInput = {
  ip: string;
  /** Bearer token from the request, or null. */
  token: string | null;
  /** Parsed JSON body (null when the body was not JSON). */
  body: unknown;
};

export type EnsureEmailResult = {
  status: number;
  body: Record<string, unknown>;
  /** Seconds, set on 429 answers. */
  retryAfter?: number;
};

/** The one answer every unauthenticated request gets, account or not. */
export const GENERIC_ENSURE_EMAIL_RESPONSE: EnsureEmailResult = Object.freeze({
  status: 200,
  body: Object.freeze({ ok: true, confirmed: false }) as Record<string, unknown>,
}) as EnsureEmailResult;

export const IP_LIMIT = { limit: 15, windowMs: 60_000 } as const;
export const EMAIL_LIMIT = { limit: 6, windowMs: 10 * 60_000 } as const;

function emailFrom(body: unknown): string {
  const raw =
    body && typeof body === "object" ? (body as { email?: unknown }).email : undefined;
  return typeof raw === "string" ? raw.trim().toLowerCase().slice(0, EMAIL_MAX + 1) : "";
}

/**
 * The `amr` methods of an access token. Only called after the token was
 * verified by Supabase (userFromAccessToken), so reading the payload without
 * checking the signature again is safe here.
 */
export function sessionMethods(token: string): string[] {
  const payload = token.split(".")[1];
  if (!payload) return [];
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      amr?: unknown;
    };
    if (!Array.isArray(json.amr)) return [];
    return json.amr
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : entry && typeof entry === "object" && typeof (entry as { method?: unknown }).method === "string"
            ? (entry as { method: string }).method
            : "",
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

function tooMany(retryAfter: number): EnsureEmailResult {
  return {
    status: 429,
    retryAfter,
    body: { error: "Too many requests. Please slow down and try again shortly." },
  };
}

async function forOwnSession(
  deps: EnsureEmailDeps,
  token: string,
  email: string,
): Promise<EnsureEmailResult> {
  const user = await deps.userFromAccessToken(token);
  if (!user) return { status: 401, body: { error: "Your session has ended. Sign in again." } };

  const ownEmail = user.email?.trim().toLowerCase() ?? "";
  if (!ownEmail || (email && email !== ownEmail)) {
    return { status: 403, body: { error: "This session belongs to a different account." } };
  }

  if (user.email_confirmed_at) return { status: 200, body: { ok: true, confirmed: true } };

  const proved = sessionMethods(token).some((method) => EMAIL_PROOF_METHODS.has(method));
  if (!proved) return { status: 200, body: { ok: true, confirmed: false } };

  await deps.confirmEmail(user.id);
  return { status: 200, body: { ok: true, confirmed: true } };
}

export async function handleEnsureEmail(
  deps: EnsureEmailDeps,
  { ip, token, body }: EnsureEmailInput,
): Promise<EnsureEmailResult> {
  const perIp = deps.rateLimit(`ensure-email:${ip}`, IP_LIMIT);
  if (!perIp.ok) return tooMany(perIp.retryAfter);

  const email = emailFrom(body);

  // Per address too, so one email cannot be hammered from many IPs. Counted
  // the same way whether or not the email has an account.
  if (email) {
    const perEmail = deps.rateLimit(`ensure-email-addr:${email}`, EMAIL_LIMIT);
    if (!perEmail.ok) return tooMany(perEmail.retryAfter);
  }

  if (token) return forOwnSession(deps, token, email);

  const now = deps.now ?? Date.now;
  const started = now();
  try {
    if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
      return { status: 400, body: { error: "A valid email is required." } };
    }
    // Deliberately no lookup: see the header comment.
    return GENERIC_ENSURE_EMAIL_RESPONSE;
  } finally {
    const floor = deps.minAnonymousMs ?? 0;
    const wait = floor - (now() - started);
    if (wait > 0) {
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      await sleep(wait);
    }
  }
}
