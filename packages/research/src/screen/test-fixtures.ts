/**
 * Synthetic series for the Screen goldens — deterministic (seeded LCG), built
 * on the real trading calendar so session arithmetic matches production.
 */

import { previousTradingDay } from "../tracker/calendar.js";
import type { DailyBar } from "../tracker/types.js";
import { DEFAULT_SCREEN_CONFIG, mergeScreenConfig, type ScreenConfig } from "./config.js";
import type { ScreenInsiderClusterInput, ScreenNewsBurstInput, ScreenTickerInput } from "./types.js";

export const SESSION = "2026-08-21"; // a Friday

export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** ≈ N(0,1) from 12 uniforms. */
export function gauss(rand: () => number): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += rand();
  return sum - 6;
}

/** `n` trading days ending at `end` (inclusive), oldest first. */
export function tradingDays(n: number, end = SESSION): string[] {
  const out: string[] = [end];
  while (out.length < n) out.unshift(previousTradingDay(out[0]));
  return out;
}

export type BarSpec = {
  days: string[];
  returns: number[]; // returns.length === days.length − 1
  startPrice?: number;
  volumes?: number[];
  /** Half-width of the high–low band around the close, as a fraction (default 1%). */
  band?: number | number[];
};

export function barsFrom(spec: BarSpec): DailyBar[] {
  const bars: DailyBar[] = [];
  let price = spec.startPrice ?? 100;
  for (let i = 0; i < spec.days.length; i++) {
    if (i > 0) price = price * (1 + spec.returns[i - 1]);
    const band = Array.isArray(spec.band) ? spec.band[i] : (spec.band ?? 0.01);
    const v = spec.volumes?.[i] ?? 1_000_000;
    bars.push({ d: spec.days[i], o: price * (1 - band / 2), h: price * (1 + band), l: price * (1 - band), c: price, v });
  }
  return bars;
}

export type SyntheticOptions = {
  n?: number;
  seed?: number;
  beta?: number;
  benchStd?: number;
  noiseStd?: number;
  end?: string;
};

/** Benchmark + a beta-linked ticker with idiosyncratic noise. */
export function synthetic(options: SyntheticOptions = {}): { days: string[]; benchReturns: number[]; tickerReturns: number[]; bench: DailyBar[]; ticker: DailyBar[] } {
  const n = options.n ?? 300;
  const rand = seeded(options.seed ?? 7);
  const beta = options.beta ?? 1.2;
  const benchStd = options.benchStd ?? 0.01;
  const noiseStd = options.noiseStd ?? 0.008;
  const days = tradingDays(n, options.end);
  const benchReturns: number[] = [];
  const tickerReturns: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const b = gauss(rand) * benchStd;
    benchReturns.push(b);
    tickerReturns.push(beta * b + gauss(rand) * noiseStd);
  }
  return {
    days,
    benchReturns,
    tickerReturns,
    bench: barsFrom({ days, returns: benchReturns, startPrice: 500, volumes: days.map(() => 50_000_000) }),
    ticker: barsFrom({ days, returns: tickerReturns }),
  };
}

export function cfg(overrides?: Parameters<typeof mergeScreenConfig>[0]): ScreenConfig {
  return overrides ? mergeScreenConfig(overrides) : mergeScreenConfig(null);
}

export const R2_FLOOR = 0.15;

export function noBurst(): ScreenNewsBurstInput {
  return { active: false, last_fired_at: null, fired_days: [] };
}

export function noCluster(): ScreenInsiderClusterInput {
  return { active: false, direction: null, insider_count: null, window_business_days: null, total_notional: null, last_fired_at: null };
}

export function cluster(direction: "buy" | "sell", extra: Partial<ScreenInsiderClusterInput> = {}): ScreenInsiderClusterInput {
  return { active: true, direction, insider_count: 3, window_business_days: 10, total_notional: 1_250_000, last_fired_at: "2026-08-20T14:00:00.000Z", ...extra };
}

export function tickerInput(ticker: string, bars: DailyBar[], extra: Partial<ScreenTickerInput> = {}): ScreenTickerInput {
  return { ticker, bars, news_burst: noBurst(), insider_cluster: noCluster(), ...extra };
}

export { DEFAULT_SCREEN_CONFIG };
