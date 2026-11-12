import type { Bar, MarketData, Strategy } from "../src/index";

/** Weekdays from `start` (YYYY-MM-DD), `n` of them. */
export function weekdays(start: string, n: number): string[] {
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

/** Bars from closes; open defaults to the previous close, high/low bracket open and close. */
export function makeBars(dates: string[], closes: number[], overrides: Record<number, Partial<Bar>> = {}): Bar[] {
  return dates.map((date, i) => {
    const close = closes[i]!;
    const open = overrides[i]?.open ?? (i > 0 ? closes[i - 1]! : close);
    const bar: Bar = { date, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1000 };
    return { ...bar, ...overrides[i] };
  });
}

export function market(bars: Record<string, Bar[]>, extra: Partial<MarketData> = {}): MarketData {
  return {
    bars,
    benchmark: bars.SPY ?? Object.values(bars)[0]!,
    earnings: {},
    ripple: [],
    sources: { prices: "test", earnings: null, ripple: null },
    warnings: [],
    ...extra,
  };
}

export function strategy(over: Partial<Strategy> = {}): Strategy {
  return {
    version: 1,
    name: "test",
    universe: ["AAA"],
    entry: { mode: "all", conditions: [{ type: "n_day_return", ticker: null, days: 1, op: "above", pct: 5 }] },
    exit: { conditions: [], stopLossPct: null, takeProfitPct: null, maxHoldingDays: null },
    sizing: { maxPositions: 1, positionPct: null },
    rebalance: "none",
    ...over,
  };
}

/** Deterministic pseudo-random walk. */
export function randomWalk(n: number, seed = 7, start = 100): number[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1]! * (1 + (rnd() - 0.5) * 0.04));
  return out;
}

export const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
