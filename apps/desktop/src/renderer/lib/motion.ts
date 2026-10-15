import { useSyncExternalStore } from "react";
import { MotionGlobalConfig } from "framer-motion";

/**
 * Motion: whether the app animates. Settings, Appearance, Motion.
 *
 * Shaped like the theme (lib/theme.ts): what the reader asked for is a choice,
 * "system" defers to the machine's "reduce motion" setting, and the choice
 * resolves to one of two states that are put on <html> as `data-motion`.
 *
 * "reduce" is honoured in two places, because the app animates in two ways:
 *  - framer-motion, through `MotionGlobalConfig.skipAnimations`, which makes
 *    every motion component and every `animate()` call land on its end state
 *    at once (enter/exit still happen, just without the travel);
 *  - CSS, through the `[data-motion="reduce"]` block at the end of
 *    `globals.css`, which takes transitions and keyframe animations out.
 *
 * framer-motion ignores the OS setting by default, so "full" is what the app
 * did before this existed.
 */
export type MotionChoice = "system" | "reduce" | "full";
export type Motion = "reduce" | "full";

const KEY = "falcon.ui.motion.choice";
const QUERY = "(prefers-reduced-motion: reduce)";

function systemPrefersReduced(): boolean {
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

export function readMotionChoice(): MotionChoice {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "system" || raw === "reduce" || raw === "full") return raw;
  } catch {
    /* storage is not always there */
  }
  return "system";
}

export function resolveMotion(choice: MotionChoice): Motion {
  if (choice === "system") return systemPrefersReduced() ? "reduce" : "full";
  return choice;
}

/** Put a motion state into effect on the page and in framer-motion. */
export function applyMotion(motion?: Motion): void {
  const next = motion ?? resolveMotion(readMotionChoice());
  document.documentElement.dataset.motion = next;
  MotionGlobalConfig.skipAnimations = next === "reduce";
}

/** Keep the choice and apply it at once. */
export function writeMotionChoice(choice: MotionChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* a choice that cannot be kept is still worth applying */
  }
  applyMotion(resolveMotion(choice));
}

/** While the choice is "system", follow the machine without a relaunch. */
export function watchSystemMotion(): () => void {
  try {
    const media = window.matchMedia(QUERY);
    const onChange = () => {
      if (readMotionChoice() === "system") applyMotion();
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  } catch {
    return () => {};
  }
}

function snapshot(): boolean {
  return document.documentElement.dataset.motion === "reduce";
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  return () => observer.disconnect();
}

/**
 * The resolved state, for a component that picks a different animation when
 * motion is reduced. Use this rather than framer's `useReducedMotion`, which
 * reads the OS alone and would ignore the reader's override.
 */
export function useReducedMotionPref(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
