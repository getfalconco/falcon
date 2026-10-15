/**
 * The languages Falcon can be read in, and how one is picked.
 *
 * Only a language with a full message table is listed: a row in the picker is
 * a promise that the menus will change when it is chosen. Each code is the
 * BCP 47 tag handed to `Intl` and set on `<html lang>`, so the same value
 * names the language, formats its numbers and tells the browser how to break
 * and case its text.
 *
 * Pure (no DOM, no storage) so it runs under `node --test`.
 */

export const LANGUAGES = [
  { code: "en-US", nativeName: "English (United States)", englishName: "English (United States)" },
  { code: "tr-TR", nativeName: "Türkçe", englishName: "Turkish" },
  { code: "de-DE", nativeName: "Deutsch", englishName: "German" },
  { code: "fr-FR", nativeName: "Français", englishName: "French" },
  { code: "es-ES", nativeName: "Español", englishName: "Spanish" },
  { code: "it-IT", nativeName: "Italiano", englishName: "Italian" },
  { code: "pt-BR", nativeName: "Português (Brasil)", englishName: "Portuguese (Brazil)" },
  { code: "ja-JP", nativeName: "日本語", englishName: "Japanese" },
  { code: "zh-CN", nativeName: "简体中文", englishName: "Chinese (Simplified)" },
  { code: "ko-KR", nativeName: "한국어", englishName: "Korean" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: LanguageCode = "en-US";

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === "string" && LANGUAGES.some((l) => l.code === value);
}

export function languageInfo(code: LanguageCode): Language {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

/**
 * Traditional Chinese is a different written language to its readers, not a
 * spelling variant: a machine set to it falls through to English rather than
 * being handed Simplified characters.
 */
function isTraditionalChinese(tag: string): boolean {
  return /^zh-(hant|tw|hk|mo)\b/i.test(tag);
}

/**
 * The supported language a list of BCP 47 tags comes to, in the order the
 * machine prefers them (`navigator.languages`): an exact match first, then the
 * same language in another region ("de-AT" reads German, "en-GB" English,
 * "pt-PT" the Brazilian table, the only Portuguese there is). Null when
 * nothing on the list is supported.
 */
export function resolveLanguage(tags: readonly string[]): LanguageCode | null {
  for (const raw of tags) {
    const tag = raw.trim().replace(/_/g, "-");
    if (!tag) continue;
    const exact = LANGUAGES.find((l) => l.code.toLowerCase() === tag.toLowerCase());
    if (exact) return exact.code;
    if (isTraditionalChinese(tag)) continue;
    const primary = tag.split("-")[0]!.toLowerCase();
    const sameLanguage = LANGUAGES.find((l) => l.code.split("-")[0]!.toLowerCase() === primary);
    if (sameLanguage) return sameLanguage.code;
  }
  return null;
}

/**
 * Text folded for matching: case, accents and width dropped, so "francais"
 * finds Français and "TURKCE" finds Türkçe. The Turkish dotless ı and the
 * German ß have no decomposition and are spelled out by hand.
 */
export function foldForSearch(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ß/g, "ss")
    .trim();
}

/**
 * Whether a language answers a search. It is found by its own name, its
 * English name, its code, or any extra names passed in (the picker adds the
 * language's name in the language the app is currently shown in, so a
 * Turkish reader can type "Almanca").
 */
export function matchesLanguage(language: Language, query: string, extraNames: readonly string[] = []): boolean {
  const q = foldForSearch(query);
  if (!q) return true;
  return [language.nativeName, language.englishName, language.code, ...extraNames].some((name) =>
    foldForSearch(name).includes(q),
  );
}
