"use client";

import { useRef, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { EmailOtpType } from "@supabase/supabase-js";
import { OTPInput, type OTPStatus } from "@/components/ui/be-ui-otp-input";
import { resendOtpForType, verifyEmailOtp } from "@/lib/auth";
import { requireSupabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

const OTP_LENGTH = 8;

function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!domain) return value;
  if (local.length <= 2) return `${local[0] ?? ""}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

type Props = {
  email: string;
  otpType: EmailOtpType;
  newEmail?: string;
  title: string;
  subtitle: string;
  onVerified: (result: Awaited<ReturnType<typeof verifyEmailOtp>>) => void;
  onBack: () => void;
};

function authMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

export default function OtpForm({
  email,
  otpType,
  newEmail,
  title,
  subtitle,
  onVerified,
  onBack,
}: Props) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<OTPStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const verifyingRef = useRef(false);

  async function handleVerify(code: string) {
    if (code.length !== OTP_LENGTH || loading || verifyingRef.current) return;
    verifyingRef.current = true;
    setErrorMessage(undefined);
    setStatus("idle");
    setLoading(true);
    try {
      const client = requireSupabase();
      const result = await verifyEmailOtp(client, {
        email,
        token: code,
        type: otpType,
      });
      setStatus("success");
      onVerified(result);
    } catch (err) {
      setStatus("error");
      setErrorMessage(authMessage(err));
      setValue("");
    } finally {
      setLoading(false);
      verifyingRef.current = false;
    }
  }

  async function handleResend() {
    if (resending || loading) return;
    setErrorMessage(undefined);
    setStatus("idle");
    setResent(false);
    setResending(true);
    try {
      const client = requireSupabase();
      await resendOtpForType(client, { email, type: otpType, newEmail });
      setValue("");
      setResent(true);
    } catch (err) {
      setStatus("error");
      setErrorMessage(authMessage(err));
    } finally {
      setResending(false);
    }
  }

  const hint =
    resent && status !== "error" && !loading ? "Code sent again." : undefined;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <button
        type="button"
        onClick={onBack}
        disabled={loading}
        aria-label="Back"
        className="absolute left-8 top-14 z-50 flex h-8 w-8 items-center justify-center text-black/35 transition hover:bg-black/[0.05] hover:text-black/70 disabled:opacity-50"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
      </button>

      <div className="flex flex-1 flex-col items-center justify-center px-8">
        <div className="w-full max-w-[420px]">
          <header className="text-center">
            <h1 className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-[#1d1b1b]">
              {title}
            </h1>
            <p className="mt-3 text-sm text-[#767676]">{subtitle}</p>
            <p className="mt-1 text-sm text-black/70">{maskEmail(email)}</p>
          </header>

          <div className="mt-8 flex flex-col items-center">
            <OTPInput
              length={OTP_LENGTH}
              value={value}
              status={status}
              disabled={loading}
              autoFocus
              aria-label="8-digit verification code"
              errorMessage={errorMessage}
              hint={hint}
              successMessage="Verified."
              onChange={(next) => {
                setValue(next);
                if (status !== "idle") {
                  setStatus("idle");
                  setErrorMessage(undefined);
                }
                if (resent) setResent(false);
              }}
              onComplete={(code) => void handleVerify(code)}
            />

            {loading ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-[#767676]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Verifying…
              </p>
            ) : null}
          </div>

          <div className="mt-6 flex flex-col items-center gap-3 text-xs">
            <button
              type="button"
              onClick={() => void handleResend()}
              disabled={resending || loading}
              className="text-[#767676] underline underline-offset-2 transition hover:text-[#1d1b1b] disabled:opacity-50"
            >
              {resending ? "Sending…" : "Resend code"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
