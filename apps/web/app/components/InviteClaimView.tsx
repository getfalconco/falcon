"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { createBrowserSupabase } from "@/lib/supabase";
import { resendSignupOtp, verifyEmailCode } from "@/lib/auth";
import type { InviteRole, InviteStatus } from "@/lib/admin-invites";
import { tryOpenTalentAdminSession } from "@/lib/talent-admin";
import TicketRevealStage from "./TicketRevealStage";

const GEIST = "var(--font-geist-sans), sans-serif";
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

type Props = {
  token: string;
  status: InviteStatus | "invalid";
  role: InviteRole | null;
};

const INVALID_COPY: Record<string, { title: string; body: string }> = {
  invalid: { title: "Invalid link", body: "This invite link isn’t valid. Ask your admin for a new one." },
  claimed: { title: "Already used", body: "This invite link has already been claimed. Ask your admin for a new one." },
  expired: { title: "Link expired", body: "This invite link has expired. Ask your admin for a new one." },
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center overflow-y-auto bg-[#fdfdfd] px-6 py-16 text-[#1d1b1b]"
      style={{ fontFamily: GEIST }}
    >
      {children}
    </div>
  );
}

export default function InviteClaimView({ token, status, role }: Props) {
  const [step, setStep] = useState<"signin" | "code" | "reveal">("signin");
  const [code, setCode] = useState("");
  const [resent, setResent] = useState(false);
  const [claimed, setClaimed] = useState<{ role: InviteRole; name: string } | null>(null);
  const [torn, setTorn] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status !== "active" || !role) {
    const copy = INVALID_COPY[status] ?? INVALID_COPY.invalid;
    return (
      <Shell>
        <div className="w-full max-w-[420px] text-center">
          <h1 className="font-serif text-[2rem] font-normal text-[#1d1b1b]">{copy.title}</h1>
          <p className="mt-3 text-sm text-[#767676]">{copy.body}</p>
          <a href="/" className="mt-8 inline-block text-[13px] text-[#767676] underline-offset-4 hover:text-[#1d1b1b] hover:underline">
            Back to home
          </a>
        </div>
      </Shell>
    );
  }

  const roleLabel =
    role === "talent_manager"
      ? "Talent Manager"
      : role.charAt(0).toUpperCase() + role.slice(1);

  /** Consumes the invite for the signed-in account and shows the ticket. */
  async function claimWithSession(supabase: SupabaseClient, session: Session, cleanEmail: string) {
    const res = await fetch("/api/invite/claim", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ token }),
    });
    const payload = (await res.json()) as { ok?: boolean; role?: InviteRole; name?: string; error?: string };

    if (!res.ok || !payload.ok || !payload.role) {
      setError(payload.error ?? "Could not claim this invite.");
      return;
    }

    if (payload.role === "talent_manager") {
      await tryOpenTalentAdminSession(supabase);
    }

    setClaimed({ role: payload.role, name: payload.name ?? cleanEmail.split("@")[0] });
    setStep("reveal");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const supabase = createBrowserSupabase();
      const cleanEmail = email.trim();

      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password,
      });

      // Right password, unconfirmed email: prove the address with the emailed
      // code before the invite is claimed. Nothing confirms it without that.
      const unconfirmed =
        signInError?.code === "email_not_confirmed" ||
        (signInError?.message ?? "").toLowerCase().includes("not confirmed");
      if (unconfirmed) {
        await supabase.auth.resend({ type: "signup", email: cleanEmail });
        setCode("");
        setResent(false);
        setStep("code");
        return;
      }

      if (signInError || !data.session) {
        setError("Invalid email or password.");
        return;
      }

      await claimWithSession(supabase, data.session, cleanEmail);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCode(e: React.FormEvent) {
    e.preventDefault();
    if (busy || code.trim().length < 6) return;
    setBusy(true);
    setError(null);

    try {
      const supabase = createBrowserSupabase();
      const cleanEmail = email.trim();
      const { session } = await verifyEmailCode(supabase, {
        email: cleanEmail,
        token: code,
        type: "signup",
      });
      await claimWithSession(supabase, session, cleanEmail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    if (busy) return;
    setError(null);
    setResent(false);
    try {
      await resendSignupOtp(createBrowserSupabase(), email);
      setResent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
  }

  if (step === "reveal" && claimed) {
    return (
      <Shell>
        <TicketRevealStage
          role={claimed.role}
          name={claimed.name}
          torn={torn}
          onTear={() => setTorn(true)}
        />
      </Shell>
    );
  }

  if (step === "code") {
    return (
      <Shell>
        <div className="w-full max-w-[380px]">
          <div className="text-center">
            <p className="text-[11px] uppercase tracking-[0.2em] text-[#a3a3a0]">Invitation</p>
            <h1 className="mt-3 font-serif text-[1.9rem] font-normal leading-[1.2] text-[#1d1b1b]">
              Confirm your email
            </h1>
            <p className="mt-3 text-sm text-[#767676]">
              Enter the 8-digit code we sent to {email.trim()} to claim your ticket.
            </p>
          </div>

          <form onSubmit={handleCode} className="mt-8 space-y-3">
            <input
              type="text"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Verification code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
              className="h-11 w-full rounded-lg border border-black/15 bg-[#fdfdfd] px-3.5 text-center text-sm tracking-[0.3em] text-[#1d1b1b] outline-none transition placeholder:tracking-normal placeholder:text-[#a3a3a0] focus:border-black/40"
            />

            {error ? <p className="text-[13px] text-red-600">{error}</p> : null}
            {resent && !error ? <p className="text-[13px] text-[#767676]">Code sent again.</p> : null}

            <button
              type="submit"
              disabled={busy || code.length < 6}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#1d1b1b] text-sm font-medium text-white transition hover:bg-black disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Confirm and claim
            </button>
          </form>

          <div className="mt-5 flex items-center justify-center gap-4 text-[12px] text-[#767676]">
            <button type="button" onClick={() => void handleResend()} className="underline underline-offset-2 hover:text-[#1d1b1b]">
              Resend code
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStep("signin");
              }}
              className="underline underline-offset-2 hover:text-[#1d1b1b]"
            >
              Back
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE_OUT }}
        className="w-full max-w-[380px]"
      >
        <div className="text-center">
          <p className="text-[11px] uppercase tracking-[0.2em] text-[#a3a3a0]">Invitation</p>
          <h1 className="mt-3 font-serif text-[1.9rem] font-normal leading-[1.2] text-[#1d1b1b]">
            You’ve been invited as {roleLabel}
          </h1>
          <p className="mt-3 text-sm text-[#767676]">
            Sign in to your account to claim your ticket.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-8 space-y-3">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-11 w-full rounded-lg border border-black/15 bg-[#fdfdfd] px-3.5 text-sm text-[#1d1b1b] outline-none transition placeholder:text-[#a3a3a0] focus:border-black/40"
          />
          <input
            type="password"
            required
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11 w-full rounded-lg border border-black/15 bg-[#fdfdfd] px-3.5 text-sm text-[#1d1b1b] outline-none transition placeholder:text-[#a3a3a0] focus:border-black/40"
          />

          {error ? <p className="text-[13px] text-red-600">{error}</p> : null}

          <button
            type="submit"
            disabled={busy}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#1d1b1b] text-sm font-medium text-white transition hover:bg-black disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Claim {roleLabel} access
          </button>
        </form>

        <p className="mt-5 text-center text-[12px] text-[#a3a3a0]">
          Single-use link · expires 24h after it was created
        </p>
      </motion.div>
    </Shell>
  );
}
