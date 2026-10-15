import type { EmailOtpType, Session, SupabaseClient, User } from "@supabase/supabase-js";
import { primeWaitlistMembership } from "@/lib/waitlist-api";

type RegisterParams = {
  email: string;
  password: string;
  fullName: string;
};

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
const WAITLIST_EMAIL_KEY = "meridian-waitlist-email";

export function readWaitlistEmail(): string {
  try {
    return localStorage.getItem(WAITLIST_EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setWaitlistEmail(email: string): void {
  try {
    const trimmed = email.trim().toLowerCase();
    if (trimmed) {
      localStorage.setItem(WAITLIST_EMAIL_KEY, trimmed);
    } else {
      localStorage.removeItem(WAITLIST_EMAIL_KEY);
    }
  } catch {
    // private mode / quota
  }
}

/**
 * Approval is authoritative ONLY from app_metadata, which only the service
 * role can write. user_metadata is client-writable via auth.updateUser({ data }),
 * so trusting it would let any signed-in account self-promote to approved.
 */
export function isApproved(user: User | null | undefined): boolean {
  return user?.app_metadata?.approved === true;
}

export function isWaitlistUser(user: User | null | undefined): boolean {
  if (!user) return false;
  // Anyone not positively approved is treated as waitlist.
  return !isApproved(user);
}

export function needsProfileSetup(user: User | null | undefined): boolean {
  const fullName = user?.user_metadata?.full_name;
  return typeof fullName !== "string" || !fullName.trim();
}

export function readWaitlistFlag(): boolean {
  return sessionStorage.getItem(WAITLIST_STORAGE_KEY) === "1";
}

export function setWaitlistFlag(active: boolean): void {
  if (active) {
    sessionStorage.setItem(WAITLIST_STORAGE_KEY, "1");
  } else {
    sessionStorage.removeItem(WAITLIST_STORAGE_KEY);
  }
}

async function resolveSessionUser(
  client: SupabaseClient,
  session: Session,
  user: User | null,
): Promise<Exclude<ContinueResult, { type: "confirm_email" }>> {
  if (isWaitlistUser(user)) {
    // The ticket can only be read with a live session: read it first.
    await primeWaitlistMembership();
    await client.auth.signOut();
    setWaitlistFlag(true);
    if (user?.email) setWaitlistEmail(user.email);
    return { type: "waitlist" };
  }
  setWaitlistFlag(false);
  return { type: "signed_in", session };
}

/**
 * Existing account → sign in. First-time email → sign up; may require OTP confirm.
 */
export async function continueWithEmailPassword(
  client: SupabaseClient,
  { email, password }: ContinueParams,
): Promise<ContinueResult> {
  const trimmedEmail = email.trim();

  const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
    email: trimmedEmail,
    password,
  });

  if (!signInError && signInData.session) {
    return resolveSessionUser(client, signInData.session, signInData.user);
  }

  if (signInError) {
    const msg = signInError.message.toLowerCase();
    if (
      signInError.code === "email_not_confirmed" ||
      msg.includes("email not confirmed") ||
      msg.includes("not confirmed")
    ) {
      // Right password, unconfirmed email: the owner proves the address with
      // the emailed code (the OTP step). The site no longer confirms emails
      // on request (POST /api/auth/ensure-email answers the same for everyone).
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
    const code = signUpError.code;
    const message = signUpError.message.toLowerCase();
    const alreadyRegistered =
      code === "user_already_exists" ||
      code === "email_exists" ||
      code === "identity_already_exists" ||
      message.includes("already registered") ||
      message.includes("already been registered");
    if (alreadyRegistered) {
      throw new Error("Invalid email or password.");
    }
    // Any other signup failure (weak password, rate limit, invalid email, ...)
    // is a real, actionable error — surface it instead of masking it as a
    // bad-credentials message, which previously happened for any 422 status.
    throw signUpError;
  }

  // Existing email → fake user with empty identities (do not OTP-loop).
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


/**
 * Creates a user with full_name. With Confirm email ON, returns confirm_email
 * instead of a session until the OTP is verified.
 */
export async function registerWithEmail(
  client: SupabaseClient,
  { email, password, fullName }: RegisterParams,
): Promise<Session | { type: "confirm_email"; email: string }> {
  const trimmedEmail = email.trim();

  const { data: signUpData, error: signUpError } = await client.auth.signUp({
    email: trimmedEmail,
    password,
    options: {
      data: { full_name: fullName.trim() },
    },
  });

  if (signUpError) throw signUpError;
  if (signUpData.session) return signUpData.session;

  return { type: "confirm_email", email: trimmedEmail };
}
