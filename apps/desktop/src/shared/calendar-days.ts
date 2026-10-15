/**
 * Session calendar: the rows for a given day, in the calendar's own shape.
 *
 * The handover report the card reads is built for one session, the one the
 * clock is on, and for that day its rows are passed through as they are. Any
 * other day is put together from the same pieces the engine uses for that one
 * (the curated macro calendar, the expiry and rebalance rules, the session
 * calendar), through the engine's own `calendarToday`, so a later day lists
 * exactly what the report would list if it were the session. The card shows
 * the session only today; the other days are for the calendar view behind
 * "View Calendar". A day the market does not open (a weekend, a holiday) is
 * still a day: it is answered as closed, with why, and with whatever the
 * curated calendar and the rules put on it, so the card can show today as
 * today on a Sunday rather than jumping to Monday. The earnings of held names
 * come from the report too: it carries every held name's next date within
 * `EARNINGS_HORIZON_SESSIONS`, and past that horizon nothing is known; the
 * answer says so, for a view that lists such a day to print rather than show
 * an empty day as a quiet one.
 *
 * Pure: the clock is a parameter.
 */

import type { BriefingReport } from "./briefing-types";
import {
  EARNINGS_HORIZON_SESSIONS,
  REBALANCE_HORIZON_SESSIONS,
  addTradingDays,
  calendarToday,
  coverageStatus,
  expiryEventsBetween,
  loadMacroCalendar,
  rebalanceEventsBetween,
  sessionWindowFor,
  type CalendarDegraded,
  type CalendarItem,
  type CalendarReport,
  type HeldEarnings,
  type SessionWindow,
} from "./calendar-types";
import { etClock, nyYmd } from "./calendar-view";

// ---------------------------------------------------------------------------
// The picked day
// ---------------------------------------------------------------------------

/**
 * The session before or after `ymd`, skipping weekends and market holidays,
 * or null when that session falls outside the curated file's months: every
 * day there would read "not covered", so the arrows stop at its edge.
 */
export function stepSession(ymd: string, direction: -1 | 1, coverage: { from: string; until: string }): string | null {
  const next = addTradingDays(ymd, direction);
  return next < coverage.from || next > coverage.until ? null : next;
}

/** "YYYY-MM-DD" `n` calendar days on (or back), through UTC noon so no zone can slip a day. */
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

/** 0 for Sunday through 6 for Saturday. */
function weekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

/**
 * The calendar day before or after `ymd`, weekends and holidays included, or
 * null when it falls outside the curated file's months (the arrows stop at
 * its edge, as they always have).
 */
export function stepDay(ymd: string, direction: -1 | 1, coverage: { from: string; until: string }): string | null {
  const next = addDays(ymd, direction);
  return next < coverage.from || next > coverage.until ? null : next;
}

/** Whether the US market opens on `ymd`: the session calendar's own answer, holidays and weekends included. */
export function isTradingDay(ymd: string): boolean {
  return sessionWindowFor(ymd, new Date(Date.UTC(2000, 0, 1))) !== null;
}

/**
 * The day the calendar opens on. New York's calendar day when the market
 * does not open on it: a Saturday, a Sunday or a holiday is shown as itself,
 * today, not as the next session. On a trading day it is the report's own
 * session, as before: today until the close, the next session after it.
 */
export function openingDay(briefing: BriefingReport, now: Date): string {
  const session = briefing.window.target_session_ymd;
  const today = nyYmd(now);
  if (!today || isTradingDay(today)) return session;
  return today;
}

/** The NYSE's full-day holidays, by the rule each one is set by (tracker/calendar.ts `marketHolidays`). */
export type MarketHoliday =
  | "new_year"
  | "mlk"
  | "washington"
  | "good_friday"
  | "memorial"
  | "juneteenth"
  | "independence"
  | "labor"
  | "thanksgiving"
  | "christmas";

/**
 * Which holiday a closed weekday is. The engine's holiday set carries dates,
 * not names, but each month holds at most one of its rules (two in January),
 * so the month says which; observed days stay in their month (a Saturday
 * holiday is kept the Friday before, a Sunday one the Monday after, and New
 * Year's Day on a Saturday is not moved into December). Null for a day that
 * is not one, or a closure no rule names.
 */
export function marketHolidayOf(ymd: string): MarketHoliday | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const dow = weekdayOf(ymd);
  if (dow === 0 || dow === 6 || isTradingDay(ymd)) return null;
  const month = Number(ymd.slice(5, 7));
  const day = Number(ymd.slice(8, 10));
  switch (month) {
    case 1:
      return day <= 2 ? "new_year" : "mlk";
    case 2:
      return "washington";
    case 3:
    case 4:
      return "good_friday";
    case 5:
      return "memorial";
    case 6:
      return "juneteenth";
    case 7:
      return "independence";
    case 9:
      return "labor";
    case 11:
      return "thanksgiving";
    case 12:
      return "christmas";
    default:
      return null;
  }
}

/** Midnight in New York at the start of `ymd`, as an ISO instant: 04:00Z on summer time, 05:00Z in winter. */
function nyMidnight(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const summer = new Date(Date.UTC(y, m - 1, d, 4));
  if (nyYmd(summer) === ymd && etClock(summer) === "00:00") return summer.toISOString();
  return new Date(Date.UTC(y, m - 1, d, 5)).toISOString();
}

/**
 * A closed day in the window's shape, so the rows on it go through the same
 * builder and view as any other day. It has no open and no close: the bounds
 * are the New York day itself, midnight to midnight, which is what makes an
 * all-day row on it read as past once the day is over and the rail's standing
 * read "on" exactly while the clock is on the day. No early close, no gap.
 */
function closedDayWindow(ymd: string): SessionWindow {
  const start = nyMidnight(ymd);
  const end = nyMidnight(addDays(ymd, 1));
  return {
    target_session_ymd: ymd,
    prev_session_ymd: ymd,
    overnight_since: start,
    window_opens_at: start,
    target_open_at: start,
    target_close_at: end,
    phase: "between_sessions",
    gap: "overnight",
    early_close: false,
  };
}

export type DayCalendar =
  | {
      closed: false;
      ymd: string;
      report: CalendarReport;
      /** The report's own session: its rows are the engine's, the overlay and every degraded note included. */
      isSession: boolean;
      /**
       * Set when the reader holds names and this day is outside the stretch the
       * report knows their earnings for: the last date it does know. An empty
       * day there says nothing about earnings, and a view listing it says so.
       */
      earningsKnownThrough: string | null;
    }
  | {
      closed: true;
      ymd: string;
      /** Why the market does not open: a Saturday or a Sunday, or a weekday holiday. */
      reason: "weekend" | "holiday";
      /** Which holiday, when `reason` is "holiday" and a rule names it. */
      holiday: MarketHoliday | null;
      /**
       * Whatever is on the day all the same (a release the curated file puts
       * on a weekend, a rule's date), over a window that is the New York day
       * itself (`closedDayWindow`): no open, no close, no session marks.
       */
      report: CalendarReport;
    };

/** The report's window in the calendar's shape: the same bounds, under the calendar's field names. */
function sessionWindowOf(briefing: BriefingReport): SessionWindow {
  const w = briefing.window;
  return {
    target_session_ymd: w.target_session_ymd,
    prev_session_ymd: w.prev_session_ymd,
    overnight_since: w.overnight_since,
    window_opens_at: w.window_opens_at,
    target_open_at: w.target_open_at,
    target_close_at: w.target_close_at,
    phase: w.phase,
    gap: w.handover,
    early_close: w.early_close,
  };
}

function list<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The report's failures that speak for a given day. The macro calendar's note
 * belongs to the report's own session only; the others are built here from
 * the shipped file, which cannot fail. A held name whose calendar could not be
 * read is missing from every day the report's earnings reach.
 */
function degradedFor(briefing: BriefingReport, isSession: boolean, earningsInReach: boolean): CalendarDegraded[] {
  const out: CalendarDegraded[] = [];
  for (const d of list(briefing.degraded)) {
    if (d.section === "macro_calendar" && isSession) out.push({ section: "macro_calendar", detail: d.detail });
    if (d.section === "corporate_actions" && earningsInReach) {
      out.push({ section: "earnings", detail: d.detail, ...(d.symbols ? { symbols: [...d.symbols] } : {}) });
    }
  }
  return out;
}

export function calendarForDay(briefing: BriefingReport, ymd: string, now: Date): DayCalendar {
  const sessionYmd = briefing.window.target_session_ymd;
  const held = list(briefing.held_coverage).map((h) => h.ticker);
  const earningsThrough = addTradingDays(sessionYmd, EARNINGS_HORIZON_SESSIONS);
  const earningsInReach = ymd >= sessionYmd && ymd <= earningsThrough;
  const earningsKnownThrough = held.length > 0 && !earningsInReach ? earningsThrough : null;

  if (ymd === sessionYmd) {
    return {
      closed: false,
      ymd,
      isSession: true,
      earningsKnownThrough: null,
      report: {
        schema_version: briefing.schema_version,
        generated_at: briefing.generated_at,
        demo: briefing.demo,
        window: sessionWindowOf(briefing),
        items: [...list(briefing.calendar_today)] as CalendarItem[],
        coverage: briefing.calendar_coverage,
        degraded: degradedFor(briefing, true, true),
      },
    };
  }

  const window = sessionWindowFor(ymd, now);
  if (!window) {
    const cal = loadMacroCalendar();
    const frame = closedDayWindow(ymd);
    const weekend = weekdayOf(ymd) === 0 || weekdayOf(ymd) === 6;
    return {
      closed: true,
      ymd,
      reason: weekend ? "weekend" : "holiday",
      holiday: weekend ? null : marketHolidayOf(ymd),
      report: {
        schema_version: briefing.schema_version,
        generated_at: briefing.generated_at,
        demo: briefing.demo,
        window: frame,
        items: calendarToday(frame, cal, expiryEventsBetween(ymd, ymd), rebalanceEventsBetween(ymd, ymd, cal.index_events), [], held),
        coverage: coverageStatus(ymd, cal),
        degraded: [],
      },
    };
  }

  const cal = loadMacroCalendar();
  const items = calendarToday(
    window,
    cal,
    expiryEventsBetween(ymd, ymd),
    rebalanceEventsBetween(ymd, addTradingDays(ymd, REBALANCE_HORIZON_SESSIONS), cal.index_events),
    earningsInReach ? ([...list(briefing.earnings_next)] as HeldEarnings[]) : [],
    held,
  );
  return {
    closed: false,
    ymd,
    isSession: false,
    earningsKnownThrough,
    report: {
      schema_version: briefing.schema_version,
      generated_at: briefing.generated_at,
      demo: briefing.demo,
      window,
      items,
      coverage: coverageStatus(ymd, cal),
      degraded: degradedFor(briefing, false, earningsInReach),
    },
  };
}
