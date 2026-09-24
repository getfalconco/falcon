/**
 * Session calendar: the rows of the target session.
 *
 * The session's own exceptions (an early close, the first session after a
 * holiday), the macro releases and FOMC decisions of the day, the expiries
 * and rebalances that take effect after its close, and the earnings reports
 * of held names due that day. Every row is deterministic over the curated
 * file, the date rules and the two provider reads `build.ts` makes; nothing
 * here touches the outside world or reads a clock.
 */

import { addTradingDays, nyWallTimeToUtc, nyYmd, tradingDaysBetween } from "../tracker/calendar.js";
import type { ExpiryEvent } from "./expiry.js";
import { heldFundsTracking } from "./index-map.js";
import { macroEventId, macroEventsOn } from "./macro-calendar.js";
import type { RebalanceEvent } from "./rebalance.js";
import type {
  CalendarItem,
  CorporateCalendarRaw,
  EarningsSlice,
  HeldEarnings,
  MacroCalendarFile,
  SessionWindow,
} from "./types.js";

/** How far ahead, in US sessions counted from the target session, the earnings list looks. */
export const EARNINGS_HORIZON_SESSIONS = 10;
/**
 * Longer than the earnings horizon: a rebalance is announced weeks ahead and
 * the flows it causes build up before the effective date, so a reader holding
 * an index fund wants to see it coming from further out.
 */
export const REBALANCE_HORIZON_SESSIONS = 15;

export const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function list<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A real calendar date, not just the right shape: "2026-02-30" passes the
 * regex and JavaScript rolls it forward to March, so round-trip it.
 */
export function realYmd(value: unknown): string | null {
  if (typeof value !== "string" || !YMD.test(value)) return null;
  const d = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

/** Signed sessions from the target session: 0 on it, negative once behind it. */
export function sessionsFrom(targetYmd: string, ymd: string): number {
  return ymd >= targetYmd ? tradingDaysBetween(targetYmd, ymd) : -tradingDaysBetween(ymd, targetYmd);
}

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

/**
 * The nearest earnings date per held name inside the horizon. A name the
 * chain does not follow, or whose call failed, has a null slice; a provider
 * call that failed has a null raw.
 */
export function nextEarnings(
  held: string[],
  chain: Map<string, EarningsSlice | null>,
  corporate: Map<string, CorporateCalendarRaw | null>,
  targetYmd: string,
): HeldEarnings[] {
  const lastYmd = addTradingDays(targetYmd, EARNINGS_HORIZON_SESSIONS);
  const inRange = (ymd: string): boolean => ymd >= targetYmd && ymd <= lastYmd;
  const out: HeldEarnings[] = [];

  for (const ticker of held) {
    // The chain's dates are the ones the company announced, with the hour; the
    // provider calendar mixes those with its own projections and gives no
    // hour. So the chain is believed first and the provider only fills a gap.
    const tracked: HeldEarnings[] = [];
    for (const row of list(chain.get(ticker)?.scheduled_earnings)) {
      const due = isRecord(row) && typeof row.due_at === "string" ? new Date(row.due_at) : null;
      if (due === null || Number.isNaN(due.getTime())) continue;
      const dueYmd = nyYmd(due);
      if (!inRange(dueYmd)) continue;
      tracked.push({
        ticker,
        due_ymd: dueYmd,
        // The Tracker stamps a before-the-open release 12:00Z and everything
        // else 20:00Z, so an hour nobody has announced is stored as after the
        // close and cannot be told apart from a real one.
        timing: due.getUTCHours() === 12 && due.getUTCMinutes() === 0 ? "bmo" : "amc_or_unspecified",
        sessions_until: sessionsFrom(targetYmd, dueYmd),
        fiscal_period: typeof row.fiscal_period === "string" && row.fiscal_period.trim() !== "" ? row.fiscal_period.trim() : null,
        confirmed: row.confirmed === true,
        source: "tracker",
      });
    }

    const raw = corporate.get(ticker) ?? null;
    const provided: HeldEarnings[] = list(raw?.earnings_dates)
      .map(realYmd)
      .filter((ymd): ymd is string => ymd !== null && inRange(ymd))
      .map((ymd) => ({
        ticker,
        due_ymd: ymd,
        timing: "amc_or_unspecified" as const,
        sessions_until: sessionsFrom(targetYmd, ymd),
        fiscal_period: null,
        confirmed: raw?.earnings_estimated === false,
        source: "yahoo" as const,
      }));

    const nearest = (tracked.length > 0 ? tracked : provided).sort((a, b) => byText(a.due_ymd, b.due_ymd))[0];
    if (nearest) out.push(nearest);
  }

  return out.sort((a, b) => byText(a.due_ymd, b.due_ymd) || byText(a.ticker, b.ticker));
}

export function earningsTimingWords(e: HeldEarnings): string {
  return e.timing === "bmo" ? "before the open" : "after the close, or at an hour not yet announced";
}

// ---------------------------------------------------------------------------
// Expiries and rebalances
// ---------------------------------------------------------------------------

export const EXPIRY_IMPORTANCE: Record<ExpiryEvent["kind"], 1 | 2 | 3> = {
  quarterly_expiry: 3,
  monthly_opex: 2,
  vix_expiry: 1,
};

/**
 * The empty case is scoped to the list, not to the book: `heldFundsTracking`
 * knows the hand-kept fund map in index-map.ts and nothing else, so "no held
 * fund tracks this family" would be a completeness claim that map cannot
 * support, and a plainly false one for a reader holding a fund it has yet to
 * learn.
 */
export function rebalanceDetail(event: RebalanceEvent, funds: string[]): string {
  return funds.length > 0
    ? `${event.detail} Held funds tracking it: ${funds.join(", ")}.`
    : `${event.detail} None of the funds this report tracks for that family is held.`;
}

/**
 * Family and date are enough: the calendar merge keeps one index event per
 * family and date, and a curated entry in a quarter-end month replaces the
 * rule date instead of standing beside it.
 */
export function rebalanceId(event: RebalanceEvent): string {
  return `reb:${event.family}:${event.date}`;
}

// ---------------------------------------------------------------------------
// The rows of the target session
// ---------------------------------------------------------------------------

export function calendarToday(
  window: SessionWindow,
  cal: MacroCalendarFile,
  expiries: ExpiryEvent[],
  rebalances: RebalanceEvent[],
  earnings: HeldEarnings[],
  held: string[],
): CalendarItem[] {
  const target = window.target_session_ymd;
  const items: CalendarItem[] = [];

  // All-day on purpose, although the close has a clock time: the title already
  // carries it, and a timed item would have it printed twice in any sentence
  // built as "title at time".
  if (window.early_close) {
    items.push({
      id: "session:early_close",
      kind: "session",
      time_et: null,
      at: null,
      title: "Early close at 13:00 ET",
      detail: "US equities close at 13:00 ET this session.",
      importance: 2,
      tickers: [],
      source: "rule",
    });
  }
  if (window.gap === "holiday") {
    items.push({
      id: "session:after_holiday",
      kind: "session",
      time_et: null,
      at: null,
      title: "First session after a US market holiday",
      detail: "Markets abroad traded while the US was closed.",
      importance: 1,
      tickers: [],
      source: "rule",
    });
  }

  for (const e of macroEventsOn(target, cal)) {
    const clock = typeof e.time_et === "string" ? HHMM.exec(e.time_et) : null;
    items.push({
      id: `macro:${macroEventId(e)}`,
      kind: e.kind,
      time_et: clock ? e.time_et : null,
      at: clock ? nyWallTimeToUtc(target, Number(clock[1]), Number(clock[2])).toISOString() : null,
      title: e.title,
      detail: e.period ? `Covers ${e.period}.` : null,
      importance: e.importance,
      tickers: [],
      source: e.source,
    });
  }

  for (const e of expiries) {
    if (e.date !== target) continue;
    items.push({
      id: `opex:${e.kind}:${e.date}`,
      kind: "opex",
      time_et: null,
      at: null,
      title: e.title,
      detail: e.detail,
      importance: EXPIRY_IMPORTANCE[e.kind],
      tickers: [],
      source: "rule",
    });
  }

  for (const e of rebalances) {
    if (e.date !== target) continue;
    const funds = heldFundsTracking(e.family, held);
    items.push({
      id: rebalanceId(e),
      kind: "rebalance",
      time_et: null,
      at: null,
      title: e.title,
      detail: rebalanceDetail(e, funds),
      importance: 2,
      tickers: funds,
      source: e.source,
    });
  }

  for (const e of earnings) {
    if (e.due_ymd !== target) continue;
    const when = earningsTimingWords(e);
    items.push({
      id: `earn:${e.ticker}:${e.due_ymd}`,
      kind: "earnings",
      // The hour is known only as before or after the session, so there is no
      // clock time to place it at.
      time_et: null,
      at: null,
      title: `${e.ticker} earnings report`,
      detail: `${when.charAt(0).toUpperCase()}${when.slice(1)}.`,
      importance: 3,
      tickers: [e.ticker],
      source: e.source,
    });
  }

  const allDay = items.filter((i) => i.time_et === null).sort((a, b) => b.importance - a.importance || byText(a.id, b.id));
  const timed = items
    .filter((i) => i.time_et !== null)
    .sort((a, b) => byText(a.time_et!, b.time_et!) || b.importance - a.importance || byText(a.id, b.id));
  return [...allDay, ...timed];
}
