/**
 * Competitor dynamics, from daily closes: how a stock and its competitors
 * have moved together, and whether the stock's large moves were shared.
 *
 *   co-movement      Pearson correlation of daily close-to-close returns,
 *                    over the last ~252 sessions (a year) and ~63 (three
 *                    months), on the sessions both traded
 *   notable move     a session whose return is at least two standard
 *                    deviations of the stock's year of daily returns
 *   sector vs shift  on a notable session, each competitor's own return in
 *                    its own standard deviations: one standard deviation or
 *                    more the same way counts as "same", the other way as
 *                    "opposite", less as "flat". Half or more "same" reads
 *                    as a sector move; otherwise (opposite or flat) the move
 *                    was the stock's own, a share shift
 *
 * Pure: no fs, no network, no clock.
 */

import type { MoveVerdict, NotableMoveRow } from "./stock-tab-data";

export type Bar = { d: string; c: number };

export const YEAR_SESSIONS = 252;
export const QUARTER_SESSIONS = 63;
/** Fewest shared returns a correlation is computed from, per window. */
export const MIN_OVERLAP_YEAR = 120;
export const MIN_OVERLAP_QUARTER = 40;
export const NOTABLE_Z = 2;
export const PEER_MOVE_Z = 1;
/** How far back notable sessions are looked for, in sessions. */
export const NOTABLE_LOOKBACK = 126;
export const NOTABLE_LIMIT = 5;

/** Close-to-close returns by date (the later session's date), oldest first. Bars are sorted and de-duplicated first. */
export function dailyReturns(bars: readonly Bar[]): Array<{ d: string; r: number }> {
  const clean = [...new Map(bars.filter((b) => Number.isFinite(b.c) && b.c > 0).map((b) => [b.d, b.c] as const)).entries()]
    .map(([d, c]) => ({ d, c }))
    .sort((a, b) => a.d.localeCompare(b.d));
  const out: Array<{ d: string; r: number }> = [];
  for (let i = 1; i < clean.length; i++) out.push({ d: clean[i]!.d, r: clean[i]!.c / clean[i - 1]!.c - 1 });
  return out;
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation; null with fewer than two values. */
export function stdev(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** Pearson correlation; null when either side does not vary or the lengths differ. */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

/**
 * The correlation of the two return series over the stock's last `sessions`
 * returns, on the dates both have. Null with fewer than `minOverlap` shared
 * returns.
 */
export function coMovement(stock: readonly Bar[], peer: readonly Bar[], sessions: number, minOverlap: number): number | null {
  const s = dailyReturns(stock).slice(-sessions);
  const p = new Map(dailyReturns(peer).map((x) => [x.d, x.r] as const));
  const a: number[] = [];
  const b: number[] = [];
  for (const x of s) {
    const r = p.get(x.d);
    if (r === undefined) continue;
    a.push(x.r);
    b.push(r);
  }
  if (a.length < minOverlap) return null;
  const c = pearson(a, b);
  return c === null ? null : Math.round(c * 1000) / 1000;
}

/** Standard deviation of the last year of daily returns; null with fewer than 60. */
export function yearSigma(bars: readonly Bar[]): number | null {
  const r = dailyReturns(bars).slice(-YEAR_SESSIONS).map((x) => x.r);
  if (r.length < 60) return null;
  const s = stdev(r);
  return s !== null && s > 0 ? s : null;
}

/** The latest sessions (newest first) whose return is at least NOTABLE_Z standard deviations, within the lookback. */
export function notableMoves(
  bars: readonly Bar[],
  options: { lookback?: number; limit?: number; z?: number } = {},
): Array<{ d: string; r: number; z: number }> {
  const sigma = yearSigma(bars);
  if (sigma === null) return [];
  const lookback = options.lookback ?? NOTABLE_LOOKBACK;
  const limit = options.limit ?? NOTABLE_LIMIT;
  const threshold = options.z ?? NOTABLE_Z;
  const recent = dailyReturns(bars).slice(-lookback);
  const out: Array<{ d: string; r: number; z: number }> = [];
  for (let i = recent.length - 1; i >= 0 && out.length < limit; i--) {
    const x = recent[i]!;
    const z = x.r / sigma;
    if (Math.abs(z) >= threshold) out.push({ d: x.d, r: x.r, z: Math.round(z * 100) / 100 });
  }
  return out;
}

export type PeerSeries = { ticker: string; bars: readonly Bar[] };

/** Same, opposite or flat for one peer's return against the stock's direction. */
export function peerSide(stockMove: number, peerMove: number, peerSigma: number): "same" | "opposite" | "flat" {
  const z = peerMove / peerSigma;
  if (Math.abs(z) < PEER_MOVE_Z || peerMove === 0) return "flat";
  return Math.sign(peerMove) === Math.sign(stockMove) ? "same" : "opposite";
}

export function verdictOf(same: number, counted: number): MoveVerdict {
  return counted > 0 && same * 2 >= counted ? "sector" : "shift";
}

/**
 * The notable-move table: each of the stock's latest large sessions, every
 * peer's return that session, and whether the move was shared. A session no
 * peer traded (or none has a year of returns for) is left out: there is
 * nothing to compare it with.
 */
export function shockVsShift(stock: readonly Bar[], peers: readonly PeerSeries[], options: { lookback?: number; limit?: number } = {}): NotableMoveRow[] {
  const moves = notableMoves(stock, options);
  if (moves.length === 0) return [];
  const peerData = peers.map((p) => ({
    ticker: p.ticker,
    sigma: yearSigma(p.bars),
    returns: new Map(dailyReturns(p.bars).map((x) => [x.d, x.r] as const)),
  }));
  const rows: NotableMoveRow[] = [];
  for (const m of moves) {
    const peerMoves: Record<string, number | null> = {};
    let same = 0;
    let opposite = 0;
    let flat = 0;
    for (const p of peerData) {
      const r = p.returns.get(m.d);
      peerMoves[p.ticker] = r === undefined ? null : Math.round(r * 1e6) / 1e6;
      if (r === undefined || p.sigma === null) continue;
      const side = peerSide(m.r, r, p.sigma);
      if (side === "same") same++;
      else if (side === "opposite") opposite++;
      else flat++;
    }
    const counted = same + opposite + flat;
    if (counted === 0) continue;
    rows.push({ date: m.d, move: Math.round(m.r * 1e6) / 1e6, z: m.z, peerMoves, same, opposite, flat, verdict: verdictOf(same, counted) });
  }
  return rows;
}
