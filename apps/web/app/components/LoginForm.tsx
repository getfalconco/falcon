"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import type { AuthError, EmailOtpType } from "@supabase/supabase-js";
import { EASE } from "@meridian/ui";
import {
  continueWithEmailPassword,
  requestPasswordReset,
  type VerifyOtpResult,
} from "@/lib/auth";
import { isSupabaseConfigured, requireSupabase } from "@/lib/supabase";
import { tryOpenTalentAdminSession } from "@/lib/talent-admin";
import { cn } from "@/lib/utils";
import { AUTH } from "@/lib/marketing-copy";
import OtpForm from "./OtpForm";
import SetPasswordForm from "./SetPasswordForm";

const FAILED_ATTEMPTS_BEFORE_FORGOT = 3;

const oauthButtonClass =
  "relative flex h-11 w-full items-center justify-center border border-black/10 bg-transparent text-sm text-[#1d1b1b] transition hover:bg-black/[0.03]";

const inputClass =
  "w-full border border-black/10 bg-transparent px-4 py-3 text-sm text-[#1d1b1b] outline-none transition placeholder:text-[#9a9a9a] focus:border-black/30";

type Step =
  | { name: "login" }
  | { name: "otp"; email: string; otpType: EmailOtpType; title: string; subtitle: string }
  | { name: "set_password" }
  | { name: "forgot" };

type Props = {
  onSuccess: () => void;
  onAdminSuccess: () => void;
  onTalentSuccess: () => void;
  onWaitlist: (email?: string) => void;
};

function GoogleIcon() {
  return (
    <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}

function authMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

export default function LoginForm({ onSuccess, onAdminSuccess, onTalentSuccess, onWaitlist }: Props) {
  const [step, setStep] = useState<Step>({ name: "login" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);

  const showPasswordField = email.trim().length > 0;
  const canContinue = email.trim().length > 0 && password.trim().length > 0;
  const showForgotPassword = failedAttempts >= FAILED_ATTEMPTS_BEFORE_FORGOT;

  async function finishProductSignIn() {
    if (!isSupabaseConfigured) {
      onSuccess();
      return;
    }
    const client = requireSupabase();
    if (await tryOpenTalentAdminSession(client)) {
      onTalentSuccess();
      return;
    }
    onSuccess();
  }

  function handleOtpVerified(result: VerifyOtpResult) {
    if (result.type === "set_password") {
      setStep({ name: "set_password" });
      return;
    }
    if (result.type === "waitlist") {
      onWaitlist(email);
      return;
    }
    void finishProductSignIn();
  }

  async function handleContinue() {
    if (!canContinue || loading) return;

    setError(null);
    setLoading(true);

    try {
      const adminRes = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (adminRes.ok) {
        onAdminSuccess();
        return;
      }

      if (adminRes.status !== 401) {
        const adminData = (await adminRes.json()) as { error?: string };
        throw new Error(adminData.error ?? "Login failed.");
      }

      if (!isSupabaseConfigured) {
        setError("Invalid email or password.");
        setFailedAttempts((n) => n + 1);
        return;
      }

      const client = requireSupabase();
      const result = await continueWithEmailPassword(client, { email, password });

      if (result.type === "confirm_email") {
        setFailedAttempts(0);
        setStep({
          name: "otp",
          email: result.email,
          otpType: "signup",
          title: "Check your email",
          subtitle: "Enter the 8-digit code we sent to confirm your account.",
        });
        return;
      }

      if (result.type === "signed_in") {
        setFailedAttempts(0);
        await finishProductSignIn();
        return;
      }

      if (result.type === "waitlist") {
        setFailedAttempts(0);
        onWaitlist(email);
      }
    } catch (err) {
      setFailedAttempts((n) => n + 1);
      setError(authMessage(err as AuthError));
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotPassword() {
    const trimmed = email.trim();
    if (!trimmed || loading) return;

    setError(null);

    if (!isSupabaseConfigured) {
      setError("Supabase is not configured.");
      return;
    }

    setLoading(true);
    try {
      const client = requireSupabase();
      await requestPasswordReset(client, trimmed);
      setStep({
        name: "otp",
        email: trimmed,
        otpType: "recovery",
        title: "Reset your password",
          subtitle: "Enter the 8-digit code we sent to your email.",
      });
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (step.name === "otp") {
    return (
      <OtpForm
        email={step.email}
        otpType={step.otpType}
        title={step.title}
        subtitle={step.subtitle}
        onVerified={handleOtpVerified}
        onBack={() => {
          setError(null);
          setStep({ name: "login" });
        }}
      />
    );
  }

  if (step.name === "set_password") {
    return (
      <SetPasswordForm
        onSuccess={() => {
          void finishProductSignIn();
        }}
        onWaitlist={onWaitlist}
      />
    );
  }

  if (step.name === "forgot") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col items-center justify-center px-8">
          <div className="w-full max-w-[420px]">
            <header className="text-center">
              <h1 className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-[#1d1b1b]">
                Forgot password
              </h1>
              <p className="mt-3 text-sm text-[#767676]">
                We will email you a one-time code to reset your password.
              </p>
            </header>

            <form
              className="mt-8"
              onSubmit={(e) => {
                e.preventDefault();
                void handleForgotPassword();
              }}
            >
              <input
                id="email-request"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="Enter email address"
                aria-label="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
              />

              {error ? <p className="mt-3 text-center text-xs text-red-600">{error}</p> : null}

              <button
                type="submit"
                disabled={!email.trim() || loading}
                className={cn(
                  "mt-3 flex h-11 w-full items-center justify-center gap-2 border text-sm font-medium transition",
                  email.trim() && !loading
                    ? "border-black/10 bg-[#1c1917] text-white"
                    : "cursor-not-allowed border-black/[0.06] bg-[#eceae7] text-[#9a9a9a]",
                )}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Send code
              </button>
            </form>

            <button
              type="button"
              onClick={() => {
                setError(null);
                setStep({ name: "login" });
              }}
              className="mt-6 w-full text-center text-xs text-[#8a8a8a] transition hover:text-[#555555]"
            >
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-8">
        <div className="w-full max-w-[420px]">
          <header className="text-center">
            <h1 className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-[#1d1b1b]">
              Welcome to
              <br />
              Falcon
            </h1>
            <p className="mt-3 text-sm text-[#767676]">{AUTH.loginSubtitle}</p>
          </header>

          <div className="mt-8 space-y-3">
            <button type="button" className={oauthButtonClass}>
              <span className="absolute left-4 top-1/2 -translate-y-1/2">
                <GoogleIcon />
              </span>
              Continue with Google
            </button>

            <button type="button" className={oauthButtonClass}>
              <span className="absolute left-4 top-1/2 -translate-y-1/2">
                <AppleIcon />
              </span>
              Continue with Apple
            </button>
          </div>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-black/10" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-background px-3 text-[#9a9a9a]">or</span>
            </div>
          </div>

          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="Enter email address"
            aria-label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />

          <AnimatePresence initial={false}>
            {showPasswordField ? (
              <motion.div
                key="password-field"
                initial={{ height: 0, opacity: 0, marginTop: 0 }}
                animate={{ height: "auto", opacity: 1, marginTop: 12 }}
                exit={{ height: 0, opacity: 0, marginTop: 0 }}
                transition={{ duration: 0.28, ease: EASE }}
                className="overflow-hidden"
              >
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Enter password"
                  aria-label="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleContinue();
                  }}
                  className={inputClass}
                />
                <p className="mt-2 text-center text-[11px] leading-relaxed text-[#9a9a9a]">
                  New account? Use 6+ characters with an uppercase letter, a
                  lowercase letter and a number.
                </p>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {error ? <p className="mt-3 text-center text-xs text-red-600">{error}</p> : null}

          <button
            type="button"
            disabled={!canContinue || loading}
            onClick={() => void handleContinue()}
            className={cn(
              "mt-3 flex h-11 w-full items-center justify-center gap-2 border text-sm font-medium transition",
              canContinue && !loading
                ? "border-black/10 bg-[#1c1917] text-white"
                : "cursor-not-allowed border-black/[0.06] bg-[#eceae7] text-[#9a9a9a]",
            )}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Continue
          </button>

          <div className="mt-4 flex flex-col items-center gap-2 text-xs">
            {showForgotPassword ? (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setStep({ name: "forgot" });
                }}
                className="text-[#767676] underline underline-offset-2 transition hover:text-[#1d1b1b]"
              >
                Forgot password?
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <footer className="shrink-0 px-6 pb-8 text-center text-xs leading-relaxed text-[#8a8a8a]">
        By signing in you agree to our{" "}
        <a href="/terms" className="text-[#6f6f6f] underline underline-offset-2">
          Terms of service
        </a>{" "}
        &{" "}
        <a href="/privacy" className="text-[#6f6f6f] underline underline-offset-2">
          Privacy policy
        </a>
      </footer>
    </div>
  );
}
