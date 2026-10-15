import type { MessageKey } from "@/lib/i18n";

/**
 * Small language rules the settings panes share: which plural form a count
 * takes, and how a list of phrases is joined. Both come from Intl, so each
 * language gets its own grammar instead of English's "s" and "and".
 */

const pluralRules = new Map<string, Intl.PluralRules>();

/**
 * The key for a count: `one` where the language treats the count as singular
 * (English 1, French 0 and 1), `other` everywhere else. Languages without a
 * plural form (Japanese, Chinese, Korean, Turkish after a number) translate
 * both keys the same.
 */
export function pluralKey(locale: string, count: number, one: MessageKey, other: MessageKey): MessageKey {
  let rules = pluralRules.get(locale);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      rules = new Intl.PluralRules("en-US");
    }
    pluralRules.set(locale, rules);
  }
  return rules.select(count) === "one" ? one : other;
}

/** "a, b and c" in the reader's language ("a, b ve c", "a、b、c"). */
export function listText(locale: string, items: readonly string[], type: "conjunction" | "disjunction" = "conjunction"): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type }).format(items);
  } catch {
    return items.join(", ");
  }
}

/**
 * The same, as pieces: each item's index where it goes and the language's own
 * joining words between, so items that are not text (keycaps) can be joined.
 */
export function listParts(
  locale: string,
  count: number,
  type: "conjunction" | "disjunction" = "conjunction",
): Array<{ item: number } | { literal: string }> {
  const marks = Array.from({ length: count }, (_, i) => `\u0001${i}\u0001`);
  let parts: Array<{ type: string; value: string }>;
  try {
    parts = new Intl.ListFormat(locale, { style: "long", type }).formatToParts(marks);
  } catch {
    parts = marks.flatMap((m, i) => (i === 0 ? [{ type: "element", value: m }] : [{ type: "literal", value: ", " }, { type: "element", value: m }]));
  }
  return parts.map((p) =>
    p.type === "element" ? { item: Number(p.value.replace(/\u0001/g, "")) } : { literal: p.value },
  );
}

/** A count of hours or minutes in words, in the reader's language ("6 hours", "6 Stunden", "6時間"). */
export function durationText(locale: string, value: number, unit: "hour" | "minute"): string {
  try {
    return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(value);
  } catch {
    return `${value} ${unit}${value === 1 ? "" : "s"}`;
  }
}
