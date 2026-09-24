/**
 * Session calendar: derivatives expiry dates, derived from exchange rules.
 *
 * Three kinds only: the standard monthly options expiry, the quarterly expiry
 * that replaces it in March, June, September and December, and the monthly VIX
 * expiry. Weekly expiries are left out on purpose: SPX and the large index
 * funds list an expiry every trading day, so "options expire today" is true of
 * every session and tells the reader nothing about this one.
 *
 * Pure; all holiday and weekday arithmetic comes from the Tracker's calendar.
 */

import {
  addCalendarDays,
  isMarketHoliday,
  isTradingDay,
  nthWeekdayOfMonth,
  previousTradingDay,
} from "../tracker/calendar.js";

export type ExpiryEvent = {
  /** NY calendar date. */
  date: string;
  kind: "monthly_opex" | "quarterly_expiry" | "vix_expiry";
  title: string;
  detail: string;
};

const FRIDAY = 5;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const MOVED_UP = "Moved up one session because the third Friday is a market holiday.";

function assertMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`month must be 1-12, got ${month}`);
  }
}

/** Third Friday of a month (1-12) as a NY calendar date, holiday or not. */
export function thirdFriday(year: number, month: number): string {
  assertMonth(month);
  return nthWeekdayOfMonth(year, month, FRIDAY, 3);
}

/**
 * The standard monthly expiry: the third Friday, or the trading day before it
 * when that Friday is a market holiday (Good Friday 2025-04-18 gave Thursday
 * 04-17; Juneteenth 2026-06-19 gives Thursday 06-18). Rolling forward instead
 * would put the expiry on the Monday, after the contracts have already gone.
 */
export function monthlyOpex(year: number, month: number): string {
  const friday = thirdFriday(year, month);
  return isTradingDay(friday) ? friday : previousTradingDay(friday);
}

export function isQuarterlyExpiryMonth(month: number): boolean {
  return month === 3 || month === 6 || month === 9 || month === 12;
}

/**
 * The monthly VIX futures and options expiry that falls in the given calendar
 * month.
 *
 * Cboe rule (VX / VXM contract specifications, "Final Settlement Date"): "the
 * Wednesday that is 30 days prior to the third Friday of the calendar month
 * immediately following the month in which the contract expires. [...] If that
 * Wednesday or the Friday that is 30 days following that Wednesday is a Cboe
 * Options holiday, the final settlement date for the contract shall be on the
 * business day immediately preceding that Wednesday."
 * VERIFY: https://cdn.cboe.com/resources/futures/VXM_Contract_Specifications.pdf
 * (text read 2026-09-21; the VX page
 * https://www.cboe.com/tradable_products/vix/vix_futures/specifications/
 * carries the same paragraph but renders it client-side).
 *
 * The anchor is NEXT month's third Friday because VIX is a 30-day measure: the
 * settlement has to sit exactly 30 days ahead of the SPX options it is
 * computed from. That is also why a holiday on the far Friday moves this
 * Wednesday (2025-03: the April third Friday was Good Friday, so the expiry
 * was Tuesday 03-18), which a plain "third Wednesday" rule would miss.
 *
 * "Cboe Options holiday" is read as the NYSE full-day holidays the Tracker
 * calendar derives: Cboe Options closes on the same scheduled holidays, and a
 * second holiday list here would be one more thing to drift.
 */
export function vixExpiry(year: number, month: number): string {
  assertMonth(month);
  const followingYear = month === 12 ? year + 1 : year;
  const followingMonth = month === 12 ? 1 : month + 1;
  const friday = thirdFriday(followingYear, followingMonth);
  const wednesday = addCalendarDays(friday, -30);
  if (isMarketHoliday(wednesday) || isMarketHoliday(friday)) return previousTradingDay(wednesday);
  return wednesday;
}

function opexEvent(year: number, month: number): ExpiryEvent {
  const date = monthlyOpex(year, month);
  const moved = date !== thirdFriday(year, month);
  // In a quarterly month the monthly series expires inside the quarterly
  // event; listing both would show one expiry twice under two names.
  if (isQuarterlyExpiryMonth(month)) {
    // "Triple", not "quad": the fourth contract class was single-stock
    // futures, which stopped trading in the US in 2020. The sentence names
    // three classes, and calling three things "quad" is the first slip a desk
    // reader would catch.
    const base =
      "Stock options, index options and index futures expire in the same session, known as triple witching.";
    return {
      date,
      kind: "quarterly_expiry",
      title: "Quarterly options and futures expiry",
      detail: moved ? `${base} ${MOVED_UP}` : base,
    };
  }
  const base = "Standard monthly stock, ETF and index options expire.";
  return {
    date,
    kind: "monthly_opex",
    title: "Monthly options expiry",
    detail: moved ? `${base} ${MOVED_UP}` : base,
  };
}

function vixEvent(year: number, month: number): ExpiryEvent {
  const date = vixExpiry(year, month);
  const followingFriday = thirdFriday(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1);
  const moved = date !== addCalendarDays(followingFriday, -30);
  const base = "VIX futures and options settle at the open, from a special opening quotation of S&P 500 options.";
  return {
    date,
    kind: "vix_expiry",
    title: "VIX futures and options expiry",
    detail: moved ? `${base} Moved up one session because of a market holiday.` : base,
  };
}

const KIND_ORDER: Record<ExpiryEvent["kind"], number> = {
  quarterly_expiry: 0,
  monthly_opex: 1,
  vix_expiry: 2,
};

/**
 * Every expiry event with fromYmd <= date <= toYmd, sorted by date.
 *
 * Throws on a malformed bound rather than returning []: an empty list reads as
 * "nothing expires in this range", which is a statement about the market, and
 * a bad argument must not be able to make it.
 */
export function expiryEventsBetween(fromYmd: string, toYmd: string): ExpiryEvent[] {
  if (!YMD.test(fromYmd) || !YMD.test(toYmd)) {
    throw new RangeError(`expiryEventsBetween: bounds must be YYYY-MM-DD, got "${fromYmd}" and "${toYmd}"`);
  }
  if (toYmd < fromYmd) return [];

  const out: ExpiryEvent[] = [];
  let year = Number(fromYmd.slice(0, 4));
  let month = Number(fromYmd.slice(5, 7));
  const endYear = Number(toYmd.slice(0, 4));
  const endMonth = Number(toYmd.slice(5, 7));
  // Both rules keep an event inside its own calendar month (a roll-back from
  // the 15th or later never leaves the month), so walking the months the range
  // touches cannot miss one that belongs to a neighbouring month.
  while (year < endYear || (year === endYear && month <= endMonth)) {
    for (const event of [opexEvent(year, month), vixEvent(year, month)]) {
      if (event.date >= fromYmd && event.date <= toYmd) out.push(event);
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return out.sort((a, b) =>
    a.date === b.date ? KIND_ORDER[a.kind] - KIND_ORDER[b.kind] : a.date < b.date ? -1 : 1,
  );
}
