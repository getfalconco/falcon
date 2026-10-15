import type { MessageKey } from "./i18n/messages";

/**
 * What went wrong at sign-in, as a message key rather than Supabase's own
 * English. Supabase reports a stable `code` on most errors (`invalid_credentials`,
 * `otp_expired`, `over_email_send_rate_limit`, ...); older paths and the
 * helpers in lib/auth.ts only carry a message, so those are matched by their
 * wording as a fallback. Anything unrecognised reads as the generic line, never
 * as raw English in a translated screen.
 *
 * Pure (no Supabase import, no DOM) so it runs under `node --test`.
 */

/** Thrown before any request when the build has no Supabase URL or key. */
export class AuthNotConfiguredError extends Error {
  constructor() {
    super("Supabase is not configured.");
    this.name = "AuthNotConfiguredError";
  }
}

const BY_CODE: Readonly<Record<string, MessageKey>> = {
  invalid_credentials: "auth.error.invalidCredentials",
  user_already_exists: "auth.error.invalidCredentials",
  email_exists: "auth.error.invalidCredentials",
  identity_already_exists: "auth.error.invalidCredentials",
  user_not_found: "auth.error.invalidCredentials",
  email_not_confirmed: "auth.error.emailNotConfirmed",
  otp_expired: "auth.error.codeInvalid",
  otp_disabled: "auth.error.codeInvalid",
  bad_code_verifier: "auth.error.codeInvalid",
  over_email_send_rate_limit: "auth.error.rateLimited",
  over_request_rate_limit: "auth.error.rateLimited",
  over_sms_send_rate_limit: "auth.error.rateLimited",
  weak_password: "auth.error.weakPassword",
  same_password: "auth.error.samePassword",
  email_address_invalid: "auth.error.emailInvalid",
  email_address_not_authorized: "auth.error.emailInvalid",
  signup_disabled: "auth.error.signupDisabled",
  email_provider_disabled: "auth.error.signupDisabled",
  user_banned: "auth.error.accountBlocked",
  session_not_found: "auth.error.sessionExpired",
  session_expired: "auth.error.sessionExpired",
  refresh_token_not_found: "auth.error.sessionExpired",
  refresh_token_already_used: "auth.error.sessionExpired",
  reauthentication_needed: "auth.error.sessionExpired",
  request_timeout: "auth.error.network",
};

/** Wording matched when there is no code, most specific first. */
const BY_MESSAGE: ReadonlyArray<readonly [RegExp, MessageKey]> = [
  [/supabase is not configured/, "auth.error.notConfigured"],
  [/failed to fetch|fetch failed|network ?error|networkerror|load failed|err_internet|timed? ?out/, "auth.error.network"],
  [/invalid (login credentials|email or password)|already (been )?registered|user already exists/, "auth.error.invalidCredentials"],
  [/email not confirmed|not confirmed/, "auth.error.emailNotConfirmed"],
  [/verification code is invalid|token has expired|(token|otp|code).*(expired|invalid)|(expired|invalid).*(token|otp|code)/, "auth.error.codeInvalid"],
  [/rate limit|too many requests|only request this after|security purposes/, "auth.error.rateLimited"],
  [/password should|password is too weak|weak password|password.*(at least|characters)/, "auth.error.weakPassword"],
  [/different from the old password|same password/, "auth.error.samePassword"],
  [/unable to validate email|invalid email|email address.*invalid|invalid format/, "auth.error.emailInvalid"],
  [/signups? not allowed|signup.*disabled/, "auth.error.signupDisabled"],
  [/banned/, "auth.error.accountBlocked"],
  [/session (missing|not found|expired)|auth session missing|refresh token/, "auth.error.sessionExpired"],
  [/no session was created/, "auth.error.noSession"],
  [/resend the invitation/, "auth.error.inviteResend"],
];

function field(error: unknown, name: string): unknown {
  return error && typeof error === "object" ? (error as Record<string, unknown>)[name] : undefined;
}

/** The key for an error thrown anywhere in the sign-in flow. */
export function authErrorKey(error: unknown): MessageKey {
  if (error instanceof AuthNotConfiguredError) return "auth.error.notConfigured";

  const code = field(error, "code");
  if (typeof code === "string" && BY_CODE[code]) return BY_CODE[code]!;

  // supabase-js names the error it raises when the request never got an answer.
  const name = field(error, "name");
  if (name === "AuthRetryableFetchError") return "auth.error.network";
  if (field(error, "status") === 429) return "auth.error.rateLimited";

  const raw = field(error, "message") ?? (typeof error === "string" ? error : "");
  const message = typeof raw === "string" ? raw.toLowerCase() : "";
  if (message) {
    for (const [pattern, key] of BY_MESSAGE) {
      if (pattern.test(message)) return key;
    }
  }
  return "auth.error.generic";
}
