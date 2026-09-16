import type { EmailOtpType, Session, SupabaseClient, User } from "@supabase/supabase-js";

type ContinueParams = {
  email: string;
  password: string;
};

export type ContinueResult =
  | { type: "signed_in"; session: Session }
  | { type: "waitlist" }
  | { type: "confirm_email"; email: string };

export type VerifyOtpResult =
  | { type: "signed_in"; session: Session }
  | { type: "waitlist" }
  | { type: "set_password"; session: Session };

const WAITLIST_STORAGE_KEY = "meridian-waitlist";
// Waitlist members are signed out right after auth (resolveSessionUser), so
// this is the only trace of who they are — the login screen and
// /early-access both read it to recognise them.
const WAITLIST_EMAIL_KEY = "meridian-waitlist-email";

/**
 * Approval is authoritative ONLY from app_metadata, which is service-role-only.
 * user_metadata is client-writable (auth.updateUser({ data })), so trusting it
 * for authorization would let any account self-promote to "approved".
 */
export function isApproved(user: User | null | undefined): boolean {
  return user?.app_metadata?.approved === true;
}

export function isWaitlistUser(user: User | null | undefined): boolean {
  if (!user) return false;
  // Anyone not positively approved (via app_metadata) is treated as waitlist.
  return !isApproved(user);
}

/**
 * Both values live in localStorage so a member stays recognised in a new tab
 * (and after a restart). Anything written to sessionStorage by an older build
 * is migrated on first read, then dropped.
 */
function readStored(key: string): string | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(key);
  if (stored !== null) return stored;

  const legacy = sessionStorage.getItem(key);
  if (legacy !== null) {
    localStorage.setItem(key, legacy);
    sessionStorage.removeItem(key);
  }
  return legacy;
}

function writeStored(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  if (value === null) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  } else {
    localStorage.setItem(key, value);
  }
}

export function readWaitlistFlag(): boolean {
  return readStored(WAITLIST_STORAGE_KEY) === "1";
}

export function setWaitlistFlag(active: boolean): void {
  writeStored(WAITLIST_STORAGE_KEY, active ? "1" : null);
}

export function readWaitlistEmail(): string | null {
  return readStored(WAITLIST_EMAIL_KEY);
}

export function setWaitlistEmail(email: string | null): void {
  writeStored(WAITLIST_EMAIL_KEY, email);
}

async function resolveSessionUser(
  client: SupabaseClient,
  session: Session,
  user: User | null,
): Promise<Exclude<ContinueResult, { type: "confirm_email" }>> {
  if (isWaitlistUser(user)) {
    await client.auth.signOut();
    setWaitlistFlag(true);
    return { type: "waitlist" };
  }
  setWaitlistFlag(false);
  return { type: "signed_in", session };
}

async function ensureEmailConfirmed(email: string): Promise<boolean> {
  const endpoints = [
    typeof window !== "undefined" ? `${window.location.origin}/api/auth/ensure-email` : null,
    process.env.NEXT_PUBLIC_SITE_URL
      ? `${process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "")}/api/auth/ensure-email`
      : null,
    "https://getfalcon.co/api/auth/ensure-email",
  ].filter(Boolean) as string[];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { confirmed?: boolean };
      if (data.confirmed) return true;
    } catch {
      // try next endpoint
    }
  }
  return false;
}

/**
 * Join the waitlist through our own API (service role, no confirmation email).
 * Used when Supabase's mail provider can't deliver the signup email — the
 * visitor still gets an account with the password they just chose.
 */
async function joinWaitlistServerSide(email: string, password: string): Promise<boolean> {
  try {
    const res = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Existing account → sign in. First-time email → sign up; may require OTP confirm. */
export async function continueWithEmailPassword(
  client: SupabaseClient,
  { email, password }: ContinueParams,
): Promise<ContinueResult> {
  const trimmedEmail = email.trim();

  // Known accounts: make sure the email is confirmed before password auth.
  await ensureEmailConfirmed(trimmedEmail);

  const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
    email: trimmedEmail,
    password,
  });

  if (!signInError && signInData.session) {
    return resolveSessionUser(client, signInData.session, signInData.user);
  }

  if (signInError) {
    const msg = signInError.message.toLowerCase();
    if (msg.includes("email not confirmed") || msg.includes("not confirmed")) {
      const fixed = await ensureEmailConfirmed(trimmedEmail);
      if (fixed) {
        const retry = await client.auth.signInWithPassword({
          email: trimmedEmail,
          password,
        });
        if (!retry.error && retry.data.session) {
          return resolveSessionUser(client, retry.data.session, retry.data.user);
        }
        throw new Error("Invalid email or password.");
      }

      await client.auth.resend({ type: "signup", email: trimmedEmail });
      setWaitlistFlag(false);
      return { type: "confirm_email", email: trimmedEmail };
    }
  }

  const { data: signUpData, error: signUpError } = await client.auth.signUp({
    email: trimmedEmail,
    password,
    options: {
      data: { waitlist: true },
    },
  });

  if (signUpError) {
    const message = signUpError.message.toLowerCase();

    // The email already has an account — stay vague about which half is wrong.
    if (
      message.includes("already registered") ||
      message.includes("already been registered")
    ) {
      throw new Error("Invalid email or password.");
    }

    // Supabase couldn't send the confirmation email (mail provider down or
    // rate-limited) and rolls the signup back. This flow is a waitlist join,
    // so fall back to creating the entry server-side instead of dead-ending.
    if (message.includes("sending") && message.includes("email")) {
      if (await joinWaitlistServerSide(trimmedEmail, password)) {
        setWaitlistFlag(true);
        return { type: "waitlist" };
      }
      throw new Error("We couldn't create your account. Please try again in a moment.");
    }

    // Password rejected by the project's password policy — say so plainly
    // instead of blaming the email/password pair.
    if (signUpError.code === "weak_password" || message.includes("password should")) {
      throw new Error(
        "Password must be at least 6 characters and include an uppercase letter, a lowercase letter, and a number.",
      );
    }

    // Anything else (invalid email format, signups disabled, rate limits…):
    // surface the real reason rather than a misleading credentials error.
    throw signUpError;
  }

  // Supabase returns a fake user with empty identities when the email already exists
  // (account enumeration protection). Do NOT send that user into the OTP loop.
  if (signUpData.user && (signUpData.user.identities?.length ?? 0) === 0) {
    throw new Error("Invalid email or password.");
  }

  if (signUpData.session) {
    return resolveSessionUser(client, signUpData.session, signUpData.user);
  }

  setWaitlistFlag(false);
  return { type: "confirm_email", email: trimmedEmail };
}

export async function requestEmailOtp(client: SupabaseClient, email: string): Promise<void> {
  const { error } = await client.auth.signInWithOtp({
    email: email.trim(),
    options: { shouldCreateUser: false },
  });
  if (error) throw error;
}

export async function requestPasswordReset(client: SupabaseClient, email: string): Promise<void> {
  const { error } = await client.auth.resetPasswordForEmail(email.trim());
  if (error) throw error;
}

export async function resendSignupOtp(client: SupabaseClient, email: string): Promise<void> {
  const { error } = await client.auth.resend({
    type: "signup",
    email: email.trim(),
  });
  if (error) throw error;
}

export async function verifyEmailOtp(
  client: SupabaseClient,
  {
    email,
    token,
    type,
  }: {
    email: string;
    token: string;
    type: EmailOtpType;
  },
): Promise<VerifyOtpResult> {
  const trimmedEmail = email.trim();
  const trimmedToken = token.trim();
  const typesToTry: EmailOtpType[] =
    type === "recovery" || type === "email_change"
      ? [type]
      : [type, "signup", "email"].filter((t, i, arr) => arr.indexOf(t) === i);

  let lastError: unknown = null;
  let data: { session: Session | null; user: User | null } | null = null;

  for (const tryType of typesToTry) {
    const result = await client.auth.verifyOtp({
      email: trimmedEmail,
      token: trimmedToken,
      type: tryType,
    });
    if (!result.error && result.data.session) {
      data = result.data;
      if (tryType === "recovery") {
        return { type: "set_password", session: result.data.session };
      }
      break;
    }
    lastError = result.error;
  }

  if (!data?.session) {
    const message =
      lastError instanceof Error ? lastError.message.toLowerCase() : String(lastError ?? "");
    if (message.includes("token") && (message.includes("expired") || message.includes("invalid"))) {
      throw new Error("Provided verification code is invalid");
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error("Verification succeeded but no session was created.");
  }

  return resolveSessionUser(client, data.session, data.user);
}

export async function updatePassword(client: SupabaseClient, password: string): Promise<void> {
  const { error } = await client.auth.updateUser({ password });
  if (error) throw error;
}

export async function requestEmailChange(client: SupabaseClient, newEmail: string): Promise<void> {
  const { error } = await client.auth.updateUser({ email: newEmail.trim() });
  if (error) throw error;
}

export async function resendOtpForType(
  client: SupabaseClient,
  {
    email,
    type,
    newEmail,
  }: {
    email: string;
    type: EmailOtpType;
    newEmail?: string;
  },
): Promise<void> {
  switch (type) {
    case "signup": {
      await resendSignupOtp(client, email);
      return;
    }
    case "invite":
      throw new Error("Ask your admin to resend the invitation.");
    case "email":
    case "magiclink":
      await requestEmailOtp(client, email);
      return;
    case "recovery":
      await requestPasswordReset(client, email);
      return;
    case "email_change":
      await requestEmailChange(client, newEmail ?? email);
      return;
    default:
      throw new Error("Unsupported OTP type for resend.");
  }
}

