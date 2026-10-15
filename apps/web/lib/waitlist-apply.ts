import type { User } from "@supabase/supabase-js";
import { APPLICATION_QUESTIONS, type ApplicationAnswers } from "./application-questions";

/**
 * The logic behind POST /api/waitlist, kept free of Next and of the Supabase
 * admin client so it can be tested with fakes (waitlist-apply.test.ts). The
 * route (app/api/waitlist/route.ts) is a thin wrapper that wires the real
 * admin calls in.
 *
 * Two ways in:
 *
 * - With `Authorization: Bearer <access token>`: the token is verified
 *   server-side and only the token's own user is updated (name, phone,
 *   application answers). A body email, if sent, must be that user's email.
 *   The answer carries the caller's own member number.
 *
 * - Without a token: a brand-new application. The account is created when the
 *   email is free. When the email already has an account nothing is changed,
 *   and the answer is exactly the same as for a new application, so this path
 *   can neither overwrite someone's data nor tell whether an email is taken.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_MAX = 200;
const PHONE_MAX = 40;
const PASSWORD_MAX = 72;

export const PASSWORD_RULE_MESSAGE =
  "Password must be at least 6 characters and include an uppercase letter, a lowercase letter, and a number.";

export type WaitlistApplyDeps = {
  /** Verifies a Supabase access token; null when missing, expired or revoked. */
  userFromAccessToken(token: string): Promise<User | null>;
  /** Creates the auth user (service role). Never throws for a taken email. */
  createUser(input: {
    email: string;
    password?: string;
    userMetadata: Record<string, unknown>;
  }): Promise<{ ok: true } | { ok: false; error: unknown }>;
  /** Looks an account up by email, for telling "taken" from a real failure. */
  findUserByEmail(email: string): Promise<User | null>;
  /** Replaces the user's user_metadata. */
  updateUserMetadata(userId: string, metadata: Record<string, unknown>): Promise<void>;
  memberNumberFor(email: string): Promise<number | null>;
  /**
   * Unauthenticated answers take at least this long, so a taken email (fast
   * rejection) and a new one (an insert) are harder to tell apart by timing.
   */
  minAnonymousMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type WaitlistApplyInput = {
  /** Bearer token from the request, or null. */
  token: string | null;
  /** Parsed JSON body. */
  body: unknown;
};

export type WaitlistApplyResult = {
  status: number;
  body: Record<string, unknown>;
};

/** The one answer every unauthenticated application gets, new email or not. */
export const GENERIC_APPLY_RESPONSE: WaitlistApplyResult = Object.freeze({
  status: 200,
  body: Object.freeze({ ok: true }) as Record<string, unknown>,
}) as WaitlistApplyResult;

/** Only known question ids, trimmed and length-capped, reach the metadata. */
export function sanitizeApplication(input: unknown): ApplicationAnswers | null {
  if (!input || typeof input !== "object") return null;

  const allowed = new Set<string>(["submittedAt"]);
  for (const question of APPLICATION_QUESTIONS) {
    allowed.add(question.id);
    allowed.add(`${question.id}Other`);
  }

  const clean: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!allowed.has(key) || typeof raw !== "string") continue;
    const value = raw.trim().slice(0, 2000);
    if (value) clean[key] = value;
  }

  return Object.keys(clean).length > 0 ? (clean as ApplicationAnswers) : null;
}

/** Mirrors the client-side rule on the apply and sign-up screens. */
export function passwordMeetsRule(password: string): boolean {
  return (
    password.length >= 6 &&
    password.length <= PASSWORD_MAX &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password)
  );
}

export function isDuplicateEmailError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === "email_exists" || e.code === "user_already_exists") return true;
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return (
    message.includes("already been registered") ||
    message.includes("already registered") ||
    message.includes("already exists")
  );
}

type ParsedBody = {
  name: string;
  email: string;
  password: string | null;
  phone: string | null;
  application: ApplicationAnswers | null;
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseBody(body: unknown): ParsedBody {
  const row = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const password = typeof row.password === "string" && row.password.length > 0 ? row.password : null;
  return {
    name: str(row.name).trim().slice(0, NAME_MAX),
    email: str(row.email).trim().toLowerCase(),
    password,
    phone: str(row.phone).trim().slice(0, PHONE_MAX) || null,
    // Declining the agreement still stores the application: the admin list
    // flags it rather than dropping it.
    application: sanitizeApplication(row.application),
  };
}

function badRequest(error: string): WaitlistApplyResult {
  return { status: 400, body: { error } };
}

/** The token's own user, updated in place. Never downgrades an approved user. */
async function applyForSignedInUser(
  deps: WaitlistApplyDeps,
  user: User,
  input: ParsedBody,
): Promise<WaitlistApplyResult> {
  const ownEmail = user.email?.trim().toLowerCase() ?? "";
  if (input.email && input.email !== ownEmail) {
    return { status: 403, body: { error: "This session belongs to a different account." } };
  }

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const approved = meta.approved === true || user.app_metadata?.approved === true;

  await deps.updateUserMetadata(user.id, {
    ...meta,
    full_name: input.name || (typeof meta.full_name === "string" ? meta.full_name : null),
    waitlist: approved ? meta.waitlist === true : true,
    ...(input.phone ? { phone: input.phone } : {}),
    // A re-application replaces the previous answers, never erases them.
    ...(input.application ? { application: input.application } : {}),
  });

  const memberNumber = ownEmail ? await deps.memberNumberFor(ownEmail) : null;
  return { status: 200, body: { ok: true, memberNumber } };
}

/** A new application. A taken email changes nothing and answers the same. */
async function applyAnonymously(
  deps: WaitlistApplyDeps,
  input: ParsedBody,
): Promise<WaitlistApplyResult> {
  if (!EMAIL_RE.test(input.email)) return badRequest("A valid email is required.");
  // Checked before anything touches the account store, so a weak password is
  // refused the same way whether or not the email is taken.
  if (input.password !== null && !passwordMeetsRule(input.password)) {
    return badRequest(PASSWORD_RULE_MESSAGE);
  }

  // Creating the user here (service role) needs no confirmation email, so
  // joining never depends on the mail provider.
  const created = await deps.createUser({
    email: input.email,
    // Set when the visitor chose credentials, so they can sign in later.
    ...(input.password ? { password: input.password } : {}),
    userMetadata: {
      full_name: input.name || null,
      waitlist: true,
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.application ? { application: input.application } : {}),
    },
  });
  if (created.ok) return GENERIC_APPLY_RESPONSE;

  // Taken email: leave the account exactly as it is. Its owner updates it
  // with their own session (the Bearer path above).
  if (isDuplicateEmailError(created.error)) return GENERIC_APPLY_RESPONSE;
  if (await deps.findUserByEmail(input.email)) return GENERIC_APPLY_RESPONSE;

  throw created.error instanceof Error
    ? created.error
    : new Error("Failed to create waitlist entry.");
}

export async function handleWaitlistApply(
  deps: WaitlistApplyDeps,
  { token, body }: WaitlistApplyInput,
): Promise<WaitlistApplyResult> {
  const input = parseBody(body);

  if (token) {
    const user = await deps.userFromAccessToken(token);
    if (!user) {
      return { status: 401, body: { error: "Your session has ended. Sign in again." } };
    }
    return applyForSignedInUser(deps, user, input);
  }

  const now = deps.now ?? Date.now;
  const started = now();
  try {
    return await applyAnonymously(deps, input);
  } finally {
    const floor = deps.minAnonymousMs ?? 0;
    const wait = floor - (now() - started);
    if (wait > 0) {
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      await sleep(wait);
    }
  }
}
