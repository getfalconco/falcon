import type { MessageKey } from "@/lib/i18n";

/**
 * Which of two keys a count reads with, by the language's own plural rule:
 * French puts 0 with 1, Japanese, Chinese and Korean have one form for every
 * count, Turkish keeps the noun singular after a number. Used by the
 * instrument panels (Base, Analyst, Quant Lab), whose messages carry their
 * `.one` / `.other` pair in every language.
 */
export function plural(locale: string, n: number, one: MessageKey, other: MessageKey): MessageKey {
  let category: Intl.LDMLPluralRule = "other";
  try {
    category = new Intl.PluralRules(locale).select(n);
  } catch {
    category = n === 1 ? "one" : "other";
  }
  return category === "one" ? one : other;
}
