import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuthNotConfiguredError, authErrorKey } from "./auth-errors";

/** Supabase-shaped errors in, message keys out. */
const authError = (message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { name: "AuthApiError", ...extra });

describe("authErrorKey", () => {
  it("reads Supabase's code first", () => {
    assert.equal(authErrorKey(authError("Invalid login credentials", { code: "invalid_credentials", status: 400 })), "auth.error.invalidCredentials");
    assert.equal(authErrorKey(authError("Token has expired or is invalid", { code: "otp_expired" })), "auth.error.codeInvalid");
    assert.equal(authErrorKey(authError("Email rate limit exceeded", { code: "over_email_send_rate_limit", status: 429 })), "auth.error.rateLimited");
    assert.equal(authErrorKey(authError("Password should be at least 6 characters.", { code: "weak_password" })), "auth.error.weakPassword");
    assert.equal(authErrorKey(authError("New password should be different from the old password.", { code: "same_password" })), "auth.error.samePassword");
    assert.equal(authErrorKey(authError("Unable to validate email address: invalid format", { code: "email_address_invalid" })), "auth.error.emailInvalid");
  });

  it("falls back to the wording when there is no code", () => {
    assert.equal(authErrorKey(new Error("Invalid email or password.")), "auth.error.invalidCredentials");
    assert.equal(authErrorKey(new Error("Provided verification code is invalid")), "auth.error.codeInvalid");
    assert.equal(authErrorKey(new Error("Verification succeeded but no session was created.")), "auth.error.noSession");
    assert.equal(authErrorKey(new Error("Ask your admin to resend the invitation.")), "auth.error.inviteResend");
    assert.equal(authErrorKey(new Error("For security purposes, you can only request this after 42 seconds.")), "auth.error.rateLimited");
    assert.equal(authErrorKey(new Error("Auth session missing!")), "auth.error.sessionExpired");
  });

  it("tells a dead connection from a refusal", () => {
    assert.equal(authErrorKey(Object.assign(new Error("Failed to fetch"), { name: "AuthRetryableFetchError", status: 0 })), "auth.error.network");
    assert.equal(authErrorKey(new TypeError("Failed to fetch")), "auth.error.network");
    assert.equal(authErrorKey({ status: 429, message: "" }), "auth.error.rateLimited");
  });

  it("names a build without Supabase", () => {
    assert.equal(authErrorKey(new AuthNotConfiguredError()), "auth.error.notConfigured");
  });

  it("reads anything else as the generic line, never as raw text", () => {
    assert.equal(authErrorKey(new Error("Database error saving new user")), "auth.error.generic");
    assert.equal(authErrorKey(undefined), "auth.error.generic");
    assert.equal(authErrorKey(42), "auth.error.generic");
    assert.equal(authErrorKey(authError("Something odd", { code: "unexpected_failure" })), "auth.error.generic");
  });
});
