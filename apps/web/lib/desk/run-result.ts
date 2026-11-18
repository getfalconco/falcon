/**
 * The strategy-test result contract shared by the Desk route and the Desk UI.
 *
 * When the Desk tests a strategy, Claude writes a Python script in the
 * Anthropic code execution sandbox; the script writes RESULT_FILE (the shape
 * below) and copies it to $OUTPUT_DIR, the route downloads it with the Files
 * API, checks it with `validateRunResult` and streams it to the client, which
 * keeps a smaller copy with the session (`compactRunResult`).
 *
 * Units: returns, volatility, drawdowns, win rate are decimals (0.12 = 12%);
 * turnover is times per year; equity curves start at any positive value (the
 * UI rebases them). Pure; safe in the browser.
 */

import { cleanEventSpec, type EventSpecInfo } from "./event-spec";

export const RESULT_FILE = "falcon_result.json";

export type RunMetrics = {
  cagr: number | null;
  vol: number | null;
  sharpe: number | null;
  /** Worst fall from a previous high, negative (-0.25 = -25%). */
  max_dd: number | null;
  total_return: number | null;
  /** Closed round trips (a buy and the sell that closes it count as one); normalized from the trade list by validateRunResult. */
  trades: number | null;
  win_rate: number | null;
  /** Times the portfolio turns over per year. */
  turnover: number | null;
  /** Share of days with a position open (0..1), when the script reports it. */
  exposure?: number | null;
  benchmark: { cagr: number | null; sharpe: number | null; max_dd: number | null; total_return: number | null };
};

export type RunTrade = {
  date: string;
  ticker: string;
  side: "buy" | "sell";
  qty: number | null;
  weight: number | null;
  price: number | null;
  /** Round-trip return on the closing trade (decimal); null on opening trades. */
  pnl: number | null;
  /** Buys: the last day whose data the signal used (the audit checks the entry comes later). */
  signal_date?: string | null;
};

export type RunResult = {
  name: string;
  period: { start: string; end: string };
  universe: string;
  /**
   * What the strategy was compared with: a ticker ("SPY", "AGG") or a custom
   * portfolio ("Equal weight of the 23 funds"). "" when the result did not
   * name one (then it is SPY, Falcon's default: see `benchmarkName`).
   * `series.benchmark_equity` and `metrics.benchmark` are this benchmark.
   */
  benchmark?: string;
  /** Closed round trips over the whole test, counted on the full trade list before any cut. */
  closed_trades?: number | null;
  assumptions: { costs_bps: number | null; rebalance: string; signal_lag: string; notes: string[] };
  metrics: RunMetrics;
  series: { dates: string[]; equity: number[]; benchmark_equity: (number | null)[]; drawdown: number[] };
  trades: RunTrade[];
  /** Trades in the file before any cut (the stored copy keeps the first ones). */
  trade_count: number;
  warnings: string[];
  code: string;
  /** Set when the script tried several parameter combinations and reports the chosen one. */
  sweep?: RunSweep;
  /** Where the out-of-sample part starts (parameters chosen before it). */
  split?: { oos_start: string; method: "holdout" | "walk_forward" };
  /** An event test run by Falcon's helper from declared rules (lib/desk/event-spec.ts): the rules, counts and the server's check. */
  spec?: EventSpecInfo;
};

export type RunSweep = {
  /** Parameter combinations tried, the reported one included. */
  configs_tried: number;
  /** What was swept, e.g. "fast 20-100 step 10 x slow 100-300 step 25". */
  params: string;
  /** Where the winner was picked: the in-sample part only, or the whole period. */
  chosen_on: "in_sample" | "full_period" | null;
  /** Annualized Sharpe of every combination tried (on the part it was chosen on). */
  sharpes: number[];
};

/** Limits on what the route accepts and forwards. */
export const MAX_RESULT_BYTES = 8_000_000;
export const MAX_SERIES_POINTS = 6_000;
/** Trades kept from a result file (an event test since 2016 has about 9,000 rows: every buy and its sell). */
export const MAX_TRADES = 20_000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const text = (v: unknown, max = 300): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const day = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim().slice(0, 10) : "";
  return DATE.test(s) ? s : null;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Reads a result file. Lenient on types (numbers as strings, missing fields
 * become null) and strict on structure: dates, equal series lengths, a known
 * trade side. `problems` lists what was fixed or dropped; `ok` is false only
 * when nothing usable is left (no series and no metrics).
 */
export function validateRunResult(raw: unknown): { ok: true; result: RunResult; problems: string[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const r = obj(raw);
  if (!Object.keys(r).length) return { ok: false, problems: ["The result is not a JSON object."] };

  const m = obj(r.metrics);
  const b = obj(m.benchmark);
  const metrics: RunMetrics = {
    cagr: num(m.cagr),
    vol: num(m.vol),
    sharpe: num(m.sharpe),
    max_dd: num(m.max_dd),
    total_return: num(m.total_return),
    trades: num(m.trades),
    win_rate: num(m.win_rate),
    turnover: num(m.turnover),
    exposure: num(m.exposure),
    benchmark: { cagr: num(b.cagr), sharpe: num(b.sharpe), max_dd: num(b.max_dd), total_return: num(b.total_return) },
  };
  // A drawdown reported as a positive fall is flipped to the convention.
  if (metrics.max_dd !== null && metrics.max_dd > 0) metrics.max_dd = -metrics.max_dd;
  if (metrics.benchmark.max_dd !== null && metrics.benchmark.max_dd > 0) metrics.benchmark.max_dd = -metrics.benchmark.max_dd;

  const s = obj(r.series);
  const rawDates = list(s.dates);
  const rawEq = list(s.equity);
  const rawBench = list(s.benchmark_equity);
  const rawDd = list(s.drawdown);
  const dates: string[] = [];
  const equity: number[] = [];
  const bench: (number | null)[] = [];
  const dd: number[] = [];
  const n = Math.min(rawDates.length, rawEq.length, MAX_SERIES_POINTS);
  if (rawDates.length !== rawEq.length) problems.push("Dates and equity had different lengths; cut to the shorter.");
  if (rawDates.length > MAX_SERIES_POINTS) problems.push(`Series cut to the first ${MAX_SERIES_POINTS} points.`);
  let peak = -Infinity;
  let skipped = 0;
  for (let i = 0; i < n; i++) {
    const d = day(rawDates[i]);
    const e = num(rawEq[i]);
    if (!d || e === null || (dates.length && d <= dates[dates.length - 1]!)) {
      skipped++;
      continue;
    }
    dates.push(d);
    equity.push(e);
    bench.push(num(rawBench[i]));
    peak = Math.max(peak, e);
    const given = num(rawDd[i]);
    dd.push(given !== null ? (given > 0 ? -given : given) : peak > 0 ? e / peak - 1 : 0);
  }
  if (skipped) problems.push(`${skipped} series points with a bad date or value were dropped.`);

  const trades: RunTrade[] = [];
  const rawTrades = list(r.trades);
  for (const t of rawTrades.slice(0, MAX_TRADES)) {
    const x = obj(t);
    const d = day(x.date);
    const sideRaw = text(x.side, 10).toLowerCase();
    const side = sideRaw === "buy" || sideRaw === "long" || sideRaw === "entry" ? "buy" : sideRaw === "sell" || sideRaw === "exit" || sideRaw === "short" ? "sell" : null;
    const ticker = text(x.ticker, 12).toUpperCase();
    if (!d || !side || !ticker) continue;
    const signal = day(x.signal_date);
    trades.push({ date: d, ticker, side, qty: num(x.qty), weight: num(x.weight), price: num(x.price), pnl: num(x.pnl), ...(signal ? { signal_date: signal } : {}) });
  }
  if (rawTrades.length > MAX_TRADES) problems.push(`Trades cut to the first ${MAX_TRADES.toLocaleString("en-US")}.`);

  const p = obj(r.period);
  const a = obj(r.assumptions);
  // Closed round trips: the sells in the full list (before the cut). A stored copy keeps the count it was given.
  const sells = rawTrades.filter((t) => {
    const s = text(obj(t).side, 10).toLowerCase();
    return s === "sell" || s === "exit";
  }).length;
  const givenClosed = num(r.closed_trades);
  const closed = givenClosed !== null ? givenClosed : sells > 0 ? sells : rawTrades.length ? 0 : num(m.trades);
  const bo = obj(r.benchmark);
  const benchmark = (typeof r.benchmark === "string" ? text(r.benchmark, 80) : text(bo.name ?? bo.label ?? bo.ticker, 80)) || text(b.name ?? b.ticker, 80);
  const result: RunResult = {
    name: text(r.name, 120) || "Strategy test",
    period: { start: day(p.start) ?? dates[0] ?? "", end: day(p.end) ?? dates[dates.length - 1] ?? "" },
    universe: text(r.universe, 300),
    benchmark,
    closed_trades: closed,
    assumptions: {
      costs_bps: num(a.costs_bps),
      rebalance: text(a.rebalance, 200),
      signal_lag: text(a.signal_lag, 200),
      notes: list(a.notes)
        .map((x) => text(x, 300))
        .filter(Boolean)
        .slice(0, 12),
    },
    metrics,
    series: { dates, equity, benchmark_equity: bench, drawdown: dd },
    trades,
    trade_count: Math.max(rawTrades.length, num(r.trade_count) ?? 0),
    warnings: list(r.warnings)
      .map((x) => text(x, 400))
      .filter(Boolean)
      .slice(0, 20),
    code: typeof r.code === "string" ? r.code.slice(0, 60_000) : "",
  };
  const sw = obj(r.sweep);
  const tried = num(sw.configs_tried);
  if (tried !== null && tried >= 2) {
    const chosen = text(sw.chosen_on, 20).toLowerCase();
    result.sweep = {
      configs_tried: Math.min(1_000_000, Math.round(tried)),
      params: text(sw.params, 200),
      chosen_on: chosen === "in_sample" ? "in_sample" : chosen === "full_period" || chosen === "full" ? "full_period" : null,
      sharpes: list(sw.sharpes)
        .map(num)
        .filter((x): x is number => x !== null)
        .slice(0, 2_000),
    };
  }
  const sp = obj(r.split);
  const oosStart = day(sp.oos_start);
  if (oosStart) result.split = { oos_start: oosStart, method: text(sp.method, 20) === "walk_forward" ? "walk_forward" : "holdout" };
  const spec = cleanEventSpec(r.spec);
  if (spec) result.spec = spec;
  // One definition everywhere: closed round trips (a script may count entries and exits).
  metrics.trades = closed;
  const anyMetric = [metrics.cagr, metrics.total_return, metrics.sharpe, metrics.max_dd].some((v) => v !== null);
  if (!dates.length && !anyMetric) return { ok: false, problems: [...problems, "The result has no equity series and no metrics."] };
  return { ok: true, result, problems };
}

/** Every `step`-th point plus the last, at most `max` points (min and max drawdown kept). */
function pickIndexes(n: number, max: number, keep: number[] = []): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (max - 1);
  const set = new Set<number>();
  for (let k = 0; k < max; k++) set.add(Math.round(k * step));
  for (const i of keep) if (i >= 0 && i < n) set.add(i);
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * A smaller copy for session storage: at most `points` series points (the
 * deepest drawdown kept) and the first `trades` trades. `cut` says what went.
 */
export function compactRunResult(r: RunResult, points = 400, trades = 500): { result: RunResult; cut: { points?: number; trades?: number } } {
  const n = r.series.dates.length;
  let worst = -1;
  for (let i = 0; i < n; i++) if (worst < 0 || r.series.drawdown[i]! < r.series.drawdown[worst]!) worst = i;
  const idx = pickIndexes(n, points, [worst]);
  const cut: { points?: number; trades?: number } = {};
  if (idx.length < n) cut.points = n;
  if (r.trades.length > trades) cut.trades = r.trades.length;
  return {
    result: {
      ...r,
      series: {
        dates: idx.map((i) => r.series.dates[i]!),
        equity: idx.map((i) => r.series.equity[i]!),
        benchmark_equity: idx.map((i) => r.series.benchmark_equity[i] ?? null),
        drawdown: idx.map((i) => r.series.drawdown[i]!),
      },
      trades: r.trades.slice(0, trades),
    },
    cut,
  };
}

/** "+12.3%" style, n/a for null. */
export function fmtPct(v: number | null | undefined, digits = 1, sign = true): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const x = v * 100;
  const s = Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : x.toFixed(digits);
  return `${sign && v > 0 ? "+" : ""}${s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s}%`;
}

/** Falcon's default benchmark when a test names none. */
export const DEFAULT_BENCHMARK = "SPY";

/** The benchmark's name for every label: the result's own, else SPY. */
export function benchmarkName(r: { benchmark?: string } | null | undefined): string {
  return r?.benchmark?.trim() || DEFAULT_BENCHMARK;
}

/** A ticker-like benchmark ("SPY", "BRK.B", "^GSPC"), as opposed to a custom portfolio's name. */
export const isTickerName = (name: string) => /^\^?[A-Z][A-Z0-9.\-]{0,9}$/.test(name);

/** "SPY held throughout" for a ticker; a custom benchmark's own name otherwise. */
export function benchmarkLong(name: string): string {
  return isTickerName(name) ? `${name} held throughout` : name.charAt(0).toUpperCase() + name.slice(1);
}

/** What "trades" means everywhere on the Desk (tooltips, the model's numbers). */
export const TRADES_DEFINITION = "Closed round trips: a buy and the sell that closes it count as one trade. Positions still open at the end are not counted.";

/** One line for the model's history: what the last test found. */
export function resultSummaryLine(r: RunResult): string {
  const m = r.metrics;
  const f = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));
  const b = benchmarkName(r);
  return `${r.name}, ${r.period.start} to ${r.period.end}: CAGR ${fmtPct(m.cagr)}, Sharpe ${f(m.sharpe)}, max drawdown ${fmtPct(m.max_dd)}, closed trades ${m.trades ?? "n/a"}; benchmark ${b}: CAGR ${fmtPct(m.benchmark.cagr)}, Sharpe ${f(m.benchmark.sharpe)}, max drawdown ${fmtPct(m.benchmark.max_dd)}.`;
}
