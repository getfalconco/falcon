/**
 * The Dashboard's market chip: where the NYSE regular session stands at an
 * instant. "US market opens in 3h 24m", "Market open · closes in 2h 10m",
 * "Market closed · opens Mon 9:30 ET".
 *
 * Calendar: the engine's NYSE rules (packages/engine/src/study/abnormal.ts:
 * full-day holidays, the listed unscheduled closures, 13:00 early closes on
 * July 3, the day after Thanksgiving and December 24), the same one the
 * options job and the event studies use. Session 09:30 to 16:00 New York
 * (13:00 on early-close days).
 *
 * Pure: the instant is a parameter.
 */

import { addDays, isNyseEarlyClose, isNyseSession, nyInstantMs } from "../../../../packages/engine/src/study/abnormal.ts";
import { nyOffsetMs } from "../../../../packages/engine/src/edgar-time.ts";

export const OPEN_MIN = 9 * 60 + 30;
export const CLOSE_MIN = 16 * 60;
export const EARLY_CLOSE_MIN = 13 * 60;

export type MarketState = "open" | "pre" | "closed";

export type MarketStatus = {
  state: MarketState;
  /** The chip text. */
  label: string;
  /** New York date of the instant (YYYY-MM-DD). */
  today: string;
  /** True on a 13:00 close day that is still a session. */
  earlyClose: boolean;
  /** The next change of state (open or close), epoch ms. */
  nextChangeMs: number;
};

/** The New York date of an instant. */
export function nyDate(ms: number): string {
  return new Date(ms + nyOffsetMs(ms)).toISOString().slice(0, 10);
}

/** "3h 24m", "3h", "45m"; whole minutes rounded up, so a countdown never reads 0m before the bell. */
export function formatCountdown(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function closeMinOf(ymd: string): number {
  return isNyseEarlyClose(ymd) ? EARLY_CLOSE_MIN : CLOSE_MIN;
}

/** The first session on or after a date. */
function sessionOnOrAfter(ymd: string): string {
  let d = ymd;
  while (!isNyseSession(d)) d = addDays(d, 1);
  return d;
}

/** "tomorrow" for the next calendar day, else the short weekday ("Mon"). */
function dayWord(day: string, today: string): string {
  if (day === addDays(today, 1)) return "tomorrow";
  return WEEKDAY[new Date(`${day}T12:00:00Z`).getUTCDay()]!;
}

/**
 * The session's state at `nowMs`. Before the open on a session day the chip
 * counts down to it; after the close, on a weekend or a holiday it names the
 * next open (New York time).
 */
export function marketStatus(nowMs: number): MarketStatus {
  const today = nyDate(nowMs);
  const session = isNyseSession(today);
  const earlyClose = session && isNyseEarlyClose(today);
  if (session) {
    const openMs = nyInstantMs(today, OPEN_MIN);
    const closeMs = nyInstantMs(today, closeMinOf(today));
    if (nowMs < openMs) {
      return { state: "pre", label: `US market opens in ${formatCountdown(openMs - nowMs)}`, today, earlyClose, nextChangeMs: openMs };
    }
    if (nowMs < closeMs) {
      return { state: "open", label: `Market open · closes in ${formatCountdown(closeMs - nowMs)}`, today, earlyClose, nextChangeMs: closeMs };
    }
  }
  const next = sessionOnOrAfter(addDays(today, 1));
  return {
    state: "closed",
    label: `Market closed · opens ${dayWord(next, today)} 9:30 ET`,
    today,
    earlyClose,
    nextChangeMs: nyInstantMs(next, OPEN_MIN),
  };
}
