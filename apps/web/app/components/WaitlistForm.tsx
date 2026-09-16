"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Check, Loader2 } from "lucide-react";

// Wire this up to your real waitlist provider later. Until then it simulates success.
const WAITLIST_ENDPOINT = "REPLACE_ME";

type Status = "idle" | "loading" | "success";

type Props = {
  buttonLabel?: string;
  className?: string;
};

export default function WaitlistForm({
  buttonLabel = "Join the Waitlist",
  className = "",
}: Props) {
  const [status, setStatus] = useState<Status>("idle");

  async function handleClick() {
    if (status !== "idle") return;
    setStatus("loading");
    console.log("[Falcon waitlist] join clicked");

    try {
      if (WAITLIST_ENDPOINT !== "REPLACE_ME") {
        const res = await fetch(WAITLIST_ENDPOINT, { method: "POST" });
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      setStatus("success");
    } catch (err) {
      console.error("[Falcon waitlist] error:", err);
      setStatus("idle");
    }
  }

  return (
    <div className={className}>
      <AnimatePresence mode="wait" initial={false}>
        {status === "success" ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="inline-flex items-center justify-center gap-2.5 rounded-full border border-black/[0.1] bg-neutral-50 px-6 py-3.5 text-sm font-medium text-ink"
            role="status"
            aria-live="polite"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ink text-white">
              <Check className="h-3.5 w-3.5" strokeWidth={3} />
            </span>
            You&rsquo;re on the list ✓
          </motion.div>
        ) : (
          <motion.button
            key="button"
            type="button"
            onClick={handleClick}
            disabled={status === "loading"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="group inline-flex h-[52px] items-center justify-center gap-2 rounded-full bg-ink px-7 text-[15px] font-semibold text-white transition hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {status === "loading" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Joining…
              </>
            ) : (
              <>
                {buttonLabel}
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </>
            )}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
