/**
 * Clock helpers for the agent engine. US markets, EDGAR and the macro
 * calendar run on New York time; a reader's "every weekday at 08:00" runs on
 * the machine's local time. Both are needed, and both are pure here so the
 * trigger rules can be tested against a fixed instant.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type NyParts = { ymd: string; hour: number; minute: number; weekday: number };

/** The New York calendar date, clock and weekday (0 = Sunday) of an instant. */
export function nyParts(at: Date): NyParts {
  const parts: Record<string, string> = {};
  for (const p of NY_PARTS.formatToParts(at)) parts[p.type] = p.value;
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? "Sun"),
  };
}

export function nyYmd(at: Date): string {
  return nyParts(at).ymd;
}

/** The instant a New York wall-clock time names ("2026-10-14", "08:30"). */
export function nyInstant(ymd: string, hhmm = "00:00"): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const wall = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  let guess = wall;
  // Two passes settle the offset, including across a DST change.
  for (let i = 0; i < 2; i++) {
    const p = nyParts(new Date(guess));
    const [py, pm, pd] = p.ymd.split("-").map(Number);
    const seen = Date.UTC(py!, pm! - 1, pd!, p.hour, p.minute);
    guess += wall - seen;
  }
  return new Date(guess);
}

/** Calendar days between two "YYYY-MM-DD" dates (b minus a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

export function addDaysYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Regular US session, weekdays 09:30 to 16:00 New York (holidays not known here). */
export function isRegularSession(at: Date): boolean {
  const p = nyParts(at);
  if (p.weekday === 0 || p.weekday === 6) return false;
  const minute = p.hour * 60 + p.minute;
  return minute >= 9 * 60 + 30 && minute < 16 * 60;
}

/** EDGAR accepts filings weekdays 06:00 to 22:00 New York. */
export function isEdgarOpen(at: Date): boolean {
  const p = nyParts(at);
  if (p.weekday === 0 || p.weekday === 6) return false;
  return p.hour >= 6 && p.hour < 22;
}

/** A plain date for copy: "2026-11-19". Never a month name (see copy-rules). */
export function ymdOf(iso: string | undefined): string {
  return typeof iso === "string" ? iso.slice(0, 10) : "";
}
