import type { Bar, EarningsEvent, MarketData } from "../src/index";
import type { SpecData } from "../src/prepare";
import { rng } from "../src/util";

/** NYSE-like weekdays (no holidays) from start, n of them. */
export function sessions(start: string, n: number): string[] {
  const out: string[] = [];
  let t = Date.parse(`${start}T00:00:00Z`);
  while (out.length < n) {
    const d = new Date(t);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

/** Random-walk bars with intraday range, volume and a raw close (no splits). */
export function walkBars(dates: string[], seed: number, opts: { start?: number; drift?: number; vol?: number; volume?: number; from?: number } = {}): Bar[] {
  const r = rng(seed);
  let px = opts.start ?? 100;
  const out: Bar[] = [];
  dates.forEach((date, i) => {
    if (i < (opts.from ?? 0)) return;
    const open = px * (1 + (r() - 0.5) * 0.01);
    const close = open * (1 + (opts.drift ?? 0.0003) + (r() - 0.5) * 2 * (opts.vol ?? 0.015));
    const high = Math.max(open, close) * (1 + r() * 0.008);
    const low = Math.min(open, close) * (1 - r() * 0.008);
    const volume = Math.round((opts.volume ?? 5_000_000) * (0.5 + r()));
    out.push({ date, open, high, low, close, volume, rawClose: close, dollarVolume: close * volume });
    px = close;
  });
  return out;
}

/** Quarterly earnings with random surprises and release times. */
export function quarterly(dates: string[], seed: number, offset = 30): EarningsEvent[] {
  const r = rng(seed);
  const times: EarningsEvent["time"][] = ["before_open", "after_close", "during", "unknown"];
  const out: EarningsEvent[] = [];
  for (let i = offset; i < dates.length; i += 63) {
    const s = (r() - 0.35) * 30;
    out.push({ date: dates[i]!, time: times[Math.floor(r() * 4)]!, epsActual: 1 + s / 100, epsEstimate: 1, surprisePct: Math.round(s * 100) / 100 });
  }
  return out;
}

export function specData(bars: Record<string, Bar[]>, earnings: Record<string, EarningsEvent[]> = {}, rates: { date: string; rate: number }[] = []): SpecData {
  return {
    bars,
    earnings,
    ripple: [],
    rates,
    sources: { prices: "test", earnings: null, ripple: null, rates: null },
    flags: { ratesFallback: rates.length === 0, rippleConnected: false, betaSource: false },
    warnings: [],
  };
}

export function toMarketData(d: SpecData): MarketData {
  return {
    bars: d.bars,
    benchmark: d.bars.SPY!,
    earnings: d.earnings,
    ripple: [],
    sources: { prices: "test", earnings: null, ripple: null },
    warnings: [],
  };
}
