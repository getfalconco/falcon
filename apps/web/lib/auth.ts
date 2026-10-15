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
// The member's own ticket (name, number, join date), read with their session
// before sign-out. Only ever their own: the server answers for the token.
const WAITLIST_CARD_KEY = "meridian-waitlist-card";

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
  // The ticket belongs to that email; forgetting the email forgets the ticket.
  if (email === null) writeStored(WAITLIST_CARD_KEY, null);
}

/** The member's own ticket, as GET /api/waitlist/me returns it. */
export type WaitlistCard = {
  name: string | null;
  memberNumber: number | null;
  grantedAt: string | null;
  approved: boolean;
};

type StoredCard = WaitlistCard & { email: string };

/**
 * The ticket saved for `email`, or null. Waitlist members are signed out right
 * after auth, so the status screens cannot ask the server again later: the
 * ticket is read once with the session (captureWaitlistCard) and kept here.
 */
export function readWaitlistCard(email: string | null | undefined): WaitlistCard | null {
  const raw = readStored(WAITLIST_CARD_KEY);
  if (!raw || !email) return null;
  try {
    const card = JSON.parse(raw) as Partial<StoredCard>;
    if (card.email !== email.trim().toLowerCase()) return null;
    return {
      name: typeof card.name === "string" ? card.name : null,
      memberNumber: typeof card.memberNumber === "number" ? card.memberNumber : null,
      grantedAt: typeof card.grantedAt === "string" ? card.grantedAt : null,
      approved: card.approved === true,
    };
  } catch {
    return null;
  }
}

export function setWaitlistCard(email: string, card: WaitlistCard): void {
  const stored: StoredCard = { ...card, email: email.trim().toLowerCase() };
  writeStored(WAITLIST_CARD_KEY, JSON.stringify(stored));
}

/**
 * The signed-in user's own ticket from GET /api/waitlist/me, authenticated by
 * their access token. Null when they are not a member or the call fails.
 */
export async function fetchOwnMembership(accessToken: string): Promise<WaitlistCard | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch("/api/waitlist/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { found?: boolean } & Partial<WaitlistCard>;
    if (data.found !== true) return null;
    return {
      name: data.name ?? null,
      memberNumber: data.memberNumber ?? null,
      grantedAt: data.grantedAt ?? null,
      approved: data.approved === true,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the member's ticket while the session still exists and saves it with
 * their email, so the waitlist screens can show it after sign-out.
 */
async function captureWaitlistCard(session: Session, user: User | null): Promise<void> {
  const email = (user?.email ?? session.user?.email ?? "").trim().toLowerCase();
  if (!email) return;
  setWaitlistEmail(email);
  const card = await fetchOwnMembership(session.access_token);
  if (card) setWaitlistCard(email, card);
}

/** True when the ticket saved for `email` carries a name. */
export function hasSavedName(email: string | null | undefined): boolean {
  return Boolean(readWaitlistCard(email)?.name?.trim());
}

/**
 * Waitlisted accounts don't stay signed in. Save their ticket first (it needs
 * the session), then sign out and leave the waitlist flag.
 *
 * One exception: a member whose ticket has no name yet keeps the session
 * through the name step on the login screen, because saving the name needs
 * it (POST /api/waitlist only updates an existing account for its own token).
 * saveWaitlistName finishes the sign-out.
 */
export async function signOutWaitlistMember(
  client: SupabaseClient,
  session: Session | null,
  user: User | null,
): Promise<void> {
  if (session) {
    await captureWaitlistCard(session, user);
    const email = (user?.email ?? session.user?.email ?? "").trim().toLowerCase();
    if (email && !hasSavedName(email)) {
      setWaitlistFlag(true);
      return;
    }
  }
  await client.auth.signOut();
  setWaitlistFlag(true);
}

/**
 * The live session for `email`, or null. Used by the name step, which may
 * only run while the member's own session still exists.
 */
export async function ownSessionFor(
  client: SupabaseClient,
  email: string | null | undefined,
): Promise<Session | null> {
  const wanted = email?.trim().toLowerCase();
  if (!wanted) return null;
  try {
    const {
      data: { session },
    } = await client.auth.getSession();
    return session?.user?.email?.trim().toLowerCase() === wanted ? session : null;
  } catch {
    return null;
  }
}

type WaitlistPayload = {
  name?: string;
  email: string;
  password?: string;
  phone?: string;
  application?: Record<string, string>;
};

/**
 * POST /api/waitlist. Without a token it can only create a new account; an
 * existing account is updated only for its own access token.
 */
async function postWaitlist(
  payload: WaitlistPayload,
  accessToken?: string,
): Promise<{ ok: boolean; error?: string; memberNumber?: number | null }> {
  const res = await fetch("/api/waitlist", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    memberNumber?: number | null;
  };
  return { ...data, ok: res.ok && data.ok === true };
}

/**
 * The name step on the login screen. Saves the name on the member's own
 * account with their session, then signs them out like any waitlist member
 * (the ticket is read again on the way out, now with the name).
 */
export async function saveWaitlistName(
  client: SupabaseClient,
  email: string,
  name: string,
): Promise<void> {
  const session = await ownSessionFor(client, email);
  if (!session) throw new Error("Your session has ended. Sign in again to add your name.");

  const result = await postWaitlist({ name, email }, session.access_token);
  if (!result.ok) throw new Error(result.error ?? "Something went wrong.");

  // Put the name on the saved ticket right away, so the waitlist screen
  // shows it even if reading the ticket again fails.
  const card = readWaitlistCard(email);
  setWaitlistCard(email, {
    name,
    memberNumber: result.memberNumber ?? card?.memberNumber ?? null,
    grantedAt: card?.grantedAt ?? null,
    approved: card?.approved === true,
  });
  await signOutWaitlistMember(client, session, session.user);
}

export type ApplicationSubmission = {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  application: Record<string, string>;
};

/**
 * The early-access application. The unauthenticated POST creates the account
 * when the email is new (for a taken email the server changes nothing). Then
 * the applicant is signed in with the password they just chose: that applies
 * the answers to an account they already own, and reads their member number
 * with their own session. Waitlist members are signed out again right after.
 *
 * A new account starts with an unconfirmed email, so the password sign-in is
 * refused until the applicant proves the address is theirs. In that case a
 * code is emailed and the answer carries `verifyEmail`: the flow shows the
 * code step, and finishApplicationWithSession completes the same work once
 * the code is verified.
 */
export async function submitApplication(
  client: SupabaseClient | null,
  submission: ApplicationSubmission,
): Promise<{ memberNumber: number | null; verifyEmail?: string }> {
  const email = submission.email.trim().toLowerCase();
  const payload = applicationPayload(submission);

  const created = await postWaitlist(payload);
  if (!created.ok) throw new Error(created.error ?? "Something went wrong. Please try again.");
  if (!client) return { memberNumber: null };

  try {
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password: submission.password,
    });
    if (error) {
      // Only reached with the right password (Supabase checks it first), so
      // the code goes to someone who already knows this account's password.
      if (isEmailNotConfirmed(error)) {
        await client.auth.resend({ type: "signup", email });
        return { memberNumber: null, verifyEmail: email };
      }
      return { memberNumber: null };
    }
    if (!data.session) return { memberNumber: null };

    const memberNumber = await finishApplicationWithSession(data.session, submission);
    await resolveSessionUser(client, data.session, data.user);
    return { memberNumber };
  } catch {
    // The application itself went through; only the number is missing.
    return { memberNumber: null };
  }
}

function applicationPayload(submission: ApplicationSubmission): WaitlistPayload {
  return {
    name: submission.fullName,
    email: submission.email.trim().toLowerCase(),
    password: submission.password,
    phone: submission.phone,
    application: submission.application,
  };
}

/**
 * Applies the answers to the applicant's own account with their session and
 * reads their member number. Never throws: the application already exists.
 */
export async function finishApplicationWithSession(
  session: Session,
  submission: ApplicationSubmission,
): Promise<number | null> {
  try {
    const own = await postWaitlist(applicationPayload(submission), session.access_token);
    const card = await fetchOwnMembership(session.access_token);
    return card?.memberNumber ?? own.memberNumber ?? null;
  } catch {
    return null;
  }
}

function isEmailNotConfirmed(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "email_not_confirmed") return true;
  const msg = (error.message ?? "").toLowerCase();
  return msg.includes("email not confirmed") || msg.includes("not confirmed");
}

async function resolveSessionUser(
  client: SupabaseClient,
  session: Session,
  user: User | null,
): Promise<Exclude<ContinueResult, { type: "confirm_email" }>> {
  if (isWaitlistUser(user)) {
    await signOutWaitlistMember(client, session, user);
    return { type: "waitlist" };
  }
  setWaitlistFlag(false);
  return { type: "signed_in", session };
}

/**
 * Join the waitlist through our own API (service role, no confirmation email).
 * Used when Supabase's mail provider can't deliver the signup email — the
 * visitor still gets an account with the password they just chose.
 */
async function joinWaitlistServerSide(email: string, password: string): Promise<boolean> {
  try {
    return (await postWaitlist({ email, password })).ok;
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

  const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
    email: trimmedEmail,
    password,
  });

  if (!signInError && signInData.session) {
    return resolveSessionUser(client, signInData.session, signInData.user);
  }

  // Right password, unconfirmed email: the owner proves the address with the
  // emailed code (the OTP step). Nothing confirms an email without that.
  if (signInError && isEmailNotConfirmed(signInError)) {
    await client.auth.resend({ type: "signup", email: trimmedEmail });
    setWaitlistFlag(false);
    return { type: "confirm_email", email: trimmedEmail };
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
        // Sign in with the new credentials: the name step that follows saves
        // the name with this session (the server only updates an existing
        // account for its own token). The new account's email is unconfirmed,
        // so this only succeeds where the project does not require it; the
        // member confirms with a code on a later sign-in.
        try {
          const joined = await client.auth.signInWithPassword({ email: trimmedEmail, password });
          if (!joined.error && joined.data.session) {
            return resolveSessionUser(client, joined.data.session, joined.data.user);
          }
        } catch {
          // Still on the waitlist, just without the name step.
        }
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

/**
 * Verifies an emailed code, trying the plausible OTP types in turn, and
 * returns the session it creates. Verifying a signup or email code is what
 * confirms the address. Does not decide where the user goes next.
 */
export async function verifyEmailCode(
  client: SupabaseClient,
  { email, token, type }: { email: string; token: string; type: EmailOtpType },
): Promise<{ session: Session; user: User | null; recovery: boolean }> {
  const trimmedEmail = email.trim();
  const trimmedToken = token.trim();
  const typesToTry: EmailOtpType[] =
    type === "recovery" || type === "email_change"
      ? [type]
      : [type, "signup", "email"].filter((t, i, arr) => arr.indexOf(t) === i);

  let lastError: unknown = null;

  for (const tryType of typesToTry) {
    const result = await client.auth.verifyOtp({
      email: trimmedEmail,
      token: trimmedToken,
      type: tryType,
    });
    if (!result.error && result.data.session) {
      return {
        session: result.data.session,
        user: result.data.user,
        recovery: tryType === "recovery",
      };
    }
    lastError = result.error;
  }

  const message =
    lastError instanceof Error ? lastError.message.toLowerCase() : String(lastError ?? "");
  if (message.includes("token") && (message.includes("expired") || message.includes("invalid"))) {
    throw new Error("Provided verification code is invalid");
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("Verification succeeded but no session was created.");
}

export async function verifyEmailOtp(
  client: SupabaseClient,
  {
    email,
    token,
    type,
    onSession,
  }: {
    email: string;
    token: string;
    type: EmailOtpType;
    /**
     * Runs with the fresh session before the usual routing, which signs
     * waitlist members out (e.g. the application flow saves answers here).
     */
    onSession?: (session: Session) => Promise<void>;
  },
): Promise<VerifyOtpResult> {
  const verified = await verifyEmailCode(client, { email, token, type });
  if (verified.recovery) return { type: "set_password", session: verified.session };
  if (onSession) await onSession(verified.session);
  return resolveSessionUser(client, verified.session, verified.user);
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

