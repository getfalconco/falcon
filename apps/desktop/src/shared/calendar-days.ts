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
 * "View Calendar". The earnings of held names
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

// ---------------------------------------------------------------------------
// The picked day
// ---------------------------------------------------------------------------

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
  | { closed: true; ymd: string };

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
  if (!window) return { closed: true, ymd };

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
