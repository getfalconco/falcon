/**
 * Demo / presentation mode (Ctrl+P). While on, the dashboard shows a
 * randomly generated portfolio — a five- or six-figure balance, a random
 * set of holdings and a random growth curve — instead of the real Falcon
 * paper account. Nothing is persisted and nothing is synced: toggling it
 * off (Ctrl+P again) or reloading restores the real data untouched.
 */

import type { PaperAccount, PaperPosition } from "@/lib/paper-account";
import { useEffect, useState } from "react";

export type DemoSnapshot = {
  /** Seed behind every random choice — a new one each time demo turns on. */
  seed: number;
  account: PaperAccount;
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

  // 4–7 distinct tickers with random weights.
  const count = 4 + Math.floor(rand() * 4);
  const pool = [...POOL];
  const picks: Array<[string, number]> = [];
  while (picks.length < count && pool.length > 0) {
    picks.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
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

  return { seed, account: { cash, positions } };
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
