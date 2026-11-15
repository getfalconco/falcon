/**
 * The options block on Sightings cards (@falcon/ripple RippleOptions): what
 * one snapshot of a company's listed option chain prices, in the units
 * Falcon's own record uses. Pure: no fs, no network, no clock.
 *
 * Implied move over L sessions (docs/options-study.md, H7): the ATM implied
 * volatility of the first expiry on or after the window's last session,
 * times sqrt(L / 252) times sqrt(2 / pi) (the expected absolute move of a
 * normal). "Beyond the market" takes the market's part out of the variance
 * first: sqrt(max(IV^2 - beta^2 VIX^2, 0)), with the company's market-model
 * beta against SPY and the VIX close. That market-adjusted number is the one
 * comparable with Falcon's history (mean |move - benchmark move| after the
 * similar past events, `historyAbsMovePct`); the raw implied move is not (in
 * the study options priced more than the abnormal history 87% of the time in
 * raw units, about half the time in matched units).
 */

import { historyAbsMovePct, type OptionsMatched, type OptionsMove, type RippleHistory, type RippleOptions } from "@falcon/ripple";
import { addDays, fitMarketModel, nyseSessions } from "../study/abnormal.ts";
import { impliedAbsMovePct } from "./study-options.ts";
import type { SurfaceFeatures } from "./surface.ts";

export const OPTIONS_SOURCE = "OPRA via Databento" as const;

/** ATM IV of one expiry (fraction). */
export type TermPoint = { expiration: string; days: number; iv: number };

/** What the Sightings options job keeps per ticker and snapshot (cached between runs of the same snapshot). */
export type TickerOptions = {
  ticker: string;
  /** New York session date of the snapshot. */
  date: string;
  /** Snapshot instant (ISO). */
  asOf: string;
  spot: number;
  spotSource: "itch" | "parity" | "close";
  /** Fractions (0.42 = 42%). */
  atmIv30: number;
  skew: number | null;
  cpSpread: number | null;
  beta: number | null;
  /** VIX close as a fraction (0.17). */
  vix: number | null;
  /** ATM IV per expiry with at least 2 days left, nearest first. */
  term: TermPoint[];
  /** Percentile of atmIv30 among the ticker's own stored days (store.ts), when at least 20 are kept. */
  ivPct?: number | null;
};

/** The L-th NYSE session after `date` (the window's last session when the window starts at the next open). */
export function exitSession(date: string, L: number): string | null {
  if (!(L >= 1)) return null;
  const s = nyseSessions(addDays(date, 1), addDays(date, Math.ceil(L * 1.6) + 12));
  return s[L - 1] ?? null;
}

/** The first expiry on or after the window's last session that has an ATM IV. */
export function ivForWindow(term: readonly TermPoint[], date: string, L: number): TermPoint | null {
  const exit = exitSession(date, L);
  if (!exit) return null;
  return term.find((p) => p.expiration >= exit && p.days >= 2 && Number.isFinite(p.iv) && p.iv > 0) ?? null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Implied move over L sessions, raw and beyond the market (percent, 2
 * decimals); null without an expiry that covers the window. The market-
 * adjusted move is null without a beta or a VIX close, and when the market's
 * part is the whole implied variance or more (beta^2 VIX^2 >= IV^2: the study
 * floors that at 0, which would read as "no move beyond the market").
 */
export function impliedMoveFor(t: Pick<TickerOptions, "term" | "date" | "beta" | "vix">, L: number): OptionsMove | null {
  const p = ivForWindow(t.term, t.date, L);
  if (!p) return null;
  const raw = impliedAbsMovePct(p.iv, L);
  const known = t.beta !== null && t.vix !== null && Number.isFinite(t.beta) && Number.isFinite(t.vix);
  const adj = known && p.iv * p.iv > t.beta! * t.beta! * t.vix! * t.vix! ? impliedAbsMovePct(p.iv, L, t.beta, t.vix) : null;
  return { sessions: L, expiration: p.expiration, rawPct: r2(raw), marketAdjustedPct: adj === null ? null : r2(adj) };
}

/**
 * The options numbers next to a hit's own record, in matched units: the
 * implied move beyond the market over the record's window, and the record's
 * mean absolute move beyond the market. Null when either side is missing.
 */
export function matchedWithHistory(t: Pick<TickerOptions, "term" | "date" | "beta" | "vix">, history: RippleHistory | null | undefined): OptionsMatched | null {
  if (!history) return null;
  const L = history.windowDays;
  if (!Number.isInteger(L) || L < 1 || L > 60) return null;
  const hist = historyAbsMovePct(history);
  if (hist === null) return null;
  const mv = impliedMoveFor(t, L);
  if (!mv || mv.marketAdjustedPct === null) return null;
  return { windowDays: L, rawPct: mv.rawPct, impliedPct: mv.marketAdjustedPct, historyPct: r2(hist), sample: history.events?.length ?? history.sample };
}

/** The card block for a ticker (with the matched comparison when a hit's record is given). */
export function optionsBlock(t: TickerOptions, history?: RippleHistory | null): RippleOptions {
  const block: RippleOptions = {
    asOf: t.asOf,
    source: OPTIONS_SOURCE,
    spot: r2(t.spot),
    atmIv: r1(t.atmIv30 * 100),
    impliedMove5: impliedMoveFor(t, 5),
    impliedMove20: impliedMoveFor(t, 20),
    skew: t.skew === null ? null : r1(t.skew * 100),
    cpSpread: t.cpSpread === null ? null : r1(t.cpSpread * 100),
    beta: t.beta === null ? null : r2(t.beta),
    vix: t.vix === null ? null : r2(t.vix * 100),
  };
  if (typeof t.ivPct === "number" && Number.isFinite(t.ivPct)) block.ivPct = t.ivPct;
  if (history !== undefined) {
    const m = matchedWithHistory(t, history);
    if (m) block.matched = m;
  }
  return block;
}

/** Minimum contracts with an implied volatility for a chain to be used. */
export const MIN_CONTRACTS_WITH_IV = 20;

/**
 * Why a chain is too poor to show, or null: any surface.ts warning (parity
 * spot more than 1% off, under half the contracts quoted, no ATM curve), too
 * few contracts with an IV, or no expiry covering a week.
 */
export function chainProblem(f: Pick<SurfaceFeatures, "atmIv30" | "quality" | "expiries">): string | null {
  if (f.quality.warnings.length) return f.quality.warnings.join("; ");
  if (f.atmIv30 === null) return "no ATM IV curve";
  if (f.quality.withIv < MIN_CONTRACTS_WITH_IV) return `only ${f.quality.withIv} contracts with an IV`;
  if (!f.expiries.some((e) => e.days >= 2 && e.atmIv !== null)) return "no expiry with an ATM IV";
  return null;
}

/** The ticker record from surface features (call chainProblem first). */
export function tickerOptionsFrom(
  f: SurfaceFeatures,
  ctx: { ticker: string; spotSource: TickerOptions["spotSource"]; beta: number | null; vix: number | null },
): TickerOptions {
  return {
    ticker: ctx.ticker,
    date: f.date,
    asOf: new Date(f.asOfMs).toISOString(),
    spot: f.spot,
    spotSource: ctx.spotSource,
    atmIv30: f.atmIv30 ?? NaN,
    skew: f.skew,
    cpSpread: f.callPutSpread,
    beta: ctx.beta,
    vix: ctx.vix,
    term: f.expiries
      .filter((e) => e.atmIv !== null && e.days >= 2)
      .map((e) => ({ expiration: e.expiration, days: Math.round(e.days * 100) / 100, iv: Math.round(e.atmIv! * 1e5) / 1e5 })),
  };
}

/**
 * Market-model beta from adjusted daily closes (OLS of close-to-close
 * returns on the benchmark's), over up to 250 sessions ending 10 sessions
 * before `date` (the study's estimation window, -260 to -11). Null with fewer
 * than 120 common days.
 */
export function betaFromCloses(
  stock: ReadonlyArray<{ date: string; close: number }>,
  market: ReadonlyArray<{ date: string; close: number }>,
  date: string,
): number | null {
  const m = new Map(market.filter((r) => r.date <= date).map((r) => [r.date, r.close]));
  const rows = stock.filter((r) => r.date <= date && m.has(r.date) && r.close > 0 && m.get(r.date)! > 0);
  const n = rows.length;
  if (n < 131) return null;
  const s = { open: rows.map((r) => r.close), close: rows.map((r) => r.close) };
  const k = { open: rows.map((r) => m.get(r.date)!), close: rows.map((r) => m.get(r.date)!) };
  const hi = n - 11;
  const lo = Math.max(1, hi - 249);
  const model = fitMarketModel(s, k, lo, hi, 120);
  return model ? model.beta : null;
}

/** The latest FRED observation on or before `date` (within 10 days), or null. */
export function latestOnOrBefore(points: ReadonlyArray<{ date: string; pct: number }>, date: string): number | null {
  let best: { date: string; pct: number } | null = null;
  for (const p of points) {
    if (p.date > date) break;
    best = p;
  }
  return best && Date.parse(date) - Date.parse(best.date) <= 10 * 86_400_000 ? best.pct : null;
}
