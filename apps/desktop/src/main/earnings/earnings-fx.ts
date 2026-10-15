/**
 * Earnings: dated rates from a reporting currency to US dollars, so a Taiwan
 * dollar revenue line can be read beside a dollar one.
 *
 * The rate is Yahoo's daily close of the `{CUR}USD=X` pair, read through the
 * same chart path the stock view uses: one read per currency per New York
 * day, a month of closes, kept in memory. A figure is converted at the last
 * close on or before the day it belongs to (the release day for a reported
 * quarter, today for a consensus), and the row carries that close's date.
 *
 * Electron-free: the chart reader and the clock are injected.
 */

import type { PricePoint } from "../../shared/stock-types";
import type { EarningsFx } from "../../shared/earnings-types";
import { nyYmdOf } from "../../shared/earnings-time";

const DAY_MS = 86_400_000;
const LOOKBACK_DAYS = 45;
const FAILURE_RETRY_MS = 30 * 60_000;

export type FxClose = { d: string; rate: number };

/**
 * The day a currency pair's daily bar belongs to. Yahoo stamps FX bars at
 * local midnight of the market's own zone (23:00 UTC for London in summer),
 * so the UTC date of a stamp twelve hours on is the day the bar is for.
 */
export function fxBarDay(tMs: number): string {
  return new Date(tMs + 12 * 3_600_000).toISOString().slice(0, 10);
}

export function fxCloses(points: readonly PricePoint[]): FxClose[] {
  const byDay = new Map<string, number>();
  for (const p of points) {
    if (!Number.isFinite(p.v) || p.v <= 0) continue;
    byDay.set(fxBarDay(p.t), p.v);
  }
  return [...byDay.entries()].map(([d, rate]) => ({ d, rate })).sort((a, b) => a.d.localeCompare(b.d));
}

/** The last close on or before `ymd`; null when there is none. */
export function rateOn(closes: readonly FxClose[], ymd: string): FxClose | null {
  let found: FxClose | null = null;
  for (const c of closes) {
    if (c.d > ymd) break;
    found = c;
  }
  return found;
}

/** `value` in US dollars at `fx`, rounded to the dollar. */
export function toUsd(value: number | null, fx: EarningsFx | null): number | null {
  if (value === null || fx === null || !Number.isFinite(value)) return null;
  return Math.round(value * fx.rate);
}

export type FxDeps = {
  fetchDaily: (symbol: string, startSec: number, endSec: number) => Promise<PricePoint[]>;
  now?: () => number;
};

export function createFx(deps: FxDeps) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { day: string; closes: FxClose[] | null; at: number }>();
  const inFlight = new Map<string, Promise<FxClose[] | null>>();

  const closesFor = (code: string): Promise<FxClose[] | null> => {
    const nowMs = now();
    const day = nyYmdOf(nowMs);
    const hit = cache.get(code);
    if (hit && hit.day === day && (hit.closes !== null || nowMs - hit.at < FAILURE_RETRY_MS)) return Promise.resolve(hit.closes);
    const pending = inFlight.get(code);
    if (pending) return pending;
    const task = deps
      .fetchDaily(`${code}USD=X`, Math.floor((nowMs - LOOKBACK_DAYS * DAY_MS) / 1000), Math.floor(nowMs / 1000))
      .then((points) => {
        const closes = fxCloses(points);
        cache.set(code, { day, closes: closes.length > 0 ? closes : null, at: now() });
        return closes.length > 0 ? closes : null;
      })
      .catch((err) => {
        console.warn("[earnings] fx read failed:", code, err instanceof Error ? err.message : String(err));
        cache.set(code, { day, closes: hit?.closes ?? null, at: now() });
        return hit?.closes ?? null;
      })
      .finally(() => inFlight.delete(code));
    inFlight.set(code, task);
    return task;
  };

  return {
    /** The dated rate for `currency` on `ymd`; null for US dollars, an unknown code, or no close on record. */
    async rate(currency: string | null, ymd: string): Promise<EarningsFx | null> {
      if (!currency || currency === "USD" || !/^[A-Z]{3}$/.test(currency)) return null;
      const closes = await closesFor(currency);
      const close = closes ? rateOn(closes, ymd) : null;
      return close ? { currency, rate: close.rate, asOf: close.d } : null;
    },
  };
}

export type EarningsFxService = ReturnType<typeof createFx>;
