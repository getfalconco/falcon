"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { MutableRefObject, ReactNode, RefObject } from "react";
import { motion } from "framer-motion";

/**
 * Motion for the Desk chat: the reduced-motion switch (Settings > Motion, or
 * the OS setting when Motion is System), the message entrance, and the CSS
 * the thinking shimmer, word fade-in and streaming caret share.
 */

const QUERY = "(prefers-reduced-motion: reduce)";

function calm(): boolean {
  if (typeof document === "undefined") return false;
  const pref = document.documentElement.getAttribute("data-f-motion");
  if (pref === "reduced") return true;
  if (pref === "full") return false;
  return typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-f-motion"] });
  const mq = typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
  mq?.addEventListener("change", onChange);
  return () => {
    mo.disconnect();
    mq?.removeEventListener("change", onChange);
  };
}

/** True when motion should be cut: no movement, no fades, text shown as it arrives. */
export function useCalmMotion(): boolean {
  return useSyncExternalStore(subscribe, calm, () => false);
}

/** Expo-like ease-out: quick start, soft landing. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Messages newer than this when they mount animate in; older ones (a reopened session) just show. */
const FRESH_MS = 1500;

/**
 * A message easing into the thread. The member's own message rises from the
 * composer edge (bottom right) with a light spring; a reply fades up a little.
 */
export function Appear({ from, at, children }: { from: "user" | "assistant"; at: number; children: ReactNode }) {
  const still = useCalmMotion();
  // Decided once, on mount: a message that was just written.
  const [fresh] = useState(() => Date.now() - at < FRESH_MS);
  const user = from === "user";
  return (
    <motion.div
      initial={still || !fresh ? false : user ? { opacity: 0, y: 14, scale: 0.97 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={user ? { type: "spring", duration: 0.22, bounce: 0.18 } : { duration: 0.26, ease: EASE_OUT, delay: 0.05 }}
      style={{ transformOrigin: user ? "100% 100%" : "0% 0%" }}
    >
      {children}
    </motion.div>
  );
}


/**
 * Shared CSS (rendered once by the chat). Keyframes end at the resting look,
 * so the app-wide reduced-motion rule (animation-duration 0) lands on it.
 */
const STYLES = `
.desk-shimmer {
  color: transparent;
  background-image: linear-gradient(100deg, rgb(var(--f-quiet)) 0%, rgb(var(--f-quiet)) 38%, rgb(var(--f-fore)) 50%, rgb(var(--f-quiet)) 62%, rgb(var(--f-quiet)) 100%);
  background-size: 250% 100%;
  background-position: 100% 0;
  -webkit-background-clip: text;
  background-clip: text;
  animation: desk-shimmer 2.2s cubic-bezier(.45,.05,.55,.95) infinite;
}
@keyframes desk-shimmer {
  from { background-position: 100% 0; }
  to { background-position: 0% 0; }
}
.desk-glyph { animation: desk-glyph 2.4s ease-in-out infinite; transform-origin: 50% 50%; }
@keyframes desk-glyph {
  0%, 100% { transform: rotate(0deg) scale(1); opacity: .9; }
  50% { transform: rotate(90deg) scale(.78); opacity: .55; }
}
.desk-word { animation: desk-word-in 170ms cubic-bezier(.2,.7,.3,1) both; }
@keyframes desk-word-in {
  from { opacity: 0; filter: blur(2px); }
  to { opacity: 1; filter: blur(0); }
}
.desk-caret {
  display: inline-block;
  width: .5em;
  height: .5em;
  margin-left: .2em;
  border-radius: 9999px;
  background: rgb(var(--f-fore) / .55);
  vertical-align: .05em;
  animation: desk-caret 1.1s ease-in-out infinite;
}
@keyframes desk-caret {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: .35; transform: scale(.8); }
}
.desk-rise { animation: desk-rise 320ms cubic-bezier(.22,1,.36,1) both; }
@keyframes desk-rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .desk-rise { animation: none; }
  .desk-shimmer { animation: none; color: rgb(var(--f-quiet)); background: none; }
  .desk-glyph, .desk-word, .desk-caret { animation: none; }
}
html[data-f-motion="reduced"] .desk-rise { animation: none; }
html[data-f-motion="reduced"] .desk-shimmer { animation: none; color: rgb(var(--f-quiet)); background: none; }
`;

export function DeskMotionStyles() {
  return <style>{STYLES}</style>;
}

/**
 * Keeps a scroll container at the bottom while its content grows (a reply
 * typing out, a tool row opening) as long as the viewer is there (`pinned`).
 */
export function useStickToBottom(ref: RefObject<HTMLElement>, pinned: MutableRefObject<boolean>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    const watch = () => {
      ro.disconnect();
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    };
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref, pinned]);
}
