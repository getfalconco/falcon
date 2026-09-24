/**
 * US equity market calendar + session module (Tracker spec §6, §8.1).
 *
 * All session logic runs in America/New_York; all emitted timestamps are UTC.
 * Pure functions only — no I/O, no server-local time arithmetic.
 *
 * Covers: NYSE full-day holidays (rule-derived for any year ≥ 2022),
 * early-close days (13:00 ET), DST transitions, trading-day arithmetic.
 */

export type SessionKind = "regular" | "pre" | "post" | "closed";

export type NyParts = {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
  hh: number;
  mm: number;
  ss: number;
  weekday: number; // 0 = Sunday … 6 = Saturday
};

const NY_TZ = "America/New_York";

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  weekday: "short",
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** New York wall-clock parts of a UTC instant. */
export function nyParts(date: Date): NyParts {
  const parts = partsFormatter.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    // Intl may render midnight as "24" with hour12: false + 2-digit on some ICU builds.
    hh: Number(get("hour")) % 24,
    mm: Number(get("minute")),
    ss: Number(get("second")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

export function toYmd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The New York calendar date ("YYYY-MM-DD") of a UTC instant. */
export function nyYmd(date: Date): string {
  const p = nyParts(date);
  return toYmd(p.y, p.m, p.d);
}

function ymdToUtcNoon(ymdStr: string): Date {
  return new Date(`${ymdStr}T12:00:00.000Z`);
}

/** Weekday (0=Sun…6=Sat) of a calendar date string. */
export function weekdayOf(ymdStr: string): number {
  return ymdToUtcNoon(ymdStr).getUTCDay();
}

/** Add n calendar days to a "YYYY-MM-DD" string. */
export function addCalendarDays(ymdStr: string, n: number): string {
  const d = ymdToUtcNoon(ymdStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Calendar-day difference b − a for two "YYYY-MM-DD" strings. */
export function calendarDaysBetween(aYmd: string, bYmd: string): number {
  const ms = ymdToUtcNoon(bYmd).getTime() - ymdToUtcNoon(aYmd).getTime();
  return Math.round(ms / 86_400_000);
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

/** Easter Sunday (Gregorian, Anonymous algorithm) → "YYYY-MM-DD". */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
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
  return toYmd(year, month, day);
}

export function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): string {
  const firstWeekday = weekdayOf(toYmd(year, month, 1));
  const offset = (weekday - firstWeekday + 7) % 7;
  return toYmd(year, month, 1 + offset + (n - 1) * 7);
}

export function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  // Day 0 of next month = last day of this month.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastYmd = toYmd(year, month, lastDay);
  const back = (weekdayOf(lastYmd) - weekday + 7) % 7;
  return addCalendarDays(lastYmd, -back);
}

/** NYSE observed-date rule: Sat → Friday before; Sun → Monday after. */
function observedFixed(year: number, month: number, day: number): string | null {
  const ymdStr = toYmd(year, month, day);
  const wd = weekdayOf(ymdStr);
  if (wd === 6) {
    // Saturday holidays: NYSE observes the preceding Friday for most holidays,
    // EXCEPT New Year's Day (no observance when Jan 1 falls on Saturday).
    if (month === 1 && day === 1) return null;
    return addCalendarDays(ymdStr, -1);
  }
  if (wd === 0) return addCalendarDays(ymdStr, 1);
  return ymdStr;
}

const holidayCache = new Map<number, Set<string>>();

/** Full-day NYSE market holidays for a year (observed dates). */
export function marketHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const days = new Set<string>();
  const push = (v: string | null): void => {
    if (v) days.add(v);
  };

  push(observedFixed(year, 1, 1)); // New Year's Day
  push(nthWeekdayOfMonth(year, 1, 1, 3)); // MLK Day — 3rd Monday Jan
  push(nthWeekdayOfMonth(year, 2, 1, 3)); // Washington's Birthday — 3rd Monday Feb
  push(addCalendarDays(easterSunday(year), -2)); // Good Friday
  push(lastWeekdayOfMonth(year, 5, 1)); // Memorial Day — last Monday May
  if (year >= 2022) push(observedFixed(year, 6, 19)); // Juneteenth
  push(observedFixed(year, 7, 4)); // Independence Day
  push(nthWeekdayOfMonth(year, 9, 1, 1)); // Labor Day — 1st Monday Sep
  push(nthWeekdayOfMonth(year, 11, 4, 4)); // Thanksgiving — 4th Thursday Nov
  push(observedFixed(year, 12, 25)); // Christmas

  holidayCache.set(year, days);
  return days;
}

export function isWeekend(ymdStr: string): boolean {
  const wd = weekdayOf(ymdStr);
  return wd === 0 || wd === 6;
}

export function isMarketHoliday(ymdStr: string): boolean {
  return marketHolidays(Number(ymdStr.slice(0, 4))).has(ymdStr);
}

export function isTradingDay(ymdStr: string): boolean {
  return !isWeekend(ymdStr) && !isMarketHoliday(ymdStr);
}

/**
 * Early-close (13:00 ET) days: day after Thanksgiving; Jul 3 and Dec 24
 * whenever they are trading days.
 */
export function isEarlyClose(ymdStr: string): boolean {
  if (!isTradingDay(ymdStr)) return false;
  const year = Number(ymdStr.slice(0, 4));
  if (ymdStr === toYmd(year, 7, 3)) return true;
  if (ymdStr === toYmd(year, 12, 24)) return true;
  const dayAfterThanksgiving = addCalendarDays(nthWeekdayOfMonth(year, 11, 4, 4), 1);
  return ymdStr === dayAfterThanksgiving;
}

// ---------------------------------------------------------------------------
// Trading-day arithmetic
// ---------------------------------------------------------------------------

export function previousTradingDay(ymdStr: string): string {
  let d = addCalendarDays(ymdStr, -1);
  while (!isTradingDay(d)) d = addCalendarDays(d, -1);
  return d;
}

export function nextTradingDay(ymdStr: string): string {
  let d = addCalendarDays(ymdStr, 1);
  while (!isTradingDay(d)) d = addCalendarDays(d, 1);
  return d;
}

/** Shift by n trading days (n may be negative). n = 0 returns input unchanged. */
export function addTradingDays(ymdStr: string, n: number): string {
  let d = ymdStr;
  for (let i = 0; i < Math.abs(n); i++) {
    d = n > 0 ? nextTradingDay(d) : previousTradingDay(d);
  }
  return d;
}

/** Number of trading days in the half-open interval (fromYmd, toYmd]. */
export function tradingDaysBetween(fromYmd: string, toYmd: string): number {
  if (toYmd <= fromYmd) return 0;
  let count = 0;
  let d = fromYmd;
  while (d < toYmd) {
    d = addCalendarDays(d, 1);
    if (isTradingDay(d)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Wall time ↔ UTC, session classification
// ---------------------------------------------------------------------------

/**
 * Convert a New York wall-clock time on a calendar date to a UTC instant.
 * DST-correct: derives the actual UTC offset via Intl (handles the 4↔5h shift).
 */
export function nyWallTimeToUtc(ymdStr: string, hh: number, mm: number): Date {
  const [y, m, d] = ymdStr.split("-").map(Number);
  // First guess assumes EST (UTC-5); correct by the observed offset error.
  let guess = new Date(Date.UTC(y, m - 1, d, hh + 5, mm, 0));
  for (let i = 0; i < 2; i++) {
    const p = nyParts(guess);
    const errMinutes =
      (Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - Date.UTC(y, m - 1, d, hh, mm)) / 60_000;
    if (errMinutes === 0) break;
    guess = new Date(guess.getTime() - errMinutes * 60_000);
  }
  return guess;
}

export type SessionTimes = {
  preStartUtc: Date; // 04:00 ET
  openUtc: Date; // 09:30 ET
  closeUtc: Date; // 16:00 ET (13:00 ET on early-close days)
  postEndUtc: Date; // 20:00 ET (17:00 ET on early-close days)
};

/** Session boundaries for a trading day; null when the market is closed. */
export function sessionTimes(ymdStr: string): SessionTimes | null {
  if (!isTradingDay(ymdStr)) return null;
  const early = isEarlyClose(ymdStr);
  return {
    preStartUtc: nyWallTimeToUtc(ymdStr, 4, 0),
    openUtc: nyWallTimeToUtc(ymdStr, 9, 30),
    closeUtc: nyWallTimeToUtc(ymdStr, early ? 13 : 16, 0),
    postEndUtc: nyWallTimeToUtc(ymdStr, early ? 17 : 20, 0),
  };
}

export type SessionInfo = {
  session: SessionKind;
  /** The NY calendar date if it is a trading day, else null. */
  tradingDayYmd: string | null;
};

/** Classify a UTC instant against the NY session clock. */
export function classifySession(date: Date): SessionInfo {
  const dayYmd = nyYmd(date);
  const times = sessionTimes(dayYmd);
  if (!times) return { session: "closed", tradingDayYmd: null };
  const t = date.getTime();
  if (t < times.preStartUtc.getTime()) return { session: "closed", tradingDayYmd: dayYmd };
  if (t < times.openUtc.getTime()) return { session: "pre", tradingDayYmd: dayYmd };
  if (t < times.closeUtc.getTime()) return { session: "regular", tradingDayYmd: dayYmd };
  if (t < times.postEndUtc.getTime()) return { session: "post", tradingDayYmd: dayYmd };
  return { session: "closed", tradingDayYmd: dayYmd };
}

/**
 * True when a close-run happens on a later NY calendar date than the session
 * it measures — i.e. the app was not running at that session's close and is
 * catching up now (overnight start, weekend, holiday). The measurement is
 * identical; the flag only tells downstream how stale the signal is.
 */
export function isCatchUpRun(now: Date, measuredDayYmd: string): boolean {
  return nyYmd(now) !== measuredDayYmd;
}

/**
 * The most recent trading day whose regular session has fully completed
 * as of the given instant (used for "after close" computations).
 */
export function lastCompletedTradingDay(date: Date): string {
  const dayYmd = nyYmd(date);
  const times = sessionTimes(dayYmd);
  if (times && date.getTime() >= times.closeUtc.getTime()) return dayYmd;
  return previousTradingDay(dayYmd);
}

/**
 * Is `now` inside ±`halfWidthHours` of a confirmed earnings release? The
 * Tracker's hot lane polls these tickers on the minute: everything downstream
 * — Base, the Classifier, Propagation — is bounded below by this poll, so a
 * release found 65 minutes late is a second-order move found 65 minutes late.
 */
export function isInEarningsWindow(
  scheduled: ReadonlyArray<{ dueAt: string; confirmed: boolean }> | null | undefined,
  now: Date,
  halfWidthHours: number,
): boolean {
  if (!scheduled || scheduled.length === 0) return false;
  const halfWidthMs = halfWidthHours * 60 * 60_000;
  const t = now.getTime();
  return scheduled.some((e) => {
    if (!e.confirmed) return false;
    const due = Date.parse(e.dueAt);
    return Number.isFinite(due) && Math.abs(due - t) <= halfWidthMs;
  });
}
