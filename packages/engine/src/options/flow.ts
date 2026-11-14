/**
 * Stock order-flow features per ticker per day, from trades that carry the
 * aggressor side (Databento `trades`: B = buyer-initiated, A =
 * seller-initiated, N = no side), and a "quiet accumulation" score over a
 * rolling window.
 *
 * Session: "regular" keeps 09:30 to 16:00 New York plus 5 s, so the
 * closing cross is in. Side-less prints in the first 2 s after the open or
 * at/after the close are counted as `auctionVolume`.
 *
 * Unknown side (N). Auction prints (open/close crosses), trades against
 * hidden orders and off-exchange prints carry no side. With
 * `classify: "given"` (default) they are counted in `volume` and
 * `unknownVolume` but left out of every signed number; `signedShare` says
 * how much of the volume the signed numbers cover. With `classify: "tick"`
 * unknown-side trades other than auction prints are signed by the tick
 * rule (up from the last different price = buy, down = sell, no earlier
 * change = unknown); use it
 * for consolidated feeds with no side at all (e.g. XNAS.BASIC trades), and
 * report it as a different, noisier measure. On XNAS.ITCH (Nasdaq only)
 * about a quarter of Nasdaq volume (under a tenth of consolidated volume)
 * has a side, so imbalances are a sample of displayed liquidity taking.
 *
 * Pure: no fs, no network, no clock.
 */

import { nyOffsetMs } from "../edgar-time.ts";
import { sessionCloseMs, sessionOpenMs } from "../study/abnormal.ts";
import type { Trade } from "./client.ts";

export type FlowDay = {
  date: string;
  trades: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  unknownVolume: number;
  buyDollar: number;
  sellDollar: number;
  unknownDollar: number;
  /** Side-less prints in the opening second or at/after the close (the crosses); part of unknownVolume, never tick-signed. */
  auctionVolume: number;
  /** buyDollar - sellDollar. */
  netSignedDollar: number;
  /** (buy - sell) / (buy + sell) in shares; null with no signed volume. */
  imbalance: number | null;
  /** (buyDollar - sellDollar) / (buyDollar + sellDollar). */
  dollarImbalance: number | null;
  /** (buy + sell) / volume: the share of volume the signed numbers cover. */
  signedShare: number;
  vwap: number | null;
};

export type FlowOptions = {
  /** "regular" (default): 09:30 to 16:00 New York plus 5 s for the closing cross; "all": every trade. */
  session: "regular" | "all";
  classify: "given" | "tick";
};

const hourOffset = new Map<number, number>();
/** New York calendar date of an instant (offset cached per UTC hour). */
export function nyDate(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  let off = hourOffset.get(h);
  if (off === undefined) {
    off = nyOffsetMs(h * 3_600_000);
    hourOffset.set(h, off);
  }
  return new Date(ms + off).toISOString().slice(0, 10);
}

/** Daily flow from trades (any order). Days sorted oldest first. Pure. */
export function aggregateFlow(trades: readonly Trade[], options: Partial<FlowOptions> = {}): FlowDay[] {
  const opts: FlowOptions = { session: "regular", classify: "given", ...options };
  const sorted = [...trades].sort((a, b) => a.tsMs - b.tsMs);
  const days = new Map<string, FlowDay & { pv: number }>();
  const bounds = new Map<string, [number, number]>();
  let lastPrice: number | null = null;
  let lastDir: "B" | "A" | "N" = "N";
  for (const t of sorted) {
    if (!(t.size > 0) || !(t.price > 0)) continue;
    const date = nyDate(t.tsMs);
    let b = bounds.get(date);
    if (!b) {
      b = [sessionOpenMs(date), sessionCloseMs(date)];
      bounds.set(date, b);
    }
    if (opts.session === "regular" && (t.tsMs < b[0] || t.tsMs >= b[1] + 5_000)) continue;
    const auction = t.side === "N" && ((t.tsMs >= b[0] && t.tsMs < b[0] + 2_000) || t.tsMs >= b[1]);
    let side = t.side;
    if (!auction) {
      // Tick rule state runs over the continuous-session trades kept, across days.
      if (lastPrice !== null && t.price !== lastPrice) lastDir = t.price > lastPrice ? "B" : "A";
      lastPrice = t.price;
      if (side === "N" && opts.classify === "tick") side = lastDir;
    }
    let d = days.get(date);
    if (!d) {
      d = {
        date,
        trades: 0,
        volume: 0,
        buyVolume: 0,
        sellVolume: 0,
        unknownVolume: 0,
        buyDollar: 0,
        sellDollar: 0,
        unknownDollar: 0,
        auctionVolume: 0,
        netSignedDollar: 0,
        imbalance: null,
        dollarImbalance: null,
        signedShare: 0,
        vwap: null,
        pv: 0,
      };
      days.set(date, d);
    }
    const dollars = t.price * t.size;
    d.trades++;
    d.volume += t.size;
    d.pv += dollars;
    if (side === "B") {
      d.buyVolume += t.size;
      d.buyDollar += dollars;
    } else if (side === "A") {
      d.sellVolume += t.size;
      d.sellDollar += dollars;
    } else {
      d.unknownVolume += t.size;
      d.unknownDollar += dollars;
      if (auction) d.auctionVolume += t.size;
    }
  }
  const out: FlowDay[] = [];
  for (const d of [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const signed = d.buyVolume + d.sellVolume;
    const signedDollar = d.buyDollar + d.sellDollar;
    const { pv, ...rest } = d;
    out.push({
      ...rest,
      netSignedDollar: d.buyDollar - d.sellDollar,
      imbalance: signed > 0 ? (d.buyVolume - d.sellVolume) / signed : null,
      dollarImbalance: signedDollar > 0 ? (d.buyDollar - d.sellDollar) / signedDollar : null,
      signedShare: d.volume > 0 ? signed / d.volume : 0,
      vwap: d.volume > 0 ? pv / d.volume : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quiet accumulation

export type QuietOptions = {
  /** Window length in sessions (default 5; the plan says 3 to 5). */
  window: number;
  /** Sessions of close-to-close log returns for the stock's own volatility, ending the session before the window (default 60, at least 20 used). */
  volLookback: number;
  /** |window return| / (sigma sqrt(window)) at or below this is "quiet" (default 0.5). */
  quietZ: number;
  /** z at which the score reaches 0 (default 1). */
  zCap: number;
  /** Days with signedShare below this do not count toward the window (default 0.02). */
  minSignedShare: number;
};

export const DEFAULT_QUIET: QuietOptions = { window: 5, volLookback: 60, quietZ: 0.5, zCap: 1, minSignedShare: 0.02 };

export type QuietRow = {
  date: string;
  windowDays: number;
  netSignedDollar: number;
  /** Window dollar imbalance: sum(buy$ - sell$) / sum(buy$ + sell$). */
  imbalance: number | null;
  /** Sessions in the window with positive dollar imbalance. */
  positiveDays: number;
  /** Close at the window end / close the session before the window - 1. */
  ret: number | null;
  /** Daily log-return sd over the lookback. */
  sigma: number | null;
  /** |ln(1 + ret)| / (sigma sqrt(window)). */
  zMove: number | null;
  quiet: boolean;
  /**
   * imbalance x max(0, 1 - zMove / zCap): positive = net buying while the
   * price stayed flat against its own volatility; negative = quiet
   * distribution; 0 when the price moved by zCap sd or more. Null without data.
   */
  score: number | null;
};

/**
 * Quiet accumulation for each flow day that ends a full window. `closes`
 * are daily closes (split adjusted, any extra days welcome), oldest first or
 * not. Window days are consecutive entries of `flow`. Pure.
 */
export function quietAccumulation(flow: readonly FlowDay[], closes: ReadonlyArray<{ date: string; close: number }>, options: Partial<QuietOptions> = {}): QuietRow[] {
  const o: QuietOptions = { ...DEFAULT_QUIET, ...options };
  const cs = [...closes].filter((c) => c.close > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  const idx = new Map(cs.map((c, i) => [c.date, i]));
  const days = [...flow].sort((a, b) => (a.date < b.date ? -1 : 1));
  const out: QuietRow[] = [];
  for (let end = o.window - 1; end < days.length; end++) {
    const win = days.slice(end - o.window + 1, end + 1).filter((d) => d.signedShare >= o.minSignedShare);
    const last = days[end]!;
    const first = days[end - o.window + 1]!;
    let buy = 0;
    let sell = 0;
    let positive = 0;
    for (const d of win) {
      buy += d.buyDollar;
      sell += d.sellDollar;
      if ((d.dollarImbalance ?? 0) > 0) positive++;
    }
    const imbalance = buy + sell > 0 ? (buy - sell) / (buy + sell) : null;
    const iEnd = idx.get(last.date);
    const iFirst = idx.get(first.date);
    let ret: number | null = null;
    let sigma: number | null = null;
    if (iEnd !== undefined && iFirst !== undefined && iFirst >= 1) {
      const base = cs[iFirst - 1]!.close;
      ret = cs[iEnd]!.close / base - 1;
      const lr: number[] = [];
      for (let i = Math.max(1, iFirst - o.volLookback); i < iFirst; i++) lr.push(Math.log(cs[i]!.close / cs[i - 1]!.close));
      if (lr.length >= 20) {
        const m = lr.reduce((a, b) => a + b, 0) / lr.length;
        sigma = Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / (lr.length - 1));
      }
    }
    const zMove = ret !== null && sigma && sigma > 0 ? Math.abs(Math.log(1 + ret)) / (sigma * Math.sqrt(o.window)) : null;
    const score = imbalance !== null && zMove !== null ? imbalance * Math.max(0, 1 - zMove / o.zCap) : null;
    out.push({
      date: last.date,
      windowDays: win.length,
      netSignedDollar: buy - sell,
      imbalance,
      positiveDays: positive,
      ret,
      sigma,
      zMove,
      quiet: zMove !== null && zMove <= o.quietZ,
      score,
    });
  }
  return out;
}
