import { withClock } from "./clock";

/**
 * Dates and ages on the dashboard cards, in the reader's language. Month and
 * day names come from Intl, never from a hand-kept list, so a German reader
 * gets "Okt." and a Japanese one "10月" without a table to keep in step.
 * Times of day still go through the clock setting (`withClock`).
 *
 * Pure: safe to import from node-side tests.
 */

function valid(d: Date): boolean {
  return Number.isFinite(d.getTime());
}

/** `Oct 10` / `10. Okt.` / `10月10日` */
export function monthDay(d: Date, locale: string): string {
  if (!valid(d)) return "";
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(d);
}

/** `Oct` / `Okt.` / `10月` */
export function monthShort(d: Date, locale: string): string {
  if (!valid(d)) return "";
  return new Intl.DateTimeFormat(locale, { month: "short" }).format(d);
}

/** `Mon` / `Mo` / `月` */
export function weekdayShort(d: Date, locale: string): string {
  if (!valid(d)) return "";
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d);
}

/** `Oct 10, 2026` / `10. Okt. 2026` */
export function monthDayYear(d: Date, locale: string): string {
  if (!valid(d)) return "";
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }).format(d);
}

/**
 * `Aug 22, 11:08 PM`: a date and a time of day. English keeps the 12-hour
 * clock the cards were drawn in; other languages take their own habit, and
 * the clock setting overrides both.
 */
export function monthDayTime(d: Date, locale: string): string {
  if (!valid(d)) return "";
  const base: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  const options = locale.toLowerCase().startsWith("en") ? { ...base, hour12: true } : base;
  return new Intl.DateTimeFormat(locale, withClock(options)).format(d);
}

/**
 * A story's age at a glance: `12m ago`, `3h ago`, `2d ago`. Under a minute it
 * is `justNow`, which the caller supplies in the reader's language. English
 * keeps its narrow form; elsewhere the short form reads better (the narrow
 * French and German forms are cryptic).
 */
export function agoLabel(unixSec: number, nowMs: number, locale: string, justNow: string): string {
  const s = Math.max(0, Math.round(nowMs / 1000 - unixSec));
  if (s < 60) return justNow;
  const style: Intl.RelativeTimeFormatStyle = locale.toLowerCase().startsWith("en") ? "narrow" : "short";
  const rtf = new Intl.RelativeTimeFormat(locale, { style, numeric: "always" });
  const m = Math.floor(s / 60);
  if (m < 60) return rtf.format(-m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return rtf.format(-h, "hour");
  return rtf.format(-Math.floor(h / 24), "day");
}
