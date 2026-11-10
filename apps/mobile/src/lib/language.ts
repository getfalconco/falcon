import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * The app language picked on the landing screen. Only the choice is kept for
 * now (on the device); the app is not translated yet.
 */
export const LANGUAGES = [
  { code: "en-US", label: "English (US)", flag: "🇺🇸" },
  { code: "tr", label: "Türkçe", flag: "🇹🇷" },
  { code: "de", label: "Deutsch", flag: "🇩🇪" },
  { code: "fr", label: "Français", flag: "🇫🇷" },
  { code: "es", label: "Español", flag: "🇪🇸" },
  { code: "it", label: "Italiano", flag: "🇮🇹" },
  { code: "pt-BR", label: "Português (Brasil)", flag: "🇧🇷" },
  { code: "ja", label: "日本語", flag: "🇯🇵" },
  { code: "zh-CN", label: "简体中文", flag: "🇨🇳" },
  { code: "ko", label: "한국어", flag: "🇰🇷" },
] as const;

export type Language = (typeof LANGUAGES)[number];
export type LanguageCode = Language["code"];

const STORAGE_KEY = "falcon.language";
const DEFAULT: Language = LANGUAGES[0];

let current: Language = DEFAULT;
const listeners = new Set<() => void>();

function find(code: string | null): Language | undefined {
  return LANGUAGES.find((language) => language.code === code);
}

function emit() {
  listeners.forEach((listener) => listener());
}

// Restore the saved choice once, as early as possible.
void AsyncStorage.getItem(STORAGE_KEY)
  .then((saved) => {
    const language = find(saved);
    if (language && language !== current) {
      current = language;
      emit();
    }
  })
  .catch(() => {});

export function setLanguage(code: LanguageCode) {
  const language = find(code);
  if (!language || language === current) return;
  current = language;
  emit();
  void AsyncStorage.setItem(STORAGE_KEY, code).catch(() => {});
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current app language; re-renders when it changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
