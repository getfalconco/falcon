import type { MessageKey } from "./i18n";

/**
 * Small language helpers for the graph, Propagation, Gauge and Risk panels.
 * Pure (no React), so the pure formatters in those panels can take a `t` and
 * a locale and stay testable under node.
 */

/** A `t` as the panels' pure helpers take it: the hook's, or a stub in a test. */
export type Translate = (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => string;

/** Every key stem that has both a `.one` and an `.other` message. */
export type PluralBase = {
  [K in MessageKey]: K extends `${infer B}.one` ? (`${B}.other` extends MessageKey ? B : never) : never;
}[MessageKey];

const rules = new Map<string, Intl.PluralRules>();

function pluralRules(locale: string): Intl.PluralRules {
  let r = rules.get(locale);
  if (!r) {
    try {
      r = new Intl.PluralRules(locale);
    } catch {
      r = new Intl.PluralRules("en-US");
    }
    rules.set(locale, r);
  }
  return r;
}

/**
 * The message for a count: `.one` where the language says "one" for `n`,
 * `.other` everywhere else (French "many", Japanese's single form, ...).
 * `{n}` is filled with the count unless the caller passes its own.
 */
export function plural(
  t: Translate,
  locale: string,
  base: PluralBase,
  n: number,
  vars: Readonly<Record<string, string | number>> = {},
): string {
  const form = pluralRules(locale).select(n) === "one" ? "one" : "other";
  return t(`${base}.${form}` as MessageKey, { n, ...vars });
}

/**
 * A span of time as words in the reader's language ("12 min", "1.5 hr",
 * "3 days"), for lags and ages. Not a financial figure, so the locale's own
 * digits and decimal mark apply.
 */
export function formatDuration(ms: number, locale: string): string {
  const min = Math.round(ms / 60000);
  const unit = (value: number, u: "minute" | "hour" | "day", digits = 0) => {
    try {
      return new Intl.NumberFormat(locale, {
        style: "unit",
        unit: u,
        unitDisplay: "short",
        maximumFractionDigits: digits,
      }).format(value);
    } catch {
      return `${value.toFixed(digits)} ${u}`;
    }
  };
  if (min < 60) return unit(min, "minute");
  const h = ms / 3600000;
  if (h < 48) return unit(Math.round(h * 10) / 10, "hour", 1);
  return unit(Math.round(h / 24), "day");
}

/** A list joined the way the language joins one ("A and B", "A und B", "A、B"). */
export function formatList(items: readonly string[], locale: string, type: "conjunction" | "unit" = "conjunction"): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type }).format(items);
  } catch {
    return items.join(", ");
  }
}
