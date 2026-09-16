/**
 * Close-run hook (spec §5, §10.4) — the same mechanism the Risk Engine uses:
 * the Tracker emits no "close-run complete" event, so the host samples a
 * fingerprint (the completed session + every ticker's `lastCloseComputedFor`)
 * on a poll and scans when it moves. Kept pure so it can be tested without a
 * clock:
 *
 *   - the session to scan is `lastCompletedTradingDay(now)`; on a weekend or
 *     holiday that is still Friday, the fingerprint does not move → no-op
 *   - the scan waits until at least one ticker's close-run has landed for the
 *     session (otherwise every ticker would only read "bars lag")
 *   - every later fingerprint move for the same session re-runs the scan —
 *     re-runs are idempotent per session, so late tickers simply fill in
 */

import { lastCompletedTradingDay } from "../tracker/calendar.js";

export type ScreenHookKeys = {
  /** Completed trading session as of the sample. */
  session: string;
  /** "T:closeDay,T:closeDay,…" over the universe, sorted. */
  close: string;
  /** Tickers whose close-run has reached `session`. */
  landed: number;
  total: number;
};

export function computeHookKeys(now: Date, closeDay: Record<string, string | null>): ScreenHookKeys {
  const session = lastCompletedTradingDay(now);
  const tickers = Object.keys(closeDay).map((t) => t.toUpperCase()).sort();
  const close = tickers.map((t) => `${t}:${closeDay[t] ?? closeDay[t.toLowerCase()] ?? "-"}`).join(",");
  const landed = tickers.filter((t) => (closeDay[t] ?? closeDay[t.toLowerCase()]) === session).length;
  return { session, close, landed, total: tickers.length };
}

export type HookDecision = { scan: boolean; session: string; reason: "first_scan" | "close_run" | null };

/**
 * Decide whether a sampled fingerprint calls for a scan.
 * `lastScannedSession` is the newest scan on record (null before the first).
 */
export function decideScan(prev: ScreenHookKeys | null, next: ScreenHookKeys, lastScannedSession: string | null): HookDecision {
  if (next.total === 0 || next.landed === 0) return { scan: false, session: next.session, reason: null };
  if (lastScannedSession !== next.session) return { scan: true, session: next.session, reason: "first_scan" };
  if (prev && prev.close !== next.close) return { scan: true, session: next.session, reason: "close_run" };
  return { scan: false, session: next.session, reason: null };
}
