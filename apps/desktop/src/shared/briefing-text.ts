/**
 * How the pure briefing and calendar views get their words in the reader's
 * language without importing React or the language store.
 *
 * A view takes a `BriefingText`: a `t` over the briefing area's keys and the
 * Intl locale for the names of months and weekdays. The renderer hands in the
 * live one (`useBriefingText` in components/briefing); everything else (the
 * main process, tests, an older call site) gets `ENGLISH`, which reads the
 * same English table the renderer falls back to, so a view called without one
 * says exactly what it said before it was translatable.
 *
 * Pure: no DOM, no storage. Compiled for the main process too.
 */

import { en as briefingEn } from "../renderer/lib/i18n/messages/areas/briefing";

export type BriefingKey = keyof typeof briefingEn;

export type TextVars = Readonly<Record<string, string | number>>;

export type BriefingText = {
  t: (key: BriefingKey, vars?: TextVars) => string;
  /** The tag handed to Intl for month and weekday names, "en-US", "tr-TR"... */
  locale: string;
  /**
   * Laid over the options of every time-of-day formatter: the reader's 12 or
   * 24 hour choice (lib/clock.ts `withClock`). Identity when left out.
   */
  clock?: (options: Intl.DateTimeFormatOptions) => Intl.DateTimeFormatOptions;
};

const PLACEHOLDER = /\{(\w+)\}/g;

function fill(template: string, vars?: TextVars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/** The English table, as the renderer's own fallback reads it. */
export const ENGLISH: BriefingText = {
  t: (key, vars) => fill(briefingEn[key] ?? key, vars),
  locale: "en-US",
};

// ---------------------------------------------------------------------------
// Calendar dates in the reader's language
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One formatter per locale and option set: building them is the slow part of Intl. */
export function formatterFor(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = formatters.get(key);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(locale, options);
    } catch {
      format = new Intl.DateTimeFormat("en-US", options);
    }
    formatters.set(key, format);
  }
  return format;
}

/**
 * A "YYYY-MM-DD" calendar date as UTC noon, or null when it is not a real
 * date. A session date is a calendar date, not an instant: read at noon UTC
 * and formatted in UTC, no zone offset can push it onto a neighbouring day.
 */
export function ymdNoonUtc(ymd: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  if (at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return at;
}

/** "Mon Sep 28", "28 Eyl Pzt", "9月28日(月)". An unreadable date is shown as it came. */
export function weekdayDateLabel(ymd: string, text: BriefingText = ENGLISH): string {
  const at = ymdNoonUtc(ymd);
  if (!at) return ymd ?? "";
  return text.t("briefing.date.weekdayDate", {
    weekday: formatterFor(text.locale, { weekday: "short", timeZone: "UTC" }).format(at),
    month: formatterFor(text.locale, { month: "short", timeZone: "UTC" }).format(at),
    day: at.getUTCDate(),
  });
}

/** "Oct 31, 2026", "31 Eki 2026", "2026年10月31日". */
export function fullDateLabel(ymd: string, text: BriefingText = ENGLISH): string {
  const at = ymdNoonUtc(ymd);
  if (!at) return ymd ?? "";
  return formatterFor(text.locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(at);
}

/** "September 2026", "Eylül 2026", "2026年9月", for a month the engine names in English. */
export function monthYearLabel(year: number, month: number, text: BriefingText = ENGLISH): string {
  const at = new Date(Date.UTC(year, month - 1, 15, 12));
  return formatterFor(text.locale, { year: "numeric", month: "long", timeZone: "UTC" }).format(at);
}
