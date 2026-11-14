/**
 * Exchange calendar and New York time, from rules only (no data), so a
 * calendar operator at date t never depends on bars after t.
 *
 * NYSE full-day holidays: New Year's Day, Martin Luther King Jr. Day (1998+),
 * Washington's Birthday, Good Friday, Memorial Day, Juneteenth (2022+),
 * Independence Day, Labor Day, Thanksgiving, Christmas; Saturday holidays are
 * observed on Friday (except New Year's Day), Sunday ones on Monday. One-off
 * closures (storms, national days of mourning) are not in the rules; the data
 * calendar simply has no bar on those days.
 */

const DAY = 86_400_000;

export function isoToDay(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY);
}

export function dayToIso(day: number): string {
  return new Date(day * DAY).toISOString().slice(0, 10);
}

function ymd(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY);
}

/** Weekday of a day number: 0 Sunday .. 6 Saturday. */
export function weekday(day: number): number {
  return (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
}

function nthWeekday(y: number, m: number, wd: number, n: number): number {
  const first = ymd(y, m, 1);
  const off = (wd - weekday(first) + 7) % 7;
  return first + off + (n - 1) * 7;
}

function lastWeekday(y: number, m: number, wd: number): number {
  const last = ymd(y, m + 1, 1) - 1;
  return last - ((weekday(last) - wd + 7) % 7);
}

function easter(y: number): number {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(y, month, day);
}

function observed(day: number, allowFriday = true): number | null {
  const wd = weekday(day);
  if (wd === 6) return allowFriday ? day - 1 : null;
  if (wd === 0) return day + 1;
  return day;
}

const holidayCache = new Map<number, Set<number>>();

export function holidays(y: number): Set<number> {
  const hit = holidayCache.get(y);
  if (hit) return hit;
  const out = new Set<number>();
  const add = (d: number | null) => {
    if (d !== null) out.add(d);
  };
  add(observed(ymd(y, 1, 1), false));
  if (y >= 1998) add(nthWeekday(y, 1, 1, 3));
  add(nthWeekday(y, 2, 1, 3));
  add(easter(y) - 2);
  add(lastWeekday(y, 5, 1));
  if (y >= 2022) add(observed(ymd(y, 6, 19)));
  add(observed(ymd(y, 7, 4)));
  add(nthWeekday(y, 9, 1, 1));
  add(nthWeekday(y, 11, 4, 4));
  add(observed(ymd(y, 12, 25)));
  // New Year's Day of next year on a Saturday is not observed on Dec 31 (NYSE rule).
  holidayCache.set(y, out);
  return out;
}

export function isSession(day: number): boolean {
  const wd = weekday(day);
  if (wd === 0 || wd === 6) return false;
  return !holidays(new Date(day * DAY).getUTCFullYear()).has(day);
}

export function nextSession(day: number): number {
  let d = day + 1;
  while (!isSession(d)) d++;
  return d;
}

export function prevSession(day: number): number {
  let d = day - 1;
  while (!isSession(d)) d--;
  return d;
}

/** Trading day of the month: 1, 2, ... from the start; tdomFromEnd: -1 on the last session, -2 before it. */
export function tdom(day: number): { fromStart: number; fromEnd: number } {
  const d = new Date(day * DAY);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  let fromStart = 0;
  for (let x = ymd(y, m, 1); x <= day; x++) if (isSession(x)) fromStart++;
  let fromEnd = 0;
  for (let x = day; x < ymd(y, m + 1, 1); x++) if (isSession(x)) fromEnd--;
  return { fromStart, fromEnd };
}

export function isMonthEnd(day: number): boolean {
  const n = nextSession(day);
  return new Date(n * DAY).getUTCMonth() !== new Date(day * DAY).getUTCMonth();
}

export function isQuarterEnd(day: number): boolean {
  if (!isMonthEnd(day)) return false;
  return new Date(day * DAY).getUTCMonth() % 3 === 2;
}

/** Period key for rebalancing: weekly (ISO-like week), monthly, quarterly. */
export function periodKey(day: number, every: "daily" | "weekly" | "monthly" | "quarterly"): string {
  const d = new Date(day * DAY);
  if (every === "daily") return String(day);
  if (every === "monthly") return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
  if (every === "quarterly") return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3)}`;
  return String(Math.floor((day + 3) / 7));
}

/** The last session of its period (decide on its close, trade at the next open). Rule-based, so causal. */
export function isPeriodEnd(day: number, every: "daily" | "weekly" | "monthly" | "quarterly"): boolean {
  return periodKey(day, every) !== periodKey(nextSession(day), every);
}

/** UTC offset of New York in minutes at an instant (EST -300, EDT -240; US rules since 2007). */
export function nyOffsetMinutes(utcMs: number): number {
  const y = new Date(utcMs).getUTCFullYear();
  // DST: second Sunday of March 02:00 local (07:00 UTC) to first Sunday of November 02:00 local (06:00 UTC).
  const start = (nthWeekday(y, 3, 0, 2) * DAY) + 7 * 3_600_000;
  const end = (nthWeekday(y, 11, 0, 1) * DAY) + 6 * 3_600_000;
  return utcMs >= start && utcMs < end ? -240 : -300;
}

/** An ISO instant as New York local date and minutes after midnight. */
export function nyLocal(iso: string): { day: number; minutes: number } | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const local = ms + nyOffsetMinutes(ms) * 60_000;
  const day = Math.floor(local / DAY);
  return { day, minutes: Math.round((local - day * DAY) / 60_000) };
}

export const CLOSE_MIN = 16 * 60;
export const PREOPEN_MIN = 9 * 60 + 15;

/**
 * The decision session on which an event known at (day, minutes NY) can first
 * be used: close clock, known by 16:00 on that session; preopen clock, known
 * by 09:15. Returns a day number (a session).
 */
export function decisionDay(day: number, minutes: number, clock: "close" | "preopen"): number {
  const cutoff = clock === "close" ? CLOSE_MIN : PREOPEN_MIN;
  if (isSession(day) && minutes <= cutoff) return day;
  return nextSession(day);
}
