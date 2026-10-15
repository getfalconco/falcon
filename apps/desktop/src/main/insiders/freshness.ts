/**
 * When a company's EDGAR list is read again.
 *
 * EDGAR takes filings on business days (Form 4s until 10 pm New York time),
 * so the list is read again at most every three hours, and on a day the
 * market is closed only once, to catch what came in after the last read of
 * the business day before. A list a week old is read again whatever the day.
 *
 * Pure.
 */

import { isSessionDay, nyYmdOf } from "../../shared/earnings-time";

export const REFRESH_EVERY_MS = 3 * 60 * 60_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;

export function isStale(checkedAtMs: number | null | undefined, nowMs: number): boolean {
  if (typeof checkedAtMs !== "number" || !Number.isFinite(checkedAtMs)) return true;
  const age = nowMs - checkedAtMs;
  if (age < REFRESH_EVERY_MS) return false;
  if (age >= WEEK_MS) return true;
  if (isSessionDay(nyYmdOf(nowMs))) return true;
  // A closed day: once, if the last read was made on a business day.
  return isSessionDay(nyYmdOf(checkedAtMs));
}
