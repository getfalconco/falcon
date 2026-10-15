/**
 * Earnings: how a stock has moved on its reports, from its own daily closes.
 *
 *   usual move         mean |close-to-close move| on the session that first
 *                      traded each of the last four reports (the Tracker's
 *                      earnings_rhythm, by the same helper)
 *   normal daily move  mean |1-day move| over the last 60 sessions, the
 *                      report sessions left out
 *
 * The report dates and release instants are Yahoo's record of the last
 * quarters (the earnings service's per-name read); the closes are a year and
 * a bit of daily bars from the chart path. Both are read for any name, so a
 * foreign filer the Tracker has no 8-K history for still gets a figure.
 *
 * Kept per name for the New York day: the closes only change once a day.
 *
 * Electron-free: the readers, the folder and the clock are injected.
 */

import path from "node:path";
import { earningsReactionMoves, earningsRhythm } from "@meridian/research/tracker";
import { readJson, writeJsonAtomic } from "../briefing/json-file";
import type { EarningsReaction } from "../../shared/earnings-types";
import type { PricePoint } from "../../shared/stock-types";
import { nyYmdOf, timeOfRelease } from "../../shared/earnings-time";
import type { YahooQuarter } from "./earnings-sources";

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 430;
const NORMAL_SESSIONS = 60;
const NORMAL_MIN_SESSIONS = 20;
const USUAL_REPORTS = 4;
const SCHEMA_VERSION = 1;
const FAILURE_RETRY_MS = 30 * 60_000;

export type Bar = { d: string; c: number };

/** Daily closes by New York date (Yahoo stamps a daily equity bar at the open). */
export function barsFrom(points: readonly PricePoint[]): Bar[] {
  const byDay = new Map<string, number>();
  for (const p of points) if (Number.isFinite(p.v) && p.v > 0) byDay.set(nyYmdOf(p.t), p.v);
  return [...byDay.entries()].map(([d, c]) => ({ d, c })).sort((a, b) => a.d.localeCompare(b.d));
}

/**
 * The reaction figures from closes and the quarters on record. A session
 * still under way (today) is never counted into the usual or the normal
 * move; its report's move is listed when the closes reach it.
 */
export function computeReaction(bars: readonly Bar[], quarters: readonly YahooQuarter[], today: string): EarningsReaction {
  const reports = quarters
    .filter((q) => q.epsActual !== null && (q.reportedAt || q.reportedYmd))
    .map((q) => {
      const ms = q.reportedAt ? Date.parse(q.reportedAt) : null;
      const date = ms !== null ? nyYmdOf(ms) : q.reportedYmd!;
      // The Tracker's rule reads "amc" as next session and anything else as the same one.
      const hour = ms !== null ? timeOfRelease(ms) : null;
      return { date, hour, releasedAt: q.reportedAt };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const releaseByDate = new Map(reports.map((r) => [r.date, r.releasedAt]));
  const moves = earningsReactionMoves(bars, reports).map((m) => ({
    date: m.date,
    reactionDay: m.reactionDay,
    releasedAt: releaseByDate.get(m.date) ?? null,
    move: Math.round(m.move * 1e6) / 1e6,
  }));
  const done = moves.filter((m) => m.reactionDay < today);
  const usualMove = earningsRhythm(done.slice(-USUAL_REPORTS).map((m) => Math.abs(m.move)));

  const reactionDays = new Set(moves.map((m) => m.reactionDay));
  const closed = bars.filter((b) => b.d < today);
  const daily: number[] = [];
  for (let i = 1; i < closed.length; i++) {
    const prev = closed[i - 1]!;
    const bar = closed[i]!;
    if (prev.c === 0 || reactionDays.has(bar.d)) continue;
    daily.push(Math.abs(bar.c / prev.c - 1));
  }
  const recent = daily.slice(-NORMAL_SESSIONS);
  const normalDailyMove = recent.length >= NORMAL_MIN_SESSIONS ? recent.reduce((a, b) => a + b, 0) / recent.length : null;

  return {
    usualMove: usualMove === null ? null : Math.round(usualMove * 1e6) / 1e6,
    moves: moves.slice(-(USUAL_REPORTS + 1)),
    normalDailyMove: normalDailyMove === null ? null : Math.round(normalDailyMove * 1e6) / 1e6,
    asOf: closed.length > 0 ? closed[closed.length - 1]!.d : null,
  };
}

export type ReactionDeps = {
  dir: string;
  fetchDaily: (symbol: string, startSec: number, endSec: number) => Promise<PricePoint[]>;
  /** The quarters on record for a name (the earnings service's read); null when there are none. */
  quarters: (symbol: string) => Promise<YahooQuarter[] | null>;
  now?: () => number;
  concurrency?: number;
};

type ReactionsFile = { schema_version: number; day: string; symbols: Record<string, EarningsReaction | null> };

export function createReactionService(deps: ReactionDeps) {
  const now = deps.now ?? Date.now;
  const file = path.join(deps.dir, "reactions.json");
  const concurrency = deps.concurrency ?? 4;
  let store: ReactionsFile | null = null;
  const failedAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<EarningsReaction | null>>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const load = (day: string): ReactionsFile => {
    if (store && store.day === day) return store;
    const disk = readJson<ReactionsFile>(file);
    store = disk && disk.schema_version === SCHEMA_VERSION && disk.day === day && disk.symbols && typeof disk.symbols === "object" ? disk : { schema_version: SCHEMA_VERSION, day, symbols: {} };
    return store;
  };

  const flush = () => {
    flushTimer = null;
    if (!store) return;
    try {
      writeJsonAtomic(file, store);
    } catch (err) {
      console.warn("[earnings] reactions write failed:", err instanceof Error ? err.message : String(err));
    }
  };

  const one = (symbol: string): Promise<EarningsReaction | null> => {
    const nowMs = now();
    const today = nyYmdOf(nowMs);
    const s = load(today);
    if (symbol in s.symbols) return Promise.resolve(s.symbols[symbol] ?? null);
    const failed = failedAt.get(symbol);
    if (failed !== undefined && nowMs - failed < FAILURE_RETRY_MS) return Promise.resolve(null);
    const pending = inFlight.get(symbol);
    if (pending) return pending;
    const task = (async () => {
      try {
        const [points, quarters] = await Promise.all([
          deps.fetchDaily(symbol, Math.floor((nowMs - HISTORY_DAYS * DAY_MS) / 1000), Math.floor(nowMs / 1000)),
          deps.quarters(symbol),
        ]);
        const reaction = computeReaction(barsFrom(points), quarters ?? [], today);
        load(today).symbols[symbol] = reaction;
        if (!flushTimer) {
          flushTimer = setTimeout(flush, 250);
          flushTimer.unref?.();
        }
        return reaction;
      } catch (err) {
        failedAt.set(symbol, now());
        console.warn("[earnings] reaction read failed:", symbol, err instanceof Error ? err.message : String(err));
        return null;
      }
    })().finally(() => inFlight.delete(symbol));
    inFlight.set(symbol, task);
    return task;
  };

  return {
    one,
    async many(symbols: readonly string[]): Promise<Record<string, EarningsReaction | null>> {
      const out: Record<string, EarningsReaction | null> = {};
      let next = 0;
      const worker = async () => {
        while (next < symbols.length) {
          const s = symbols[next++]!;
          out[s] = await one(s);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, symbols.length)) }, worker));
      return out;
    },
  };
}

export type ReactionService = ReturnType<typeof createReactionService>;
