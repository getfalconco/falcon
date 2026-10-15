/**
 * Upper case, by the rules of the language the text is in.
 *
 * Casing is not the same everywhere: Turkish pairs "i" with "İ" and "ı" with
 * "I". Two mistakes follow when that is ignored:
 *
 *  - Translated Turkish uppercased in JS with `.toUpperCase()` takes the
 *    English rule: "etkinlik" becomes "ETKINLIK" instead of "ETKİNLİK".
 *    Translated text uppercased in JS goes through `upperIn(text, locale)`.
 *  - English shown with CSS `uppercase` (Tailwind's class) inside a document
 *    whose `lang` is Turkish takes the Turkish rule: "Windows" becomes
 *    "WİNDOWS". Text that stays English whatever the app's language (tickers
 *    spelled in lower case, field names, provider and brand labels) is put in
 *    an element marked `lang="en"` (spread `UNTRANSLATED`), or uppercased in
 *    JS with `upperEnglish`.
 *
 * CSS `uppercase` on translated text is right as it is: the document's `lang`
 * follows the app's language (`applyLanguage`), so the browser already cases
 * it the way that language does.
 */

/** Translated text in upper case, the way its language writes it: "ETKİNLİK" in Turkish, "EVENTS" in English. */
export function upperIn(text: string, locale: string): string {
  try {
    return text.toLocaleUpperCase(locale);
  } catch {
    // A tag the runtime does not accept: the root rule is right for every language but Turkish and Azeri.
    return text.toUpperCase();
  }
}

/** Untranslated (English or code) text in upper case, whatever language the app is in: "WINDOWS", never "WİNDOWS". */
export function upperEnglish(text: string): string {
  return text.toLocaleUpperCase("en-US");
}

/**
 * Spread on an element whose content stays English whatever the app's
 * language, so CSS casing (and hyphenation, and a screen reader's voice)
 * follows English rules: `<span {...UNTRANSLATED} className="uppercase">`.
 */
export const UNTRANSLATED = { lang: "en" } as const;
