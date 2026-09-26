/**
 * Session calendar: which US session the calendar is for, and where the
 * reader stands relative to it.
 *
 * Pure: the clock is a parameter, and every date rule (holidays, early closes,
 * DST) comes from the Tracker's market calendar, so the calendar and the chain
 * can never disagree about whether a day trades.
 */

import {
  addCalendarDays,
  calendarDaysBetween,
  isEarlyClose,
  isMarketHoliday,
  nextTradingDay,
  nyWallTimeToUtc,
  nyYmd,
  previousTradingDay,
  sessionTimes,
} from "../tracker/calendar.js";
import type { SessionGap, SessionPhase, SessionWindow, SessionOverride } from "./types.js";

/**
 * 20:00 ET on the calendar day before the target, not "N hours before the
 * open". Tokyo and Seoul open at 20:00 ET in summer and 19:00 ET in winter,
 * so by 20:00 there is always an Asia session to report on; an offset from the
 * open would drift by an hour across the DST change. Using the calendar day
 * before (not the previous trading day) is what makes a Monday calendar open on
 * Sunday evening instead of Friday evening, when nothing has traded yet.
 */
const WINDOW_OPENS_HOUR_ET = 20;

/**
 * A gap longer than one night is a "holiday" gap as soon as one closed
 * weekday sits inside it, even when a weekend is in there too (Labor Day).
 * The holiday is the part the reader does not already know about: other
 * markets traded through it, so more has happened than over a plain weekend.
 */
function classifyGap(prevYmd: string, targetYmd: string): SessionGap {
  if (calendarDaysBetween(prevYmd, targetYmd) <= 1) return "overnight";
  for (let d = addCalendarDays(prevYmd, 1); d < targetYmd; d = addCalendarDays(d, 1)) {
    if (isMarketHoliday(d)) return "holiday";
  }
  return "weekend";
}

/** Early closes as the curated overrides correct them, and the close each implies. */
function closeRule(overrides: readonly SessionOverride[]): { earlyCloseOf(ymd: string): boolean; closeOf(ymd: string, scheduled: Date): Date } {
  const corrected = new Map<string, boolean>();
  for (const o of Array.isArray(overrides) ? overrides : []) {
    if (o && typeof o.date === "string" && typeof o.early_close === "boolean") corrected.set(o.date, o.early_close);
  }
  const earlyCloseOf = (ymd: string): boolean => corrected.get(ymd) ?? isEarlyClose(ymd);
  const closeOf = (ymd: string, scheduled: Date): Date =>
    earlyCloseOf(ymd) === isEarlyClose(ymd) ? scheduled : nyWallTimeToUtc(ymd, earlyCloseOf(ymd) ? 13 : 16, 0);
  return { earlyCloseOf, closeOf };
}

/**
 * The window for one named session, as the clock `now` stands against it: a
 * day a calendar lists by date rather than the one the clock is on. Null for a
 * day that does not trade (a weekend, a holiday), which has no open, no close
 * and nothing to hand over to.
 *
 * `resolveSessionWindow` is this with the target chosen by the clock, so the two
 * cannot disagree about a session's bounds, its gap or its phase.
 */
export function sessionWindowFor(
  targetYmd: string,
  now: Date,
  overrides: readonly SessionOverride[] = [],
): SessionWindow | null {
  const t = now.getTime();
  if (!Number.isFinite(t)) throw new RangeError("sessionWindowFor: invalid clock");
  const targetTimes = sessionTimes(targetYmd);
  if (!targetTimes) return null;
  const { earlyCloseOf, closeOf } = closeRule(overrides);

  const prev = previousTradingDay(targetYmd);
  const prevTimes = sessionTimes(prev);
  if (!prevTimes) throw new Error(`sessionWindowFor: no session times for ${prev}`);

  const windowOpens = nyWallTimeToUtc(addCalendarDays(targetYmd, -1), WINDOW_OPENS_HOUR_ET, 0);
  const openMs = targetTimes.openUtc.getTime();
  const targetClose = closeOf(targetYmd, targetTimes.closeUtc);
  const closeMs = targetClose.getTime();

  let phase: SessionPhase;
  if (t >= windowOpens.getTime() && t < openMs) phase = "pre_open";
  else if (t >= openMs && t < closeMs) phase = "in_session";
  else phase = "between_sessions";

  return {
    target_session_ymd: targetYmd,
    prev_session_ymd: prev,
    overnight_since: closeOf(prev, prevTimes.closeUtc).toISOString(),
    window_opens_at: windowOpens.toISOString(),
    target_open_at: targetTimes.openUtc.toISOString(),
    target_close_at: targetClose.toISOString(),
    phase,
    gap: classifyGap(prev, targetYmd),
    early_close: earlyCloseOf(targetYmd),
  };
}

/**
 * The window for the session the clock is on.
 *
 * `overrides` are the ad-hoc closes the algorithmic NYSE calendar cannot know
 * (a day of national mourning), kept in the curated macro calendar. They are
 * applied HERE, before the target session is chosen, rather than patched onto
 * the finished window: the close is what flips the target, so correcting it
 * afterwards leaves the calendar on a session that ended hours ago when a
 * close is added, and on tomorrow while today is still trading when a
 * wrongly derived one is cleared. An override moves a close and nothing else;
 * it never makes a day trade or stop trading.
 */
export function resolveSessionWindow(now: Date, overrides: readonly SessionOverride[] = []): SessionWindow {
  const t = now.getTime();
  // Intl would throw an opaque RangeError a few frames down; a bad clock is a
  // caller bug and is named as one here.
  if (!Number.isFinite(t)) throw new RangeError("resolveSessionWindow: invalid clock");
  const { closeOf } = closeRule(overrides);

  const today = nyYmd(now);
  const todayTimes = sessionTimes(today);
  // The close, not the open, flips the target: a reader who opens the app at
  // 11:00 still gets today's calendar (phase "in_session"), and only after the
  // bell does it start listing tomorrow.
  const target =
    todayTimes && t < closeOf(today, todayTimes.closeUtc).getTime() ? today : nextTradingDay(today);

  const window = sessionWindowFor(target, now, overrides);
  if (!window) throw new Error(`resolveSessionWindow: no session times for ${target}`);
  return window;
}
