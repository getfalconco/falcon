"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { DARK_QUERY, DARK_THEME_COLOR, LIGHT_THEME_COLOR, THEME_LAST_KEY } from "./theme-boot";

/**
 * Appearance settings for the Workspace: theme, interface font, text size,
 * reading width and motion. Saved in this browser per user; applied to
 * <html> as `.dark` plus `data-f-*` attributes that app/globals.css reads.
 * Every storage call is guarded: without storage the defaults still render.
 */

export type ThemePref = "system" | "light" | "dark";
export type FontPref = "geist" | "system";
export type SizePref = "small" | "medium" | "large";
export type WidthPref = "narrow" | "wide";
export type MotionPref = "system" | "reduced" | "full";

export type Appearance = {
  theme: ThemePref;
  font: FontPref;
  size: SizePref;
  width: WidthPref;
  motion: MotionPref;
};

export const DEFAULT_APPEARANCE: Appearance = { theme: "system", font: "geist", size: "medium", width: "wide", motion: "system" };

const storageKey = (userId: string) => `falcon.appearance.v1:${userId}`;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function clean(raw: unknown): Appearance {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_APPEARANCE;
  return {
    theme: pick(o.theme, ["system", "light", "dark"], d.theme),
    font: pick(o.font, ["geist", "system"], d.font),
    size: pick(o.size, ["small", "medium", "large"], d.size),
    width: pick(o.width, ["narrow", "wide"], d.width),
    motion: pick(o.motion, ["system", "reduced", "full"], d.motion),
  };
}

export function readAppearance(userId: string): Appearance {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (raw) return clean(JSON.parse(raw));
    // A first visit for this user keeps the theme this browser last showed.
    const last = window.localStorage.getItem(THEME_LAST_KEY);
    return { ...DEFAULT_APPEARANCE, theme: pick(last, ["system", "light", "dark"], DEFAULT_APPEARANCE.theme) };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function writeAppearance(userId: string, a: Appearance) {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(a));
    window.localStorage.setItem(THEME_LAST_KEY, a.theme);
  } catch {
    // Storage full or blocked: the setting still applies for this visit.
  }
}

function systemDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

export function resolveTheme(pref: ThemePref): "light" | "dark" {
  return pref === "dark" || (pref === "system" && systemDark()) ? "dark" : "light";
}

/** Puts the theme on <html>: class, color-scheme and the browser's theme color. */
export function applyTheme(theme: "light" | "dark") {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  root.dataset.fTheme = theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", theme === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR));
}

export function applyAppearance(a: Appearance) {
  applyTheme(resolveTheme(a.theme));
  const d = document.documentElement.dataset;
  d.fFont = a.font;
  d.fSize = a.size;
  d.fWidth = a.width;
  d.fMotion = a.motion;
}

/** Leaving /app: the marketing pages never see the Workspace theme. */
export function clearAppearance() {
  const root = document.documentElement;
  root.classList.remove("dark");
  root.style.colorScheme = "";
  for (const k of ["fTheme", "fFont", "fSize", "fWidth", "fMotion"]) delete root.dataset[k];
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", LIGHT_THEME_COLOR));
}

/** The /app shell before the user is known: the last theme this browser showed (the inline script did the same before paint). */
export function useBootTheme() {
  const useIso = typeof window === "undefined" ? useEffect : useLayoutEffect;
  useIso(() => {
    if (!document.documentElement.dataset.fTheme) {
      let last: unknown = null;
      try {
        last = window.localStorage.getItem(THEME_LAST_KEY);
      } catch {
        // No storage: light, or the system's choice.
      }
      applyTheme(resolveTheme(pick(last, ["system", "light", "dark"], "system")));
    }
    return clearAppearance;
  }, []);
}

/* ------------------------------------------------------------- context */

export type AppearanceApi = {
  appearance: Appearance;
  /** The theme on screen now ("system" resolved). */
  resolved: "light" | "dark";
  update: (patch: Partial<Appearance>) => void;
};

export const AppearanceContext = createContext<AppearanceApi | null>(null);

export function useAppearance(): AppearanceApi {
  const api = useContext(AppearanceContext);
  if (!api) throw new Error("useAppearance outside AppearanceContext");
  return api;
}

/** One user's appearance: read once, applied before paint, saved on change, live with the system theme and other tabs. */
export function useAppearanceState(userId: string): AppearanceApi {
  const [appearance, setAppearance] = useState<Appearance>(() => readAppearance(userId));
  const [sysDark, setSysDark] = useState(() => (typeof window === "undefined" ? false : systemDark()));

  useLayoutEffect(() => {
    applyAppearance(appearance);
  }, [appearance, sysDark]);

  // System theme follows the OS live.
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(DARK_QUERY);
    } catch {
      return;
    }
    const on = () => setSysDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // A change in another tab of the same browser.
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key === storageKey(userId)) setAppearance(readAppearance(userId));
    };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, [userId]);

  const update = useCallback(
    (patch: Partial<Appearance>) =>
      setAppearance((prev) => {
        const next = { ...prev, ...patch };
        writeAppearance(userId, next);
        return next;
      }),
    [userId],
  );

  const resolved: "light" | "dark" = appearance.theme === "system" ? (sysDark ? "dark" : "light") : appearance.theme;
  return useMemo(() => ({ appearance, resolved, update }), [appearance, resolved, update]);
}
