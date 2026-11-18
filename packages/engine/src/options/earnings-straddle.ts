/**
 * The pre-earnings ATM straddle: what the options market prices for one
 * earnings reaction, as a fraction of spot.
 *
 *   implied_move = (call_mid + put_mid) / spot
 *
 * at the strike nearest spot that has a usable call and put quote, in the
 * first listed expiry that covers the reaction session, from the 15:45 New
 * York snapshot (12:45 on early-close days) of the last session before the
 * market can react.
 *
 * Sessions follow the event-day rule of study/earnings-events.ts (eventDay):
 * a release before a session's close moves that session, one at or after the
 * close (or on a weekend or holiday) moves the next one. A release time Yahoo
 * does not give (or only estimates) is read both ways: the snapshot is the
 * session before the earliest possible reaction, the expiry covers the
 * latest one. An expiry covers a session when it expires at or after that
 * session's close (its date is on or after the session).
 *
 * Stored by the daily job inside options_daily.metrics as `earnings_straddle`
 * (the names study/scoreboard.ts EarningsStraddle reads), and computed on
 * demand by the website's /options (apps/web lib/desk/tools/iv.ts).
 * Pure: no fs, no network, no clock.
 */

import { isNyseEarlyClose, nyInstantMs } from "../study/abnormal.ts";
import { eventDay, prevSession } from "../study/earnings-events.ts";

export type EarningsTime = "before_open" | "during" | "after_close" | "unknown";

/** One earnings release: its New York date and time of day. */
export type EarningsRelease = { date: string; time: EarningsTime };

/** options_daily.metrics.earnings_straddle (fractions; as_of an ISO instant). */
export type EarningsStraddle = {
  /** (call_mid + put_mid) / spot. */
  implied_move: number;
  expiry: string;
  strike: number;
  call_mid: number;
  put_mid: number;
  spot: number;
  /** Snapshot instant (ISO). */
  as_of: string;
  /** Calendar days from the snapshot to the expiry's 16:00 New York close. */
  dte: number;
  /** The quote minute, e.g. "2026-11-17 15:45 ET". */
  source_minute: string;
  earnings_date: string;
  earnings_time: EarningsTime;
  /** The first session that can react (the latest one when the time is unknown). */
  reaction_day: string;
  source: string;
};

/** Minutes after New York midnight a release is assumed at, per time of day. */
const AT_MIN: Record<Exclude<EarningsTime, "unknown">, number> = { before_open: 7 * 60, during: 12 * 60, after_close: 16 * 60 + 5 };

/** The time of day of a New York minute (before 09:30, from the close, or during). Pure. */
export function timeOfDayAt(date: string, minutes: number): EarningsTime {
  const close = isNyseEarlyClose(date) ? 13 * 60 : 16 * 60;
  return minutes < 9 * 60 + 30 ? "before_open" : minutes >= close ? "after_close" : "during";
}

/**
 * The sessions of a release: the earliest and latest that can react (equal
 * when the time is known) and the snapshot session, the last one before the
 * earliest reaction. Pure.
 */
export function releaseSessions(e: EarningsRelease): { reactEarliest: string; reactLatest: string; snapshotSession: string } {
  const day = (t: Exclude<EarningsTime, "unknown">) => eventDay(nyInstantMs(e.date, AT_MIN[t]));
  const reactEarliest = day(e.time === "unknown" ? "before_open" : e.time);
  const reactLatest = day(e.time === "unknown" ? "after_close" : e.time);
  return { reactEarliest, reactLatest, snapshotSession: prevSession(reactEarliest) };
}

/** The first listed expiry (YYYY-MM-DD) on or after the latest reaction session. Pure. */
export function straddleExpiry(expirations: readonly string[], e: EarningsRelease): string | null {
  const { reactLatest } = releaseSessions(e);
  return [...new Set(expirations)].filter((x) => x >= reactLatest).sort()[0] ?? null;
}

/** A quote of one contract: its mid when two-sided (bid > 0, ask >= bid), else null. Pure. */
export function usableMid(bid: number | null | undefined, ask: number | null | undefined): number | null {
  if (typeof bid !== "number" || typeof ask !== "number" || !Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  if (!(bid > 0) || ask < bid) return null;
  return (bid + ask) / 2;
}

export type StraddleRow = { right: "C" | "P"; strike: number; expiration: string; bid: number | null; ask: number | null };

/**
 * The straddle of a release from one snapshot's contracts (surface.ts
 * ContractRow or any row with bid and ask). Null when no expiry covers the
 * reaction or that expiry has no strike with a usable call and put. Pure.
 */
export function earningsStraddle(
  rows: readonly StraddleRow[],
  spot: number,
  e: EarningsRelease,
  meta: { asOfMs: number; sourceMinute: string; source: string },
): EarningsStraddle | null {
  if (!(spot > 0)) return null;
  const expiry = straddleExpiry(
    rows.map((r) => r.expiration),
    e,
  );
  if (!expiry) return null;
  const byStrike = new Map<number, { C?: number; P?: number }>();
  for (const r of rows) {
    if (r.expiration !== expiry) continue;
    const mid = usableMid(r.bid, r.ask);
    if (mid === null) continue;
    const s = byStrike.get(r.strike) ?? {};
    s[r.right] = mid;
    byStrike.set(r.strike, s);
  }
  let best: { strike: number; C: number; P: number } | null = null;
  for (const [strike, s] of byStrike) {
    if (s.C === undefined || s.P === undefined) continue;
    const d = Math.abs(strike - spot);
    if (!best || d < Math.abs(best.strike - spot) || (d === Math.abs(best.strike - spot) && strike < best.strike)) best = { strike, C: s.C, P: s.P };
  }
  if (!best) return null;
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const { reactLatest } = releaseSessions(e);
  return {
    implied_move: r6((best.C + best.P) / spot),
    expiry,
    strike: best.strike,
    call_mid: r6(best.C),
    put_mid: r6(best.P),
    spot: r6(spot),
    as_of: new Date(meta.asOfMs).toISOString(),
    dte: Math.round(((nyInstantMs(expiry, 16 * 60) - meta.asOfMs) / 86_400_000) * 100) / 100,
    source_minute: meta.sourceMinute,
    earnings_date: e.date,
    earnings_time: e.time,
    reaction_day: reactLatest,
    source: meta.source,
  };
}

/**
 * Releases from a Yahoo quote row (v7 quote: earningsTimestamp, the latest
 * date, and earningsTimestampStart, the next; isEarningsDateEstimate). An
 * estimated date, or a time exactly at midnight UTC, has no known time of day. Pure.
 */
export function releasesFromQuote(row: Record<string, unknown>): EarningsRelease[] {
  const estimated = row.isEarningsDateEstimate === true;
  const out = new Map<string, EarningsRelease>();
  for (const k of ["earningsTimestamp", "earningsTimestampStart"]) {
    const s = row[k];
    if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) continue;
    const ms = s * 1000;
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    const date = s % 86_400 === 0 ? new Date(ms).toISOString().slice(0, 10) : `${get("year")}-${get("month")}-${get("day")}`;
    const time: EarningsTime = estimated || s % 86_400 === 0 ? "unknown" : timeOfDayAt(date, Number(get("hour")) * 60 + Number(get("minute")));
    out.set(date, { date, time });
  }
  return [...out.values()];
}

/** The release whose straddle belongs to session `date` (its snapshot session is `date`), or null. Pure. */
export function releaseForSession(releases: readonly EarningsRelease[], date: string): EarningsRelease | null {
  return releases.find((e) => releaseSessions(e).snapshotSession === date) ?? null;
}
