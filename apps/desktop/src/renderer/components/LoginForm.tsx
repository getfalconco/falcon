import { useState, type ReactNode } from "react";
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
import { authErrorKey } from "@/lib/auth-errors";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { authCtaClass } from "@/components/auth-cta";
import OtpForm from "@/components/OtpForm";
import { openLegal } from "@/lib/legal-links";
import SetPasswordForm from "@/components/SetPasswordForm";

const FAILED_ATTEMPTS_BEFORE_FORGOT = 3;

const inputClass =
  "app-no-drag w-full rounded-none border-b border-white/15 bg-transparent px-0 py-2.5 text-sm text-white outline-none transition placeholder:text-[#666666] focus:border-white/40";

// text-white → auth-surface light remap renders it near-black (#141414); stays
// white if the app is ever in dark mode.
const fieldLabelClass = "app-no-drag block text-xs font-medium text-white";

type Step =
  | { name: "login" }
  | { name: "otp"; email: string; otpType: EmailOtpType; title: MessageKey; subtitle: MessageKey }
  | { name: "set_password" }
  | { name: "forgot" };

type Props = {
  onSuccess: () => void;
  onWaitlist: () => void;
};

/** A policy named in the sign-in notice; opens on getfalcon.co in the reader's browser. */
function LegalLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[#888888] underline underline-offset-2 transition hover:text-white"
    >
      {children}
    </button>
  );
}

export default function LoginForm({ onSuccess, onWaitlist }: Props) {
  const { t, tNodes } = useI18n();
  const [step, setStep] = useState<Step>({ name: "login" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  // A key, not words, so the line follows a language change while it shows.
  const [error, setError] = useState<MessageKey | null>(null);
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
      setError("auth.error.notConfigured");
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
          title: "auth.otp.confirmTitle",
          subtitle: "auth.otp.confirmSubtitle",
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
      setError(authErrorKey(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotPassword() {
    const trimmed = email.trim();
    if (!trimmed || loading) return;

    setError(null);

    if (!isSupabaseConfigured) {
      setError("auth.error.notConfigured");
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
        title: "auth.otp.resetTitle",
        subtitle: "auth.otp.resetSubtitle",
      });
    } catch (err) {
      setError(authErrorKey(err));
    } finally {
      setLoading(false);
    }
  }

  if (step.name === "otp") {
    return (
      <OtpForm
        email={step.email}
        otpType={step.otpType}
        title={t(step.title)}
        subtitle={t(step.subtitle)}
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
                {t("auth.forgot.title")}
              </h1>
              <p className="mt-3 text-balance text-sm text-[#888888] [word-break:auto-phrase]">{t("auth.forgot.subtitle")}</p>
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
                placeholder={t("auth.forgot.emailPlaceholder")}
                aria-label={t("auth.field.email")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
              />

              {error ? (
                <p role="alert" className="mt-3 text-center text-xs text-red-400">
                  {t(error)}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={!email.trim() || loading}
                aria-busy={loading || undefined}
                className={cn(
                  "app-no-drag mt-3 flex h-11 w-full items-center justify-center gap-2 border text-sm font-medium transition",
                  authCtaClass(email.trim() !== "" && !loading),
                )}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                {t("auth.forgot.send")}
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
              {t("auth.back")}
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
              {tNodes("auth.login.title", { br: <br /> })}
            </h1>
            <p className="mt-3 text-balance text-sm text-[#888888] [word-break:auto-phrase]">{t("auth.login.subtitle")}</p>
          </header>

          <form
            className="mt-8"
            onSubmit={(e) => {
              e.preventDefault();
              void handleContinue();
            }}
          >
            <label htmlFor="email" className={fieldLabelClass}>
              {t("auth.field.email")}
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="jane@example.com"
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
                    {t("auth.field.password")}
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    placeholder={t("auth.field.passwordPlaceholder")}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={cn(inputClass, "mt-1.5")}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>

            {error ? (
              <p role="alert" className="mt-3 text-center text-xs text-red-400">
                {t(error)}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={!canContinue || loading}
              aria-busy={loading || undefined}
              className={cn(
                "app-no-drag mt-3 flex h-11 w-full items-center justify-center gap-2 border text-sm font-medium transition",
                authCtaClass(canContinue && !loading),
              )}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {t("auth.continue")}
            </button>

            {/* Continue both signs in and creates an account, so the notice sits right under it. */}
            <p className="app-no-drag mt-4 text-balance text-center text-xs leading-relaxed text-[#666666]">
              {tNodes("auth.login.legal", {
                terms: <LegalLink onClick={() => openLegal("terms")}>{t("auth.login.legalTerms")}</LegalLink>,
                privacy: <LegalLink onClick={() => openLegal("privacy")}>{t("auth.login.legalPrivacy")}</LegalLink>,
              })}
            </p>
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
                {t("auth.login.forgot")}
              </button>
            ) : null}
          </div>
        </div>
      </div>

    </div>
  );
}
