/**
 * Fills `MarketData` for one run from pluggable sources, and the one-call
 * `backtest()` that validates, loads and runs under a deadline.
 */

import { runBacktest, type BacktestResult } from "../engine";
import {
  BENCHMARK,
  strategyTickers,
  validateRunConfig,
  validateStrategy,
  type RunConfig,
  type Strategy,
} from "../schema";
import { JsonCache, defaultCacheDir } from "./cache";
import { DeadlineError } from "./http";
import type { Bar, EarningsEvent, EarningsSource, MarketData, PriceSource, RippleSignal, RippleSource } from "./types";
import { YahooEarningsSource, YahooPriceSource } from "./yahoo";

/** Calendar days of history loaded before the start, so a 250-day average is ready on day one. */
export const WARMUP_CALENDAR_DAYS = 400;

export type Sources = {
  prices: PriceSource;
  earnings: EarningsSource | null;
  ripple: RippleSource | null;
};

let defaultSourcesMemo: { dir: string; sources: Sources } | null = null;

/** Yahoo prices and earnings with the default cache; no ripple source yet. */
export function defaultSources(cacheDir = defaultCacheDir()): Sources {
  if (defaultSourcesMemo?.dir === cacheDir) return defaultSourcesMemo.sources;
  const cache = new JsonCache(cacheDir);
  const sources = { prices: new YahooPriceSource(cache), earnings: new YahooEarningsSource(cache), ripple: null };
  defaultSourcesMemo = { dir: cacheDir, sources };
  return sources;
}

function minusDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** True when two consecutive releases inside the window are more than ~4 months apart. */
export function hasQuarterGap(events: readonly EarningsEvent[], start: string, end: string): boolean {
  const days = events.filter((e) => e.date >= start && e.date <= end).map((e) => Date.parse(`${e.date}T00:00:00Z`) / 86_400_000);
  for (let i = 1; i < days.length; i++) if (days[i]! - days[i - 1]! > 125) return true;
  return false;
}

const isAbort = (e: unknown) => e instanceof DeadlineError || (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError"));

export async function loadMarketData(
  strategy: Strategy,
  config: RunConfig,
  sources: Sources,
  signal?: AbortSignal,
): Promise<MarketData> {
  const warnings: string[] = [];
  const from = minusDays(config.start, WARMUP_CALENDAR_DAYS);
  const tickers = Array.from(new Set([...strategyTickers(strategy), BENCHMARK]));
  const conditions = [...strategy.entry.conditions, ...strategy.exit.conditions];
  const usesEarnings = conditions.some((c) => c.type === "earnings_surprise");
  const usesRipple = conditions.some((c) => c.type === "ripple_event");

  const bars: Record<string, Bar[]> = {};
  const earnings: Record<string, EarningsEvent[]> = {};
  let ripple: RippleSignal[] = [];
  let earningsFailures = 0;

  const priceJobs = tickers.map(async (t) => {
    try {
      bars[t] = await sources.prices.dailyBars(t, from, config.end, signal);
    } catch (e) {
      if (isAbort(e) || signal?.aborted) throw new DeadlineError();
      bars[t] = [];
      warnings.push(`${t}: prices could not be loaded (${e instanceof Error ? e.message : "error"}).`);
    }
  });
  const earningsJobs =
    usesEarnings && sources.earnings
      ? strategy.universe.map(async (t) => {
          try {
            earnings[t] = await sources.earnings!.earnings(t, from, config.end, signal);
          } catch (e) {
            if (isAbort(e) || signal?.aborted) throw new DeadlineError();
            earnings[t] = [];
            earningsFailures++;
          }
        })
      : [];
  const rippleJob =
    usesRipple && sources.ripple
      ? (async () => {
          try {
            ripple = await sources.ripple!.hits({ tickers: strategy.universe, from, to: config.end }, signal);
          } catch (e) {
            if (isAbort(e) || signal?.aborted) throw new DeadlineError();
            warnings.push("Ripple card history could not be loaded.");
          }
        })()
      : Promise.resolve();

  const settled = await Promise.allSettled([...priceJobs, ...earningsJobs, rippleJob]);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;

  if (usesEarnings && !sources.earnings) warnings.push("No earnings source is connected, so earnings conditions never fire.");
  if (earningsFailures) warnings.push(`Earnings history could not be loaded for ${earningsFailures} of ${strategy.universe.length} tickers.`);
  if (usesEarnings) {
    const none = strategy.universe.filter((t) => (earnings[t]?.length ?? 0) === 0 && (bars[t]?.length ?? 0) > 0);
    if (none.length && none.length < strategy.universe.length) warnings.push(`No earnings history for: ${none.join(", ")}.`);
    const gaps = strategy.universe.filter((t) => hasQuarterGap(earnings[t] ?? [], config.start, config.end));
    if (gaps.length) warnings.push(`Earnings history skips at least one quarter for: ${gaps.join(", ")}. Those releases cannot trigger trades.`);
  }

  return {
    bars,
    benchmark: bars[BENCHMARK] ?? [],
    earnings,
    ripple,
    sources: {
      prices: sources.prices.name,
      earnings: usesEarnings ? (sources.earnings?.name ?? null) : null,
      ripple: usesRipple ? (sources.ripple?.name ?? null) : null,
    },
    warnings: warnings.sort(),
  };
}

export type BacktestOutcome =
  | { ok: true; result: BacktestResult }
  | { ok: false; status: 400 | 502 | 504; errors: string[] };

export type BacktestOptions = {
  sources?: Sources;
  /** Whole run (loading included) must finish inside this; default 8 s for serverless hosts. */
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: Date;
};

/**
 * Validate, load and run. Never throws for bad input, slow sources or missing
 * data; the outcome says which (400 invalid input, 504 deadline, 502 no data).
 */
export async function backtest(
  input: { strategy: unknown; config?: Partial<RunConfig> },
  opts: BacktestOptions = {},
): Promise<BacktestOutcome> {
  const s = validateStrategy(input.strategy);
  const c = validateRunConfig(input.config, opts.now);
  if (!s.ok || !c.ok) return { ok: false, status: 400, errors: [...(s.ok ? [] : s.errors), ...(c.ok ? [] : c.errors)] };

  const signals = [AbortSignal.timeout(opts.timeoutMs ?? 8_000), ...(opts.signal ? [opts.signal] : [])];
  const signal = AbortSignal.any(signals);
  let data: MarketData;
  try {
    data = await loadMarketData(s.value, c.value, opts.sources ?? defaultSources(), signal);
  } catch (e) {
    if (isAbort(e) || signal.aborted) {
      return {
        ok: false,
        status: 504,
        errors: ["Loading prices took too long. Data loaded so far is cached, so trying again is usually faster."],
      };
    }
    return { ok: false, status: 502, errors: [e instanceof Error ? e.message : "Data source error"] };
  }
  if (data.benchmark.length === 0) return { ok: false, status: 502, errors: [`${BENCHMARK} prices are unavailable right now.`] };
  try {
    return { ok: true, result: runBacktest(s.value, c.value, data) };
  } catch (e) {
    return { ok: false, status: 502, errors: [e instanceof Error ? e.message : "Backtest failed"] };
  }
}
