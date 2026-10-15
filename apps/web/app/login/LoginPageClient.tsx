"use client";

import { Suspense, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { EASE } from "@meridian/ui";
import AuthSplitShell from "../components/AuthSplitShell";
import LoginForm from "../components/LoginForm";
import WaitlistView from "../components/WaitlistView";
import {
  hasSavedName,
  ownSessionFor,
  readWaitlistEmail as readStoredWaitlistEmail,
  readWaitlistFlag,
  saveWaitlistName,
  setWaitlistEmail as storeWaitlistEmail,
  setWaitlistFlag,
} from "@/lib/auth";
import { isSupabaseConfigured, requireSupabase } from "@/lib/supabase";

type WaitlistStep = "login" | "name" | "waitlist";

/**
 * Only allow same-origin, root-relative redirect targets from `?next=`. Rejects
 * absolute URLs (`https://evil.com`), protocol-relative (`//evil.com`), and the
 * backslash trick (`/\evil.com`) that browsers normalise to a host — all of
 * which would turn the login screen into an open-redirect phishing vector.
 */
function safeInternalPath(path: string | null | undefined, fallback: string): string {
  if (typeof path !== "string" || !path.startsWith("/")) return fallback;
  if (path.startsWith("//") || path.startsWith("/\\")) return fallback;
  return path;
}

const inputClass =
  "w-full border border-black/10 bg-transparent px-4 py-3 text-sm text-[#1d1b1b] outline-none transition placeholder:text-[#9a9a9a] focus:border-black/30";

/**
 * The name step runs only when the saved ticket (read with the member's own
 * session at sign-in, never looked up by email) has no name, and while that
 * session still exists: saving the name needs it. Without one the member goes
 * straight to the waitlist screen.
 */
async function needsNameStep(email: string): Promise<boolean> {
  if (hasSavedName(email) || !isSupabaseConfigured) return false;
  return (await ownSessionFor(requireSupabase(), email)) !== null;
}

/** Asked once right after account creation, before the waitlist screen. */
function NameCaptureView({ email, onDone }: { email: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      // Saved with the member's own session, which the sign-in kept for this
      // step; it signs them out afterwards (lib/auth saveWaitlistName).
      await saveWaitlistName(requireSupabase(), email, name.trim());
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-8">
        <div className="w-full max-w-[420px]">
          <header className="text-center">
            <h1 className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-[#1d1b1b]">
              What should we call you?
            </h1>
            <p className="mt-3 text-sm text-[#767676]">
              We&apos;ll put it on your ticket.
            </p>
          </header>

          <form className="mt-8" onSubmit={handleSubmit}>
            <input
              autoFocus
              id="waitlist-name"
              name="name"
              autoComplete="name"
              placeholder="Enter your name"
              aria-label="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />

            {error ? <p className="mt-3 text-center text-xs text-red-600">{error}</p> : null}

            <button
              type="submit"
              disabled={!name.trim() || loading}
              className={`mt-3 flex h-11 w-full items-center justify-center gap-2 border text-sm font-medium transition ${
                name.trim() && !loading
                  ? "border-black/10 bg-[#1c1917] text-white"
                  : "cursor-not-allowed border-black/[0.06] bg-[#eceae7] text-[#9a9a9a]"
              }`}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Continue
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextParam = searchParams.get("next");
  const nextPath = nextParam ?? "/";
  const [step, setStep] = useState<WaitlistStep>("login");
  const [waitlistEmail, setWaitlistEmail] = useState<string | undefined>(undefined);

  useEffect(() => {
    // A deep-link target (e.g. /admin) means the visitor is trying to sign in,
    // not to check waitlist status — never let a stale flag pre-empt the form.
    if (nextParam) {
      setWaitlistFlag(false);
      setStep("login");
      return;
    }
    if (!readWaitlistFlag()) return;

    const stored = readStoredWaitlistEmail() ?? undefined;
    if (stored) setWaitlistEmail(stored);

    let stale = false;
    (async () => {
      // Ask for the name first if the account doesn't have one yet.
      const next: WaitlistStep =
        stored && (await needsNameStep(stored)) ? "name" : "waitlist";
      if (!stale) setStep(next);
    })();
    return () => {
      stale = true;
    };
  }, [nextParam]);

  function handleWaitlist(email?: string) {
    const effective =
      email ?? waitlistEmail ?? readStoredWaitlistEmail() ?? undefined;
    if (effective) {
      setWaitlistEmail(effective);
      storeWaitlistEmail(effective);
    }
    if (!effective) {
      setStep("waitlist");
      return;
    }
    void (async () => {
      setStep((await needsNameStep(effective)) ? "name" : "waitlist");
    })();
  }

  function backToLogin() {
    setWaitlistFlag(false);
    setStep("login");
  }

  // The waitlist screen owns the whole viewport: it plays the choreographed
  // reveal (panel expand → headline → ticket → navbar) over the shader panel.
  if (step === "waitlist") {
    return <WaitlistView email={waitlistEmail} onBack={backToLogin} />;
  }

  return (
    <AuthSplitShell>
      {/* No AnimatePresence here: exit-gated swaps can wedge under StrictMode
          double-mounts in dev, leaving the login form stuck on screen. Enter
          fades are enough. */}
      <>
        {step === "name" && waitlistEmail ? (
          <motion.div
            key="name"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="flex h-full flex-col"
          >
            <NameCaptureView email={waitlistEmail} onDone={() => setStep("waitlist")} />
          </motion.div>
        ) : (
          <motion.div
            key="login"
            initial={false}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="flex h-full flex-col"
          >
            <LoginForm
              onAdminSuccess={() => {
                router.push(safeInternalPath(nextPath, "/admin/dashboard"));
                router.refresh();
              }}
              onTalentSuccess={() => {
                const dest = safeInternalPath(nextPath, "/admin/dashboard/jobs");
                router.push(
                  dest.startsWith("/admin") ? dest : "/admin/dashboard/jobs",
                );
                router.refresh();
              }}
              onSuccess={() => {
                const dest = safeInternalPath(nextPath, "/");
                router.push(dest.startsWith("/admin") ? "/" : dest);
              }}
              onWaitlist={handleWaitlist}
            />
          </motion.div>
        )}
      </>
    </AuthSplitShell>
  );
}

export default function LoginPageClient() {
  return (
    <Suspense fallback={<AuthSplitShell>{null}</AuthSplitShell>}>
      <LoginPageContent />
    </Suspense>
  );
}
