/**
 * Calendar tab: date and time-zone arithmetic.
 *
 * Days are "YYYY-MM-DD" strings throughout, read through UTC noon so no zone
 * offset can push one onto its neighbour (the same rule `calendar-view` uses).
 * Instants are epoch milliseconds. Turning one into the other always names a
 * zone: the reader's own (`undefined`, which Intl reads as the runtime's
 * zone) or New York's, which is what the market events are scheduled in.
 *
 * Pure: whatever depends on the clock takes `now`.
 */

export const NY_ZONE = "America/New_York";

export type CalendarViewMode = "day" | "week" | "month";
/** 0 is Sunday, 1 is Monday. */
export type WeekStart = 0 | 1;

export const DAY_MS = 86_400_000;
export const MINUTES_PER_DAY = 1440;

type Parts = { y: number; m: number; d: number };

function parts(ymd: string): Parts {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function ymdOf(y: number, m: number, d: number): string {
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

export function addDays(ymd: string, n: number): string {
  const { y, m, d } = parts(ymd);
  return ymdOf(y, m, d + n);
}

export function addMonths(ymd: string, n: number): string {
  const { y, m, d } = parts(ymd);
  // Day clamped to the target month: Jan 31 plus one month is Feb 28, not Mar 3.
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0, 12)).getUTCDate();
  return ymdOf(y, m + n, Math.min(d, last));
}

/** 0 for Sunday. */
export function weekday(ymd: string): number {
  const { y, m, d } = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS);
}

export function startOfWeek(ymd: string, weekStart: WeekStart): string {
  return addDays(ymd, -((weekday(ymd) - weekStart + 7) % 7));
}

export function startOfMonth(ymd: string): string {
  const { y, m } = parts(ymd);
  return ymdOf(y, m, 1);
}

export function sameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** Every date from `from` through `to`, both included. */
export function daysFrom(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The six weeks a month grid shows: always 42 days, so the grid does not change height between months. */
export function monthGrid(anchor: string, weekStart: WeekStart): string[] {
  const first = startOfWeek(startOfMonth(anchor), weekStart);
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

/**
 * The days a view shows around its anchor date. With weekends hidden, a week
 * still keeps `today` when today is a Saturday or a Sunday: hiding the day
 * the reader is on would leave the week with no today in it, so that one
 * weekend column stays, in its place, and the other weekend day goes.
 */
export function visibleDays(view: CalendarViewMode, anchor: string, weekStart: WeekStart, showWeekends = true, today?: string): string[] {
  if (view === "day") return [anchor];
  if (view === "month") return monthGrid(anchor, weekStart);
  const week = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor, weekStart), i));
  return showWeekends ? week : week.filter((d) => d === today || (weekday(d) !== 0 && weekday(d) !== 6));
}

/** The anchor one step back or on: a day, a week or a month. */
export function stepAnchor(view: CalendarViewMode, anchor: string, direction: -1 | 1): string {
  if (view === "day") return addDays(anchor, direction);
  if (view === "week") return addDays(anchor, 7 * direction);
  return addMonths(anchor, direction);
}

// ---------------------------------------------------------------------------
// Names, in the reader's language
// ---------------------------------------------------------------------------

/**
 * Month and weekday names come from Intl in the reader's locale ("en-US"
 * unless a caller passes another), never from an English table. Dates are
 * read at UTC noon and formatted in UTC, so the name is the date's own
 * whatever zone the machine is in.
 */
const nameFormatters = new Map<string, Intl.DateTimeFormat>();

function names(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = nameFormatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
    }
    nameFormatters.set(key, f);
  }
  return f;
}

function noonUtc(ymd: string): Date {
  const { y, m, d } = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function monthPart(ymd: string, locale: string): string {
  return names(locale, { year: "numeric", month: "short" }).formatToParts(noonUtc(ymd)).find((p) => p.type === "month")?.value ?? "";
}

/** "October 2026", "Ekim 2026", "2026年10月". */
export function monthTitle(ymd: string, locale = "en-US"): string {
  return names(locale, { year: "numeric", month: "long" }).format(noonUtc(ymd));
}

/**
 * The head's title. A month, or the two months a week straddles ("Sep - Oct
 * 2026", a plain hyphen: long dashes are kept out of the app's copy), or the
 * day spelled out.
 */
export function rangeTitle(view: CalendarViewMode, anchor: string, weekStart: WeekStart, locale = "en-US"): string {
  if (view === "day") return names(locale, { weekday: "short", year: "numeric", month: "short", day: "numeric" }).format(noonUtc(anchor));
  if (view === "month") return monthTitle(anchor, locale);
  const first = startOfWeek(anchor, weekStart);
  const last = addDays(first, 6);
  if (sameMonth(first, last)) return monthTitle(first, locale);
  const monthYear = names(locale, { year: "numeric", month: "short" });
  if (first.slice(0, 4) !== last.slice(0, 4)) return `${monthYear.format(noonUtc(first))} - ${monthYear.format(noonUtc(last))}`;
  // One year: the later month's "Oct 2026" with its month part widened to "Sep - Oct".
  return monthYear
    .formatToParts(noonUtc(last))
    .map((p) => (p.type === "month" ? `${monthPart(first, locale)} - ${p.value}` : p.value))
    .join("");
}

/** ISO week number, for the small "W41" beside the week title. */
export function isoWeek(ymd: string): number {
  const thursday = addDays(ymd, 3 - ((weekday(ymd) + 6) % 7));
  const { y } = parts(thursday);
  return Math.floor(daysBetween(ymdOf(y, 1, 1), thursday) / 7) + 1;
}

/** "Oct 12", "12 Eki", "10月12日". */
export function shortDay(ymd: string, locale = "en-US"): string {
  return names(locale, { month: "short", day: "numeric" }).format(noonUtc(ymd));
}

/** "Oct 12, 2026", "12 Eki 2026". */
export function fullDay(ymd: string, locale = "en-US"): string {
  return names(locale, { year: "numeric", month: "short", day: "numeric" }).format(noonUtc(ymd));
}

/** "Mon, Oct 12", "12 Eki Pzt". */
export function longDay(ymd: string, locale = "en-US"): string {
  return names(locale, { weekday: "short", month: "short", day: "numeric" }).format(noonUtc(ymd));
}

/** The short weekday name for 0 (Sunday) through 6, without a closing period: "Mon", "Pzt", "lun", "月". */
export function weekdayName(dow: number, locale = "en-US"): string {
  // 2026-10-04 is a Sunday.
  return names(locale, { weekday: "short" }).format(noonUtc(addDays("2026-10-04", ((dow % 7) + 7) % 7))).replace(/\.$/, "");
}

const miniCache = new Map<string, readonly string[]>();

/**
 * The small month's column heads, 0 (Sunday) through 6: two letters where two
 * tell every day apart ("Mo", "Pz", "lu"), the whole short name where they do
 * not (Portuguese "qua" and "qui"), and CJK's single character as it is.
 */
export function weekdayInitials(locale = "en-US"): readonly string[] {
  let out = miniCache.get(locale);
  if (!out) {
    const full = Array.from({ length: 7 }, (_, dow) => weekdayName(dow, locale));
    const two = full.map((n) => Array.from(n).slice(0, 2).join(""));
    out = new Set(two).size === 7 ? two : full;
    miniCache.set(locale, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string | undefined): Intl.DateTimeFormat {
  const key = zone ?? "";
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(key, f);
  }
  return f;
}

/** The calendar date and the minute of the day an instant falls on in a zone. */
export function zonedParts(ms: number, zone: string | undefined): { ymd: string; minutes: number } {
  const out: Record<string, string> = {};
  for (const p of formatterFor(zone).formatToParts(new Date(ms))) out[p.type] = p.value;
  const hour = out.hour === "24" ? 0 : Number(out.hour);
  return { ymd: `${out.year}-${out.month}-${out.day}`, minutes: hour * 60 + Number(out.minute) };
}

/**
 * The instant a zone's wall clock reads `minutes` past midnight on `ymd`.
 * Found by guessing UTC and correcting by the offset seen there, twice, which
 * settles across a DST change. A wall time the change skips (02:30 on the
 * spring-forward night) comes out an hour later, as clocks do.
 */
export function zonedWallToMs(ymd: string, minutes: number, zone: string | undefined): number {
  const { y, m, d } = parts(ymd);
  const target = Date.UTC(y, m - 1, d) + minutes * 60_000;
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const seen = zonedParts(guess, zone);
    const sp = parts(seen.ymd);
    const seenAsUtc = Date.UTC(sp.y, sp.m - 1, sp.d) + seen.minutes * 60_000;
    const diff = target - seenAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

export function todayIn(zone: string | undefined, now: Date): string {
  return zonedParts(now.getTime(), zone).ymd;
}

/**
 * The grid's zone in words, "NY time" or "Local time" in the reader's
 * language: a raw offset ("GMT+3", "UTC-4") read as noise, and the time
 * switch already says which clock is which.
 */
export function zoneLabel(zone: string | undefined, words: { ny: string; local: string }): string {
  return zone === NY_ZONE ? words.ny : words.local;
}

/** Whether the reader's own zone is New York's already, in which case the ET switch has nothing to switch. */
export function localIsNewYork(): boolean {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone === NY_ZONE;
  } catch {
    return false;
  }
}

/** "09:30" from minutes past midnight. */
export function hhmm(minutes: number): string {
  const m = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** "09:30" to minutes, or null. "24:00" is allowed as the end of a day. */
export function parseHhmm(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

/** Rounds minutes to a step (15 by default), the grid's snap. */
export function snapMinutes(minutes: number, step = 15): number {
  return Math.round(minutes / step) * step;
}
