"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { EASE } from "@meridian/ui";
import { cn } from "@/lib/utils";

const inputClass =
  "w-full border border-white/10 bg-transparent px-4 py-3 text-sm text-white outline-none transition placeholder:text-[#666666] focus:border-white/20";

export default function AdminLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showPasswordField = email.trim().length > 0;
  const canContinue = email.trim().length > 0 && password.trim().length > 0;

  async function handleContinue() {
    if (!canContinue || loading) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = (await res.json()) as { error?: string };

      if (!res.ok) {
        throw new Error(data.error ?? "Login failed.");
      }

      router.push("/admin/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-8">
        <div className="w-full max-w-[420px]">
          <header className="text-center">
            <h1 className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-white">
              Welcome to
              <br />
              Falcon
            </h1>
            <p className="mt-3 text-sm text-[#888888]">Admin sign in</p>
          </header>

          <div className="mt-8">
            <input
              id="admin-email"
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
                    id="admin-password"
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
                </motion.div>
              ) : null}
            </AnimatePresence>

            {error ? (
              <p className="mt-3 text-center text-xs text-red-400">{error}</p>
            ) : null}

            <button
              type="button"
              disabled={!canContinue || loading}
              onClick={() => void handleContinue()}
              className={cn(
                "mt-3 flex h-11 w-full items-center justify-center gap-2 border text-sm font-medium transition",
                canContinue && !loading
                  ? "border-white/10 bg-white text-black"
                  : "cursor-not-allowed border-white/[0.06] bg-[#2a2a2a] text-[#666666]",
              )}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Continue
            </button>
          </div>
        </div>
      </div>

      <footer className="shrink-0 px-6 pb-8 text-center text-xs leading-relaxed text-[#666666]">
        Restricted to Falcon administrators.
      </footer>
    </div>
  );
}
