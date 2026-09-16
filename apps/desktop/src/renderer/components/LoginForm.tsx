import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { EASE } from "@meridian/ui";
import type { EmailOtpType } from "@supabase/supabase-js";
import {
  continueWithEmailPassword,
  requestPasswordReset,
  type VerifyOtpResult,
} from "@/lib/auth";
import { isSupabaseConfigured, requireSupabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import OtpForm from "@/components/OtpForm";
import SetPasswordForm from "@/components/SetPasswordForm";

const FAILED_ATTEMPTS_BEFORE_FORGOT = 3;

const inputClass =
  "app-no-drag w-full rounded-none border-b border-white/15 bg-transparent px-0 py-2.5 text-sm text-white outline-none transition placeholder:text-[#666666] focus:border-white/40";

// text-white → auth-surface light remap renders it near-black (#141414); stays
// white if the app is ever in dark mode.
const fieldLabelClass = "app-no-drag block text-xs font-medium text-white";

type Step =
  | { name: "login" }
  | { name: "otp"; email: string; otpType: EmailOtpType; title: string; subtitle: string }
  | { name: "set_password" }
  | { name: "forgot" };

type Props = {
  onSuccess: () => void;
  onWaitlist: () => void;
};

function authMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

export default function LoginForm({ onSuccess, onWaitlist }: Props) {
  const [step, setStep] = useState<Step>({ name: "login" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);

  const showPasswordField = email.trim().length > 0;
  const canContinue = email.trim().length > 0 && password.trim().length > 0;
  const showForgotPassword = failedAttempts >= FAILED_ATTEMPTS_BEFORE_FORGOT;

  function handleOtpVerified(result: VerifyOtpResult) {
    if (result.type === "set_password") {
      setStep({ name: "set_password" });
      return;
    }
    if (result.type === "waitlist") {
      onWaitlist();
      return;
    }
    onSuccess();
  }

  async function handleContinue() {
    if (!canContinue || loading) return;

    setError(null);

    if (!isSupabaseConfigured) {
      setError("Supabase is not configured.");
      return;
    }

    setLoading(true);

    try {
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
        onSuccess();
        return;
      }

      if (result.type === "waitlist") {
        setFailedAttempts(0);
        onWaitlist();
      }
    } catch (err) {
      setFailedAttempts((n) => n + 1);
      setError(authMessage(err));
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
    return <SetPasswordForm onSuccess={onSuccess} onWaitlist={onWaitlist} />;
  }

  if (step.name === "forgot") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col items-center justify-center px-8">
          <div className="w-full max-w-[420px]">
            <header className="text-center">
              <h1 className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-white">
                Forgot password
              </h1>
              <p className="mt-3 text-sm text-[#888888]">
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

              {error ? <p className="mt-3 text-center text-xs text-red-400">{error}</p> : null}

              <button
                type="submit"
                disabled={!email.trim() || loading}
                className={cn(
                  "app-no-drag mt-3 flex h-11 w-full items-center justify-center gap-2 border text-sm font-medium transition",
                  email.trim() && !loading
                    ? "border-white/10 bg-white text-black"
                    : "cursor-not-allowed border-white/[0.06] bg-[#2a2a2a] text-[#666666]",
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
              className="app-no-drag mt-6 w-full text-center text-xs text-[#666666] transition hover:text-[#888888]"
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
            <h1 className="font-baskerville text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-white">
              Welcome to
              <br />
              Falcon
            </h1>
            <p className="mt-3 text-sm text-[#888888]">Sign in or create an account</p>
          </header>

          <form
            className="mt-8"
            onSubmit={(e) => {
              e.preventDefault();
              void handleContinue();
            }}
          >
            <label htmlFor="email" className={fieldLabelClass}>
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="jane@example.com"
              aria-label="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={cn(inputClass, "mt-1.5")}
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
                  <label htmlFor="password" className={fieldLabelClass}>
                    Password
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    placeholder="At least 6 characters"
                    aria-label="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={cn(inputClass, "mt-1.5")}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>

            {error ? <p className="mt-3 text-center text-xs text-red-400">{error}</p> : null}

            <button
              type="submit"
              disabled={!canContinue || loading}
              className={cn(
                "app-no-drag mt-3 flex h-11 w-full items-center justify-center gap-2 border text-sm font-medium transition",
                canContinue && !loading
                  ? "border-white/10 bg-white text-black"
                  : "cursor-not-allowed border-white/[0.06] bg-[#2a2a2a] text-[#666666]",
              )}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Continue
            </button>
          </form>

          <div className="app-no-drag mt-4 flex flex-col items-center gap-2 text-xs">
            {showForgotPassword ? (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setStep({ name: "forgot" });
                }}
                className="text-[#888888] underline underline-offset-2 transition hover:text-white"
              >
                Forgot password?
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <footer className="app-no-drag shrink-0 px-6 pb-8 text-center text-xs leading-relaxed text-[#666666]">
        By signing in you agree to our{" "}
        <a href="#" className="text-[#888888] underline underline-offset-2">
          Terms of service
        </a>{" "}
        &{" "}
        <a href="#" className="text-[#888888] underline underline-offset-2">
          Privacy policy
        </a>
      </footer>
    </div>
  );
}
