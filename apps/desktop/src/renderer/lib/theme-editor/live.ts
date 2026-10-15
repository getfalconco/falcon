import { applyTheme, getStoredTheme, getThemeSnapshot } from "../theme";
import { OVERRIDES_KEY, overridesCss, readOverrides, writeOverrides, type ThemeOverrides } from "./overrides";

/**
 * The app window's half of the dark theme editor: puts the local overrides on
 * the page, and keeps them current while the editor window changes them.
 *
 * The editor writes the overrides to localStorage; a write in one window of
 * the app fires a `storage` event in every other window of the same origin
 * (the main window and the editor share one in Electron, dev server or
 * packaged), so this listens for that and rewrites one <style> element. The
 * rules are scoped to `:root[data-theme="dark"]`, so they show only while the
 * app is dark and stay put, unused, while it is light.
 *
 * The editor's "Switch app to dark" button writes the theme choice the same
 * way. lib/theme.ts does not follow another window's write by itself, so this
 * also puts the kept theme into effect when it no longer matches the page.
 */

const STYLE_ID = "theme-overrides";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Writes the overrides into this document's <style id="theme-overrides">, or removes it when there are none. */
export function applyOverrides(overrides: ThemeOverrides, doc: Document = document): void {
  const css = overridesCss(overrides);
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = doc.createElement("style");
    el.id = STYLE_ID;
  }
  // Always last in <head>, after whatever stylesheets loaded since, so equal rules lose to it.
  if (el.parentNode !== doc.head || el !== doc.head.lastElementChild) doc.head.appendChild(el);
  if (el.textContent !== css) el.textContent = css;
}

/** Reads the kept overrides. */
export function loadOverrides(): ThemeOverrides {
  return readOverrides(storage());
}

/** Keeps the overrides; other windows hear of it through the storage event. */
export function saveOverrides(overrides: ThemeOverrides): void {
  writeOverrides(storage(), overrides);
}

/**
 * Call once in the app window, after the theme is applied. Returns a function
 * that stops listening (the app never calls it; tests and harnesses may).
 */
export function installThemeOverrides(): () => void {
  applyOverrides(loadOverrides());
  const onStorage = (e: StorageEvent) => {
    // A null key is `localStorage.clear()`.
    if (e.key === OVERRIDES_KEY || e.key === null) applyOverrides(loadOverrides());
    if (e.key !== OVERRIDES_KEY) {
      const kept = getStoredTheme();
      if (kept !== getThemeSnapshot()) applyTheme(kept, { animate: true });
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
