import { Fragment, createElement, useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import {
  DEFAULT_LANGUAGE,
  isLanguageCode,
  languageInfo,
  resolveLanguage,
  type Language,
  type LanguageCode,
} from "./languages";
import { interpolateParts, messageFor, translate, type MessageVars } from "./translate";
import type { MessageKey } from "./messages";

/**
 * The language the app is shown in, and the hooks components read it with.
 *
 * Kept the way the theme is (lib/theme.ts): one module-level value, stored
 * in localStorage, read through `useSyncExternalStore`. No provider is needed,
 * so the panels main.tsx mounts beside <App /> (Tracker, Base, Risk...) and
 * the preview harnesses get the same language without being wrapped, and a
 * change re-renders every reader at once, without a reload.
 *
 *   const t = useT();
 *   t("menu.settings")                      // "Settings" / "Ayarlar" / ...
 *   t("home.greeting.morning", { name })    // "Morning, Kuzey"
 *
 * Until a choice is made the app follows the machine's language when Falcon
 * has it, and English when it does not.
 */

export { LANGUAGES, languageInfo, matchesLanguage, type Language, type LanguageCode } from "./languages";
export type { MessageKey } from "./messages";
export type { MessageVars } from "./translate";
export { UNTRANSLATED, upperEnglish, upperIn } from "./casing";

const KEY = "falcon.ui.language";

function machineLanguages(): readonly string[] {
  try {
    if (navigator.languages?.length) return navigator.languages;
    return navigator.language ? [navigator.language] : [];
  } catch {
    return [];
  }
}

/** The kept choice, if there is one and it is still a language Falcon has. */
export function readLanguageChoice(): LanguageCode | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (isLanguageCode(raw)) return raw;
  } catch {
    /* storage is not always there */
  }
  return null;
}

/** The kept choice, else the machine's language, else English. */
export function getStoredLanguage(): LanguageCode {
  return readLanguageChoice() ?? resolveLanguage(machineLanguages()) ?? DEFAULT_LANGUAGE;
}

let current: LanguageCode | null = null;
const listeners = new Set<() => void>();

export function getLanguage(): LanguageCode {
  if (current === null) current = getStoredLanguage();
  return current;
}

/**
 * Tells the document what it is written in: hyphenation, casing, the screen
 * reader's voice. Also tells the main process, whose notifications and
 * native dialogs follow the same choice (it keeps the last one on disk, so
 * an alert fired before this window loads still reads in it).
 */
export function applyLanguage(code: LanguageCode = getLanguage()): void {
  try {
    document.documentElement.lang = code;
  } catch {
    /* no document under a test runner */
  }
  try {
    void window.meridian?.setLanguage?.(code)?.catch(() => {});
  } catch {
    /* no bridge in a preview harness or under a test runner */
  }
}

/** Keep the choice and put it into effect at once, everywhere. */
export function setLanguage(code: LanguageCode): void {
  try {
    localStorage.setItem(KEY, code);
  } catch {
    /* a choice that cannot be kept is still worth applying */
  }
  if (code === current) return;
  current = code;
  applyLanguage(code);
  for (const listener of listeners) listener();
}

export function subscribeLanguage(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another window of the app writing the key moves this one too.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    const next = readLanguageChoice() ?? getStoredLanguage();
    if (next === current) return;
    current = next;
    applyLanguage(next);
    onChange();
  };
  try {
    window.addEventListener("storage", onStorage);
  } catch {
    /* no window */
  }
  return () => {
    listeners.delete(onChange);
    try {
      window.removeEventListener("storage", onStorage);
    } catch {
      /* no window */
    }
  };
}

/** The language in force, re-rendering the caller when it changes. */
export function useLanguage(): LanguageCode {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}

export type TFunction = (key: MessageKey, vars?: MessageVars) => string;

/** `t(key, vars)` in the current language. */
export function useT(): TFunction {
  const language = useLanguage();
  return useCallback<TFunction>((key, vars) => translate(language, key, vars), [language]);
}

/**
 * Everything at once: the language, its row in the list, a `t`, and `tNodes`
 * for messages that carry markup (`t` with React nodes as values, returned
 * as children). `locale` is the tag to hand `Intl` for numbers and dates.
 */
export function useI18n(): {
  language: LanguageCode;
  info: Language;
  locale: string;
  t: TFunction;
  tNodes: (key: MessageKey, nodes: Readonly<Record<string, ReactNode>>) => ReactNode[];
  setLanguage: (code: LanguageCode) => void;
} {
  const language = useLanguage();
  const t = useT();
  return useMemo(
    () => ({
      language,
      info: languageInfo(language),
      locale: language,
      t,
      tNodes: (key, nodes) =>
        interpolateParts<ReactNode>(messageFor(language, key), nodes).map((part, i) =>
          createElement(Fragment, { key: i }, part),
        ),
      setLanguage,
    }),
    [language, t],
  );
}
