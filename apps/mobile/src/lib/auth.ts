import type { EmailOtpType, Session, User } from "@supabase/supabase-js";
import { requireSupabase } from "@/lib/supabase";

/**
 * Mirrors apps/web/lib/auth.ts. Same decision tree, same user-facing messages —
 * see docs/PLATFORM_PARITY.md. Sign-in on this project needs the OTP step
 * because the Supabase project has "Confirm email" enabled, so signUp alone
 * never returns a session.
 */

export type ContinueResult =
  | { type: "signed_in"; session: Session }
  | { type: "waitlist" }
  | { type: "confirm_email"; email: string };

export type VerifyOtpResult =
  | { type: "signed_in"; session: Session }
  | { type: "waitlist" }
  | { type: "set_password"; session: Session };

const SITE_URL = (process.env.EXPO_PUBLIC_SITE_URL ?? "https://getfalcon.co").replace(/\/$/, "");

/**
 * Approval is authoritative ONLY from app_metadata (service-role only).
 * user_metadata is client-writable via auth.updateUser({ data }), so trusting it
 * would let any signed-in account self-promote to approved.
 */
export function isApproved(user: User | null | undefined): boolean {
  return user?.app_metadata?.approved === true;
}

export function isWaitlistUser(user: User | null | undefined): boolean {
  if (!user) return false;
  return !isApproved(user);
}

async function resolveSessionUser(
  session: Session,
  user: User | null,
): Promise<Exclude<ContinueResult, { type: "confirm_email" }>> {
  // Waitlisted-but-not-approved accounts don't get into the product.
  if (isWaitlistUser(user)) {
    await requireSupabase().auth.signOut();
    return { type: "waitlist" };
  }
  return { type: "signed_in", session };
}

/** Confirms a known approved account's email so password auth isn't blocked. */
async function ensureEmailConfirmed(email: string): Promise<boolean> {
  try {
    const res = await fetch(`${SITE_URL}/api/auth/ensure-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { confirmed?: boolean };
    return data.confirmed === true;
  } catch {
    return false;
  }
}

/** Existing account → sign in. New email → sign up; may require OTP confirm. */
export async function continueWithEmailPassword(
  email: string,
  password: string,
): Promise<ContinueResult> {
  const client = requireSupabase();
  const trimmed = email.trim();

  await ensureEmailConfirmed(trimmed);

  const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
    email: trimmed,
    password,
  });

  if (!signInError && signInData.session) {
    return resolveSessionUser(signInData.session, signInData.user);
  }

  if (signInError) {
    const msg = signInError.message.toLowerCase();
    if (msg.includes("email not confirmed") || msg.includes("not confirmed")) {
      if (await ensureEmailConfirmed(trimmed)) {
        const retry = await client.auth.signInWithPassword({ email: trimmed, password });
        if (!retry.error && retry.data.session) {
          return resolveSessionUser(retry.data.session, retry.data.user);
        }
        throw new Error("Invalid email or password.");
      }
      await client.auth.resend({ type: "signup", email: trimmed });
      return { type: "confirm_email", email: trimmed };
    }
  }

  // No existing account — create one carrying the waitlist flag.
  const { data: signUpData, error: signUpError } = await client.auth.signUp({
    email: trimmed,
    password,
    options: { data: { waitlist: true } },
  });

  if (signUpError) {
    const message = signUpError.message.toLowerCase();
    const code = signUpError.code;

    if (
      code === "user_already_exists" ||
      code === "email_exists" ||
      message.includes("already registered") ||
      message.includes("already been registered")
    ) {
      // Stay vague about which half was wrong.
      throw new Error("Invalid email or password.");
    }

    if (code === "weak_password" || message.includes("password should")) {
      throw new Error(
        "Password must be at least 6 characters and include an uppercase letter, a lowercase letter, and a number.",
      );
    }

    throw signUpError;
  }

  // Supabase returns a user with no identities when the email already exists.
  if (signUpData.user && (signUpData.user.identities?.length ?? 0) === 0) {
    throw new Error("Invalid email or password.");
  }

  if (signUpData.session) {
    return resolveSessionUser(signUpData.session, signUpData.user);
  }

  return { type: "confirm_email", email: trimmed };
}

/** Verifies the 8-digit code, trying the plausible OTP types in turn. */
export async function verifyEmailOtp(
  email: string,
  token: string,
  type: EmailOtpType = "signup",
): Promise<VerifyOtpResult> {
  const client = requireSupabase();
  const trimmedEmail = email.trim();
  const trimmedToken = token.trim();

  const typesToTry: EmailOtpType[] =
    type === "recovery" || type === "email_change"
      ? [type]
      : ([type, "signup", "email"] as EmailOtpType[]).filter(
          (t, i, arr) => arr.indexOf(t) === i,
        );

  let lastError: unknown = null;

  for (const tryType of typesToTry) {
    const result = await client.auth.verifyOtp({
      email: trimmedEmail,
      token: trimmedToken,
      type: tryType,
    });
    if (!result.error && result.data.session) {
      if (tryType === "recovery") {
        return { type: "set_password", session: result.data.session };
      }
      return resolveSessionUser(result.data.session, result.data.user);
    }
    lastError = result.error;
  }

  const message =
    lastError instanceof Error ? lastError.message.toLowerCase() : String(lastError ?? "");
  if (message.includes("token") && (message.includes("expired") || message.includes("invalid"))) {
    throw new Error("That code is invalid or has expired.");
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("Verification succeeded but no session was created.");
}

export async function resendSignupOtp(email: string): Promise<void> {
  const { error } = await requireSupabase().auth.resend({
    type: "signup",
    email: email.trim(),
  });
  if (error) throw error;
}

export async function requestPasswordReset(email: string): Promise<void> {
  const { error } = await requireSupabase().auth.resetPasswordForEmail(email.trim());
  if (error) throw error;
}

export async function updatePassword(password: string): Promise<void> {
  const { error } = await requireSupabase().auth.updateUser({ password });
  if (error) throw error;
}

export async function requestEmailChange(newEmail: string): Promise<void> {
  const { error } = await requireSupabase().auth.updateUser({ email: newEmail.trim() });
  if (error) throw error;
}

export async function deleteAccount(): Promise<void> {
  const client = requireSupabase();
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in to continue.");

  const res = await fetch(`${SITE_URL}/api/account/delete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Could not delete the account.");
  }
  await client.auth.signOut();
}

export async function signOut(): Promise<void> {
  await requireSupabase().auth.signOut();
}
