/**
 * Earnings: when a report counts as out, and which session first trades on it.
 *
 * The session clock is the engine's own (`sessionWindowFor`, holidays and
 * early closes included), so the tab and the Tracker agree on what "after the
 * close" means on the day after Thanksgiving.
 *
 *   before the open   out from 09:30 New York on the day; traded that session
 *   during / unknown  out from the close; traded that session
 *   after the close   out from the close; traded the next session
 *
 * A day the market does not open (a foreign filer reporting on a US holiday)
 * keeps the same wall times, and its reaction is the next session.
 *
 * Pure: the clock is a parameter.
 */

import { addTradingDays, sessionWindowFor } from "./calendar-types";
import type { EarningsTime } from "./earnings-types";

const EPOCH = new Date(0);

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function nyParts(ms: number): { ymd: string; minutes: number } {
  const p = Object.fromEntries(NY_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** The New York calendar date of an instant. */
export function nyYmdOf(ms: number): string {
  return nyParts(ms).ymd;
}

/** New York minutes past midnight of an instant. */
export function nyMinutesOf(ms: number): number {
  return nyParts(ms).minutes;
}

/** A New York wall time on a calendar date, as epoch milliseconds (DST-correct). */
export function nyWallMs(ymd: string, hh: number, mm: number): number {
  const [y, m, d] = ymd.split("-").map(Number);
  let guess = Date.UTC(y!, m! - 1, d!, hh + 5, mm);
  for (let i = 0; i < 3; i++) {
    const p = nyParts(guess);
    const [py, pm, pd] = p.ymd.split("-").map(Number);
    const err = (Date.UTC(py!, pm! - 1, pd!, 0, p.minutes) - Date.UTC(y!, m! - 1, d!, hh, mm)) / 60_000;
    if (err === 0) break;
    guess -= err * 60_000;
  }
  return guess;
}

/** The session's open and close on `ymd`, or null when the market does not open. */
export function sessionOf(ymd: string): { openMs: number; closeMs: number } | null {
  const w = sessionWindowFor(ymd, EPOCH);
  if (!w) return null;
  return { openMs: Date.parse(w.target_open_at), closeMs: Date.parse(w.target_close_at) };
}

export function isSessionDay(ymd: string): boolean {
  return sessionOf(ymd) !== null;
}

/** The next session after `ymd` (a closed `ymd` included). */
export function nextSession(ymd: string): string {
  return addTradingDays(ymd, 1);
}

/** The instant from which a report on `date` at `time` counts as out, when the providers have not yet said so. */
export function releaseThresholdMs(date: string, time: EarningsTime): number {
  const s = sessionOf(date);
  if (time === "bmo") return s ? s.openMs : nyWallMs(date, 9, 30);
  return s ? s.closeMs : nyWallMs(date, 16, 0);
}

/**
 * The session that first trades on a report. With the provider's record of
 * the release instant, that decides: before the close of a session day is
 * that session, anything later the next. Without it, the hour does.
 */
export function reactionSession(date: string, time: EarningsTime, releasedAtMs: number | null = null): string {
  if (releasedAtMs !== null && Number.isFinite(releasedAtMs)) {
    const day = nyYmdOf(releasedAtMs);
    const s = sessionOf(day);
    if (!s) return nextSession(day);
    return releasedAtMs < s.closeMs ? day : nextSession(day);
  }
  if (!isSessionDay(date)) return nextSession(date);
  return time === "amc" ? nextSession(date) : date;
}

/** The hour bucket of a known release instant. */
export function timeOfRelease(releasedAtMs: number): EarningsTime {
  const day = nyYmdOf(releasedAtMs);
  const s = sessionOf(day);
  if (!s) return nyMinutesOf(releasedAtMs) < 9 * 60 + 30 ? "bmo" : "amc";
  if (releasedAtMs < s.openMs) return "bmo";
  if (releasedAtMs < s.closeMs) return "dmh";
  return "amc";
}

/** Monday of the New York week `today` falls in (a Saturday or Sunday belongs to the week just ending). */
export function weekStartOf(today: string): string {
  const d = new Date(`${today}T12:00:00.000Z`);
  const dow = d.getUTCDay();
  const back = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}
