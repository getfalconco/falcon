import { getLanguage, useT } from "./index";
import { translate } from "./translate";
import type { LanguageCode } from "./languages";

/**
 * What a table cell, card or panel prints for a value that is missing or not
 * computable ("n/a", "yok", "k. A.", ...): never a dash (house copy rule,
 * shared/copy-rules.ts) and never a zero (a missing number must not read as a
 * measured one). One word, one key (`common.na`), for the whole app.
 *
 *   const na = useNa();        // in a component
 *   na()                       // in a pure formatter that runs during render
 */

/**
 * The word in the language in force, read at call time. For formatters that
 * run during render: every reader re-renders through useT/useI18n when the
 * language changes, so the word follows without being passed in.
 */
export function na(language: LanguageCode = getLanguage()): string {
  return translate(language, "common.na");
}

/** The word in the language in force, re-rendering the caller when it changes. */
export function useNa(): string {
  return useT()("common.na");
}
