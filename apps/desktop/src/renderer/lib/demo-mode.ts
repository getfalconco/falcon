/**
 * Demo / presentation mode (Ctrl+P). While on, the dashboard shows a
 * randomly generated portfolio — a five- or six-figure balance, a random
 * set of holdings and a random growth curve — instead of the real Falcon
 * paper account. Nothing is persisted and nothing is synced: toggling it
 * off (Ctrl+P again) or reloading restores the real data untouched.
 */

import type { PaperAccount, PaperPosition } from "@/lib/paper-account";
import { useEffect, useState } from "react";

/** One line of the demo book's cash: what is held, and what it is worth. */
export type DemoCurrency = {
  /** ISO code — "USD", "EUR". The name, glyph and flag are looked up from it. */
  code: string;
  /** How much of the currency itself is held. */
  amount: number;
  /** That holding in dollars — these sum to `account.cash`. */
  usd: number;
};

export type DemoSnapshot = {
  /** Seed behind every random choice — a new one each time demo turns on. */
  seed: number;
  account: PaperAccount;
  /**
   * The cash split across currencies, dollars first. The account itself only
   * ever carries one number, so this rides alongside it: the Positions card
   * lists these rows, everything that values the book keeps reading
   * `account.cash`, and the two agree by construction.
   */
  currencies: DemoCurrency[];
};

const DEMO_EVENT = "falcon:demo-mode-changed";
/** Same event the paper-account store fires, so every account subscriber re-reads. */
const ACCOUNT_EVENT = "falcon:paper-account-changed";

let snapshot: DemoSnapshot | null = null;

/** Candidate holdings with rough reference prices (so share counts look real). */
const POOL: Array<[symbol: string, refPrice: number]> = [
  ["NVDA", 215],
  ["AAPL", 230],
  ["MSFT", 430],
  ["AMZN", 210],
  ["META", 620],
  ["GOOGL", 190],
  ["TSLA", 330],
  ["AVGO", 290],
  ["LLY", 780],
  ["COST", 950],
  ["PLTR", 150],
  ["AMD", 165],
  ["JPM", 280],
  ["XOM", 115],
  ["NFLX", 1200],
  ["MSTR", 380],
];

/**
 * Funds, kept apart from the companies so a generated book always holds some
 * of each — drawn from the same list the Positions card files under ETFs, or
 * they would come out looking like stocks.
 */
const ETF_POOL: Array<[symbol: string, refPrice: number]> = [
  ["SPY", 640],
  ["VOO", 590],
  ["QQQ", 560],
  ["VTI", 315],
  ["SCHD", 27],
  ["IWM", 240],
  ["SMH", 285],
  ["XLK", 260],
  ["ARKK", 75],
  ["GLD", 320],
  ["TLT", 90],
  ["VXUS", 68],
  ["IBIT", 62],
  ["JEPI", 58],
];

/**
 * Currencies the demo book can hold beside dollars, with a rough rate in
 * dollars. Fixed on purpose: demo mode is a presentation, and a live FX call
 * would be one more thing to fail on stage. The amounts are invented either
 * way — only their relative size has to look plausible. Codes come from
 * `lib/currencies`, which owns the name, the glyph and the flag.
 */
const FX_POOL: Array<[code: string, usdPerUnit: number]> = [
  ["EUR", 1.08],
  ["GBP", 1.27],
  ["TRY", 0.024],
  ["JPY", 0.0064],
  ["CHF", 1.13],
];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(seed: number): DemoSnapshot {
  const rand = mulberry32(seed);
  // Always comfortably above $10K: $10K–$250K, skewed toward the low end.
  const target = Math.round(10_000 + Math.pow(rand(), 1.6) * 240_000);
  const cashShare = 0.05 + rand() * 0.2;
  const cash = Math.round(target * cashShare * 100) / 100;
  const invested = target - cash;

  // A book of both kinds: 4–6 companies and 2–3 funds, drawn separately so
  // neither group can come out empty on a bad roll.
  const draw = (from: Array<[string, number]>, n: number): Array<[string, number]> => {
    const pool = [...from];
    const out: Array<[string, number]> = [];
    while (out.length < n && pool.length > 0) {
      out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
    return out;
  };
  const picks = [
    ...draw(POOL, 4 + Math.floor(rand() * 3)),
    ...draw(ETF_POOL, 2 + Math.floor(rand() * 2)),
  ];
  const weights = picks.map(() => 0.4 + rand());
  const totalW = weights.reduce((s, w) => s + w, 0);

  const positions: Record<string, PaperPosition> = {};
  picks.forEach(([symbol, refPrice], i) => {
    const value = invested * (weights[i] / totalW);
    // Cost basis sits below today's value most of the time (−12%…+45% P&L),
    // so the book reads like a portfolio that has mostly been winning.
    const pnl = -0.12 + rand() * 0.57;
    const costUsd = Math.round((value / (1 + pnl)) * 100) / 100;
    const shares = Math.round((value / refPrice) * 10_000) / 10_000;
    positions[symbol] = { symbol, shares, costUsd };
  });

  // The cash, split. Dollars keep the bulk of it; one to three other
  // currencies share what is left. Rounded to the currency's own scale — a
  // yen balance with two decimals reads as fake.
  const fx = draw(FX_POOL, 1 + Math.floor(rand() * 3));
  const fxShare = 0.15 + rand() * 0.3;
  const fxWeights = fx.map(() => 0.4 + rand());
  const fxTotalW = fxWeights.reduce((s, w) => s + w, 0);
  const currencies: DemoCurrency[] = [];
  let fxUsdUsed = 0;
  fx.forEach(([code, usdPerUnit], i) => {
    const usd = Math.round(cash * fxShare * (fxWeights[i] / fxTotalW) * 100) / 100;
    const raw = usd / usdPerUnit;
    // A yen balance carrying two decimals reads as fake, so the low-value
    // currencies round to whole units.
    const amount = usdPerUnit < 0.05 ? Math.round(raw) : Math.round(raw * 100) / 100;
    fxUsdUsed += usd;
    currencies.push({ code, amount, usd });
  });
  // Dollars take the remainder, so the rows still add up to `cash` exactly.
  const usdLeft = Math.round((cash - fxUsdUsed) * 100) / 100;
  currencies.unshift({ code: "USD", amount: usdLeft, usd: usdLeft });

  return { seed, account: { cash, positions }, currencies };
}

export function isDemoMode(): boolean {
  return snapshot != null;
}

export function getDemoSnapshot(): DemoSnapshot | null {
  return snapshot;
}

/** Turns demo on with fresh random data, or off — and tells every listener. */
export function toggleDemoMode(): boolean {
  snapshot = snapshot ? null : generate((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
  window.dispatchEvent(new CustomEvent(DEMO_EVENT));
  window.dispatchEvent(new CustomEvent(ACCOUNT_EVENT));
  return snapshot != null;
}

export function subscribeDemoMode(listener: () => void): () => void {
  window.addEventListener(DEMO_EVENT, listener);
  return () => window.removeEventListener(DEMO_EVENT, listener);
}

type SeriesPoint = { t: number; value: number };

/**
 * Random-walk-with-drift value curve over `days`, scaled so it ends exactly
 * at `endValue` (the live demo balance) — the headline and the line agree.
 */
export function demoValueSeries(seed: number, days: number, endValue: number): SeriesPoint[] {
  const rand = mulberry32(seed + days * 7919);
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;
  const n = 140;
  const raw: number[] = [];
  let value = 100;
  let drift = 0.0012;
  for (let i = 0; i < n; i++) {
    if (rand() < 0.04) drift = (rand() - 0.4) * 0.008;
    value *= 1 + drift + (rand() - 0.5) * 0.022;
    raw.push(value);
  }
  const last = raw[raw.length - 1] || 1;
  return raw.map((v, i) => ({
    t: start + ((now - start) * i) / (n - 1),
    value: endValue * (v / last),
  }));
}

/** React view of the demo state — re-renders on Ctrl+P. */
export function useDemoMode(): DemoSnapshot | null {
  const [state, setState] = useState<DemoSnapshot | null>(getDemoSnapshot);
  useEffect(() => subscribeDemoMode(() => setState(getDemoSnapshot())), []);
  return state;
}
