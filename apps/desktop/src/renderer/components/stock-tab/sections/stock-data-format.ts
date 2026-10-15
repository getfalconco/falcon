/**
 * Number and date formatting for the Changes, Earnings and Competitors
 * sections, in the reader's language. Pure (Intl only), so a test can run it.
 */

import type { TrendPeriod } from "../../../../shared/stock-tab-data";

function numberFormat(lang: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(lang, options);
  } catch {
    return new Intl.NumberFormat("en-US", options);
  }
}

function dateFormat(lang: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(lang, { ...options, timeZone: "UTC" });
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }
}

/** A change as a signed percent of the earlier value: "+4.4%". */
export function changePct(now: number, before: number, lang: string): string {
  if (!Number.isFinite(now) || !Number.isFinite(before) || before === 0) return "";
  return numberFormat(lang, { style: "percent", signDisplay: "exceptZero", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format((now - before) / Math.abs(before));
}

/** A share of something, from a fraction: "1.34%". */
export function sharePct(fraction: number, lang: string): string {
  return numberFormat(lang, { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(fraction);
}

/** A count, compact: "311.4M". */
export function compactCount(n: number, lang: string): string {
  return numberFormat(lang, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** A whole count with grouping: "1,500". */
export function wholeCount(n: number, lang: string): string {
  return numberFormat(lang, { maximumFractionDigits: 0 }).format(n);
}

/** A price in its currency: "$328.72"; a plain number when the currency is unknown. */
export function price(value: number, currency: string | null, lang: string): string {
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    return numberFormat(lang, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  }
  return numberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/** A dollar amount, compact: "$271K". */
export function compactUsd(value: number, lang: string): string {
  return numberFormat(lang, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** A correlation to two places: "0.62", "-0.10". */
export function correlation(value: number, lang: string): string {
  return numberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/** "Oct 9, 2026" in the reader's language. */
export function fullDate(ymd: string, lang: string): string {
  return dateFormat(lang, { year: "numeric", month: "short", day: "numeric" }).format(new Date(`${ymd}T12:00:00.000Z`));
}

/** The message key suffix for a consensus period. */
export function periodKey(p: TrendPeriod): "q0" | "q1" | "y0" | "y1" {
  return p === "0q" ? "q0" : p === "+1q" ? "q1" : p === "0y" ? "y0" : "y1";
}

const CATEGORIES = new Set(["supplier", "customer", "partner", "competitor", "dependency"]);

/** The category as one of the five the copy names, or null for anything else (printed as given). */
export function categoryKey(category: string): "supplier" | "customer" | "partner" | "competitor" | "dependency" | null {
  const c = category.trim().toLowerCase();
  return CATEGORIES.has(c) ? (c as "supplier") : null;
}
