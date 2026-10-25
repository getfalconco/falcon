/**
 * The Net worth card's change line, written the way the reader's language
 * writes money and shares: "+$34,586" and "+103.8%" in English, "+$34.586"
 * and "+%103,8" in Turkish, "+34.586 $" in German.
 *
 * The amount drops its cents from a hundred dollars up: past that they say
 * nothing beside a balance that already shows them.
 */

function usd(locale: string, value: number, wholeFrom: number, signed: boolean): Intl.NumberFormat {
  const whole = Math.abs(value) >= wholeFrom;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
    signDisplay: signed ? "exceptZero" : "auto",
  });
}

/**
 * The figure with its digits and separators run together into one mark,
 * the currency and the sign left where the language puts them:
 * "+$*****", "+***** $".
 */
function masked(fmt: Intl.NumberFormat, value: number): string {
  let out = "";
  let starred = false;
  for (const part of fmt.formatToParts(value)) {
    if (part.type === "integer" || part.type === "group" || part.type === "decimal" || part.type === "fraction") {
      if (!starred) out += "*****";
      starred = true;
    } else {
      out += part.value;
    }
  }
  return out;
}

/** The change in dollars, always signed: "+$34,586", "-$412.50". */
export function formatChangeAmount(value: number, locale: string, hide = false): string {
  const fmt = usd(locale, value, 100, true);
  return hide ? masked(fmt, value) : fmt.format(value);
}

/**
 * The change as a share of where the window started, one decimal: "+103.8%",
 * "+%103,8"; unsigned ("103.8%") where an arrow beside it carries the sign.
 */
export function formatChangePercent(ratio: number, locale: string, signed = true): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: signed ? "exceptZero" : "never",
  }).format(ratio);
}

/**
 * From where the window started to the figure shown. No change at all when
 * there is no start yet; no percentage when the start was zero or less, since
 * a share of nothing is not a number.
 */
export function netWorthChange(
  shown: number,
  start: number | null,
): { amount: number; ratio: number | null } | null {
  if (start == null || !Number.isFinite(start) || !Number.isFinite(shown)) return null;
  const amount = shown - start;
  return { amount, ratio: start > 0 ? amount / start : null };
}
