/**
 * Session calendar: index rebalance dates.
 *
 * Two sources, kept apart on every event so the report can say which one a
 * date rests on:
 *  - "rule": S&P and Nasdaq-100 publish a fixed weekday rule, so their dates
 *    are derived here and never run out.
 *  - "curated": dates the provider announced, compiled into the shipped macro
 *    calendar (or its run-time overlay) and passed in by the caller.
 *
 * Russell and MSCI are curated ONLY. Their reviews do not sit on a fixed
 * weekday: MSCI announces each review's effective date, and FTSE Russell
 * publishes each reconstitution's schedule, moving from one reconstitution a
 * year to two from 2026. A guessed weekday rule would print a confident date
 * on the wrong day; with no curated entry there is simply no line.
 */

import { addCalendarDays, addTradingDays } from "../tracker/calendar.js";
import { monthlyOpex, thirdFriday } from "./expiry.js";
import { INDEX_FAMILY_LABEL } from "./index-map.js";
import type { IndexEvent, IndexFamily } from "./types.js";

export type RebalanceEvent = {
  /** The session after whose close the change takes effect (NY calendar date). */
  date: string;
  family: IndexFamily;
  title: string;
  detail: string;
  certainty: "rule" | "confirmed";
  source: "rule" | "curated";
};

type Quarter = 1 | 2 | 3 | 4;

const QUARTERS: readonly Quarter[] = [1, 2, 3, 4];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const RULE_DETAIL = "Scheduled, per index methodology. Changes take effect after the close.";
const RULE_DETAIL_ANNUAL =
  "Scheduled, per index methodology. The yearly constituent review; changes take effect after the close.";
const CURATED_DETAIL = "Announced by the index provider. Changes take effect after the close.";
const MOVED_UP = "Moved up one session because the third Friday is a market holiday.";

function assertQuarter(quarter: number): void {
  if (!QUARTERS.includes(quarter as Quarter)) throw new RangeError(`quarter must be 1-4, got ${quarter}`);
}

/**
 * The last session on the old weights: the third Friday of the quarter-end
 * month, or the trading day before it when that Friday is a market holiday
 * (June 2026: Juneteenth, so Thursday 06-18). The new weights apply from the
 * next open. It is the quarterly expiry date by design, not by coincidence:
 * index providers rebalance into the deepest closing auction of the quarter,
 * so the two share one rule and one roll-back.
 *
 * S&P U.S. Indices methodology, as paraphrased: quarterly share, float and
 * weight updates take effect after the close on the third Friday of March,
 * June, September and December.
 * VERIFY: https://www.spglobal.com/spdji/en/documents/methodologies/methodology-sp-us-indices.pdf
 * (the site answered 403 to an automated read on 2026-09-21; the rule was seen
 * only in search-result excerpts of that PDF and of the Select Sector and
 * equal-weight methodologies, which state the same third-Friday close). The
 * holiday roll-back is not spelled out in any excerpt read. It matches how S&P
 * handled June 2026, when the third Friday was Juneteenth: changes were
 * announced as effective before the open on Monday 06-22, which leaves
 * Thursday 06-18 as the last session before them
 * (https://press.spglobal.com/2026-06-05-Marvell-Technology-and-Flex-Set-to-Join-S-P-500-Others-to-Join-S-P-MidCap-400-and-S-P-SmallCap-600).
 */
export function spQuarterlyRebalance(year: number, quarter: Quarter): string {
  assertQuarter(quarter);
  return monthlyOpex(year, quarter * 3);
}

/**
 * Nasdaq-100 methodology, "Index Calendar": rebalance effective "at market open
 * on the first trading day following the third Friday in March, June,
 * September, and December"; reconstitution effective "at market open on the
 * first trading day following the third Friday in December".
 * VERIFY: https://indexes.nasdaqomx.com/docs/Methodology_NDX.pdf (text read
 * 2026-09-21).
 *
 * The methodology names the first session ON the new weights; the calendar
 * dates an index event by the last session BEFORE them (see
 * `IndexEvent.date`), because that close is when tracking funds trade. That
 * session is the third Friday, rolled back when it is a holiday.
 *
 * Special rebalances (a weight-cap breach, as in July 2023) are announced ad
 * hoc and can only arrive through the curated list.
 */
export function nasdaq100Events(year: number): Array<{ date: string; annual: boolean }> {
  return QUARTERS.map((quarter) => ({ date: monthlyOpex(year, quarter * 3), annual: quarter === 4 }));
}

function withMovedNote(detail: string, year: number, month: number, date: string): string {
  return date === thirdFriday(year, month) ? detail : `${detail} ${MOVED_UP}`;
}

function ruleEventsForYear(year: number): Array<RebalanceEvent & { quarter: Quarter }> {
  const out: Array<RebalanceEvent & { quarter: Quarter }> = [];
  const ndx = nasdaq100Events(year);
  for (const quarter of QUARTERS) {
    const month = quarter * 3;
    const spDate = spQuarterlyRebalance(year, quarter);
    out.push({
      quarter,
      date: spDate,
      family: "sp",
      title: "S&P quarterly index rebalance",
      detail: withMovedNote(RULE_DETAIL, year, month, spDate),
      certainty: "rule",
      source: "rule",
    });
    const n = ndx[quarter - 1];
    out.push({
      quarter,
      date: n.date,
      family: "nasdaq100",
      title: n.annual ? "Nasdaq-100 annual reconstitution" : "Nasdaq-100 quarterly rebalance",
      detail: withMovedNote(n.annual ? RULE_DETAIL_ANNUAL : RULE_DETAIL, year, month, n.date),
      certainty: "rule",
      source: "rule",
    });
  }
  return out;
}

/**
 * The curated list is hand-compiled JSON, and its overlay is fetched at run
 * time without a release. One mistyped row must cost that row, not the whole
 * rebalance section, so anything that is not a real date, a known family and
 * a non-empty title is dropped here instead of being sorted and printed.
 */
function cleanCurated(curated: IndexEvent[]): IndexEvent[] {
  if (!Array.isArray(curated)) return [];
  const out: IndexEvent[] = [];
  const seen = new Set<string>();
  for (const row of curated) {
    if (!row || typeof row !== "object") continue;
    const { date, family, title } = row;
    if (typeof date !== "string" || !YMD.test(date)) continue;
    // "2026-02-31" passes the pattern; a round trip through the calendar does not.
    try {
      if (addCalendarDays(date, 0) !== date) continue;
    } catch {
      continue;
    }
    if (typeof family !== "string" || !Object.hasOwn(INDEX_FAMILY_LABEL, family)) continue;
    if (typeof title !== "string" || title.trim().length === 0) continue;
    // The shipped file and the overlay can both carry the same row.
    const key = `${family}|${date}|${title.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...row, title: title.trim() });
  }
  return out;
}

const FAMILY_ORDER: Record<IndexFamily, number> = { sp: 0, nasdaq100: 1, russell: 2, msci: 3 };

/**
 * How far from the rule date a curated entry still counts as the same event.
 * A provider that moves a quarterly rebalance moves it off the third Friday by
 * a session or two, the way the holiday roll-back does; anything further away
 * is a different event on a date of its own.
 */
const REPLACEMENT_SESSIONS = 2;

/**
 * The quarter a curated row replaces the rule date of, or null when it is
 * something else in the same month.
 *
 * The month alone is not the test. An ad-hoc constituent change (a merger
 * completing, an off-cycle addition) is announced with its own effective date
 * and is exactly what an operator drops into the overlay, and one landing in
 * December would otherwise silence the December rebalance itself: the deepest
 * closing auction of the quarter would vanish from the report. So the date has
 * to be the quarter's rule date, or within the roll-back range of it.
 */
function quarterEndKey(family: IndexFamily, date: string): string | null {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  if (month % 3 !== 0) return null;
  const quarter = (month / 3) as Quarter;
  try {
    const rule = family === "sp" ? spQuarterlyRebalance(year, quarter) : nasdaq100Events(year)[quarter - 1]!.date;
    const first = addTradingDays(rule, -REPLACEMENT_SESSIONS);
    const last = addTradingDays(rule, REPLACEMENT_SESSIONS);
    return date >= first && date <= last ? `${family}|${year}|Q${quarter}` : null;
  } catch {
    // A date the rules cannot place replaces nothing and is listed alongside.
    return null;
  }
}

/**
 * Every rebalance event with fromYmd <= date <= toYmd, sorted by date.
 *
 * A curated S&P or Nasdaq-100 entry replaces that family's rule date for the
 * quarter, so a provider that moves a rebalance is believed over the rule and
 * the reader never sees the same event twice, once "scheduled" and once
 * "announced". The replacement is decided BEFORE the range filter: a curated
 * date that falls outside the range must still silence the rule date inside it.
 *
 * Only a curated entry ON that quarter's rule date, or inside its roll-back
 * range, counts as that quarter's rebalance. Anything else is a different
 * event (a special rebalance, an ad hoc constituent change), and letting it
 * silence the scheduled one would drop a real rebalance from the report. It is
 * listed alongside the rule date instead.
 */
export function rebalanceEventsBetween(fromYmd: string, toYmd: string, curated: IndexEvent[]): RebalanceEvent[] {
  if (!YMD.test(fromYmd) || !YMD.test(toYmd)) {
    throw new RangeError(`rebalanceEventsBetween: bounds must be YYYY-MM-DD, got "${fromYmd}" and "${toYmd}"`);
  }
  if (toYmd < fromYmd) return [];

  const confirmed = cleanCurated(curated);
  const replaced = new Set<string>();
  for (const row of confirmed) {
    if (row.family !== "sp" && row.family !== "nasdaq100") continue;
    const key = quarterEndKey(row.family, row.date);
    if (key) replaced.add(key);
  }

  const out: RebalanceEvent[] = [];
  const inRange = (date: string): boolean => date >= fromYmd && date <= toYmd;

  // A roll-back never leaves the quarter-end month, so the years the range
  // touches are the only ones whose rule dates can fall inside it.
  const endYear = Number(toYmd.slice(0, 4));
  for (let year = Number(fromYmd.slice(0, 4)); year <= endYear; year++) {
    for (const { quarter, ...event } of ruleEventsForYear(year)) {
      if (!inRange(event.date)) continue;
      if (replaced.has(`${event.family}|${year}|Q${quarter}`)) continue;
      out.push(event);
    }
  }

  for (const row of confirmed) {
    if (!inRange(row.date)) continue;
    out.push({
      date: row.date,
      family: row.family,
      title: row.title,
      detail: CURATED_DETAIL,
      certainty: "confirmed",
      source: "curated",
    });
  }

  return out.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.family !== b.family) return FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family];
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });
}
