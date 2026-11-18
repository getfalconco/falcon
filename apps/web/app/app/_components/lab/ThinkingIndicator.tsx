"use client";

import { AnimatePresence, motion } from "framer-motion";
import LoadingState from "@/components/ui/loading-state";
import { EASE_OUT, useCalmMotion } from "./motion";

/**
 * "Thinking" while a reply has not started, and between tool rounds: the
 * pixel-grid loading state (components/ui/loading-state.tsx, Dots) with the
 * time spent so far. It folds away (fade and collapse) when the text starts.
 * Decorative to screen readers: the chat's status region announces
 * "Thinking" (lab/Announcer.tsx).
 *
 * `startedAt`: when this wait began (the reply's creation time before
 * anything arrived), so the timer keeps counting through a remount or a
 * resumed reply; between tool rounds it counts from when the row appeared.
 */
export function ThinkingIndicator({ show, phase, startedAt }: { show: boolean; phase: "start" | "tools"; startedAt?: number }) {
  const still = useCalmMotion();
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div
          key="thinking"
          aria-hidden
          initial={still ? false : { opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={still ? { opacity: 0, height: 0, transition: { duration: 0 } } : { opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: EASE_OUT }}
          className="overflow-hidden"
        >
          <div className="flex items-center py-0.5 leading-fs-24">
            <LoadingState label="Thinking" variant="Dots" announce={false} startedAt={phase === "start" ? startedAt : undefined} />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
