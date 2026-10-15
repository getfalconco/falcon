/**
 * Earnings, "For you": which reports beyond the reader's own names are worth
 * listing, and why each one is there.
 *
 *   held / watchlist  the reader's names, always first
 *   linked            a 10-K or 20-F links the company to one of them (the
 *                     "reads through to" links, filing-backed only)
 *   sector            a large or mid-size company in a sector the reader
 *                     follows (picked at onboarding, or one their holdings
 *                     are in)
 *   large             one of the biggest US listings (a market value of $50B
 *                     or more)
 *
 * In that order, each company once, under its first reason. Nothing here
 * hides a report the reader asked for: the holding period they gave at
 * onboarding is not used to leave anything out.
 *
 * Pure.
 */

import type { CalendarSector } from "./calendar-events";
import type { EarningsReason } from "./earnings-types";

/** A market value from which a company counts as one of the biggest listings. */
export const LARGE_CAP_USD = 50e9;
/** The smallest market value a sector fit is listed at: below it a sector holds hundreds of names. */
export const SECTOR_MIN_CAP_USD = 10e9;
/**
 * The consensus revenue for one quarter below which a company is not looked
 * up for its market value at all. A $10B company with less than $300M a
 * quarter is rare, and the cut keeps the batched market-value reads to a few
 * hundred names a week instead of thousands.
 */
export const CAP_LOOKUP_MIN_REVENUE = 300e6;

export const REASON_RANK: Readonly<Record<EarningsReason, number>> = {
  held: 0,
  watchlist: 1,
  linked: 2,
  sector: 3,
  large: 4,
};

export function reasonRank(reason: EarningsReason | null): number {
  return reason === null ? 5 : REASON_RANK[reason];
}

/** The onboarding sector ids (shared/user-preferences.ts `SectorId`) as the calendar's sectors. */
const FROM_ONBOARDING: Readonly<Record<string, readonly CalendarSector[]>> = {
  technology: ["Technology", "Communication Services"],
  semiconductors: ["Technology"],
  energy: ["Energy"],
  healthcare: ["Healthcare"],
  financials: ["Financials"],
  consumer: ["Consumer Discretionary", "Consumer Staples"],
  industrials: ["Industrials"],
  // No calendar sector holds crypto names on its own.
  crypto: [],
};

export function calendarSectorsFor(ids: readonly string[]): CalendarSector[] {
  const out = new Set<CalendarSector>();
  for (const id of ids) for (const s of FROM_ONBOARDING[id] ?? []) out.add(s);
  return [...out];
}

export type ForYouCandidate = {
  ticker: string;
  /** Market value in dollars; null when it could not be learned. */
  cap: number | null;
  sector: CalendarSector | null;
  /** A filing links it to one of the reader's names. */
  linked: boolean;
};

/**
 * Why a company outside the reader's names is listed, or null when it is not.
 * A company with no market value on record can still be listed as linked.
 */
export function forYouReason(c: ForYouCandidate, userSectors: ReadonlySet<CalendarSector>): EarningsReason | null {
  if (c.linked) return "linked";
  if (c.cap !== null && c.cap >= SECTOR_MIN_CAP_USD && c.sector !== null && userSectors.has(c.sector)) return "sector";
  if (c.cap !== null && c.cap >= LARGE_CAP_USD) return "large";
  return null;
}

/** The reader's own reason for a name, when it is one of theirs. */
export function mineReason(ticker: string, held: ReadonlySet<string>, watchlist: ReadonlySet<string>): EarningsReason | null {
  return held.has(ticker) ? "held" : watchlist.has(ticker) ? "watchlist" : null;
}
