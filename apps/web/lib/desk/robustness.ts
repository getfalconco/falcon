/**
 * Honest statistics for a Desk strategy test: the in-sample / out-of-sample
 * split, the whole-period stats measured the same way, the correction for
 * trying many versions (a parameter sweep) and the headline the panel and the
 * model both quote. Pure and browser-safe: the audit (lib/desk/audit.ts)
 * computes them on the full result on the server, and the results panel falls
 * back to them when the audit is missing and the curve was not cut.
 *
 * Correction: the deflated Sharpe ratio (Bailey & Lopez de Prado, 2014),
 * measured on the ACTIVE daily returns (strategy minus the benchmark), so it
 * reads "the chance the strategy truly beats the benchmark", not "the chance
 * it made money" (buy-and-hold makes money too). The best of N versions looks
 * good by luck alone; luck's expected best Sharpe is
 * sqrt(V) * ((1 - g) * Z(1 - 1/N) + g * Z(1 - 1/(N e))) (g = Euler's
 * constant, V = the variance of Sharpe across the versions tried, or the
 * estimate's sampling variance when unknown). The deflated Sharpe is the
 * chance the true active Sharpe beats that bar, given the sample's length,
 * skew and fat tails. "Luck-adjusted Sharpe" below is the Sharpe minus that bar.
 *
 * Out-of-sample drop: graded against the sampling error of a Sharpe estimate
 * (Lo 2002: SE of the per-day Sharpe = sqrt((1 + SR^2 / 2) / T)), so a small
 * drop over a short held-out part is not called a collapse.
 */

import { deflatedSharpe, normInv } from "@falcon/backtest";
import { benchmarkName, type RunResult, type RunTrade } from "./run-result";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function sd(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
const EULER = 0.5772156649;

/* ------------------------------------------------------------------ multiple testing */

export type MultipleTesting = {
  /** Versions tried in all: this test's sweep plus earlier tests in the conversation. */
  trials: number;
  /** Parameter combinations this test's script tried (1 = no sweep). */
  configs: number;
  /** What was swept, e.g. "fast 20-100 x slow 100-300". */
  params: string;
  /** Where the winner was chosen: the in-sample part only, or the whole period. */
  chosenOn: "in_sample" | "full_period" | null;
  /** Annualized Sharpe of the ACTIVE daily returns (strategy minus benchmark; an information ratio, no risk-free rate). */
  sharpe: number | null;
  /** Annualized active Sharpe the best of `trials` versions would reach by luck alone. */
  luckSharpe: number | null;
  /** sharpe - luckSharpe. */
  adjustedSharpe: number | null;
  /** Deflated Sharpe ratio on the active returns, 0..1: the chance the true edge over the benchmark is above luck's bar. */
  dsr: number | null;
  /** What the returns were measured against ("SPY", "AGG", "Equal weight of the 23 funds"). */
  benchmark?: string;
};

/** One line on the method, for the panel and the audit. */
export function dsrMethod(benchmark: string): string {
  return `Deflated Sharpe ratio (Bailey & López de Prado) on the daily return over ${benchmark}: the chance the strategy's true edge over ${benchmark} is above zero, after allowing for picking the best of the versions tried. 95% or more counts as clear of luck; it is one input to the evidence label, not a verdict on its own.`;
}

/** "Chance it beats SPY after 90 tries: 62%" (the plain wording of the deflated Sharpe). */
export function dsrPlain(m: Pick<MultipleTesting, "dsr" | "trials" | "benchmark">): string {
  const pct = m.dsr === null ? "n/a" : `${Math.round(m.dsr * 100)}%`;
  const tries = m.trials > 1 ? ` after ${m.trials.toLocaleString("en-US")} tries` : "";
  return `Chance it truly beats ${m.benchmark || "SPY"}${tries}: ${pct}`;
}

/** Daily returns of an equity curve (only where both days are positive numbers). */
export function dailyReturns(equity: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const a = equity[i - 1]!;
    const b = equity[i]!;
    if (a > 0 && isNum(b)) out.push(b / a - 1);
  }
  return out;
}

/** Annualized Sharpe of daily returns (x sqrt 252), null under 20 days or no spread. */
export function annualSharpe(daily: readonly number[]): number | null {
  if (daily.length < 20) return null;
  const s = sd(daily);
  return s > 0 ? (mean(daily) / s) * Math.sqrt(252) : null;
}

/**
 * Luck's expected best annualized Sharpe among `trials` independent tries
 * whose (per-day) Sharpe has variance `perDayVar`. 0 for one try.
 */
export function expectedMaxSharpe(trials: number, perDayVar: number): number {
  const n = Math.max(1, Math.round(trials));
  if (n === 1 || !(perDayVar > 0)) return 0;
  return Math.sqrt(perDayVar) * ((1 - EULER) * normInv(1 - 1 / n) + EULER * normInv(1 - 1 / (n * Math.E))) * Math.sqrt(252);
}

/**
 * The correction for a test's daily returns. `sweepSharpes`: the annualized
 * Sharpe of every version the sweep tried (gives the spread across versions;
 * else the estimate's own sampling variance is used, as in deflatedSharpe).
 */
export function multipleTesting(daily: readonly number[], opts: { trials: number; configs?: number; params?: string; chosenOn?: MultipleTesting["chosenOn"]; sweepSharpes?: readonly number[]; benchmark?: string }): MultipleTesting {
  const trials = Math.max(1, Math.round(opts.trials));
  const sharpe = annualSharpe(daily);
  const T = daily.length;
  const sw = (opts.sweepSharpes ?? []).filter(isNum);
  const swVar = sw.length >= 3 ? sd(sw) ** 2 / 252 : NaN;
  const perDay = sharpe === null ? NaN : sharpe / Math.sqrt(252);
  const v = Number.isFinite(swVar) && swVar > 0 ? swVar : T > 0 && Number.isFinite(perDay) ? (1 + (perDay * perDay) / 2) / T : NaN;
  const luck = Number.isFinite(v) ? expectedMaxSharpe(trials, v) : null;
  const dsr = T >= 30 ? deflatedSharpe(daily, trials, Number.isFinite(swVar) && swVar > 0 ? swVar : undefined) : NaN;
  return {
    trials,
    configs: Math.max(1, Math.round(opts.configs ?? 1)),
    params: opts.params ?? "",
    chosenOn: opts.chosenOn ?? null,
    sharpe,
    luckSharpe: luck,
    adjustedSharpe: sharpe !== null && luck !== null ? sharpe - luck : null,
    dsr: Number.isFinite(dsr) ? dsr : null,
    ...(opts.benchmark ? { benchmark: opts.benchmark } : {}),
  };
}

/** Daily strategy minus benchmark returns, where both are known on two days in a row. */
export function activeReturns(r: RunResult): number[] {
  const s = r.series;
  const out: number[] = [];
  for (let i = 1; i < s.dates.length; i++) {
    const e0 = s.equity[i - 1]!;
    const e1 = s.equity[i]!;
    const b0 = s.benchmark_equity[i - 1];
    const b1 = s.benchmark_equity[i];
    if (!(e0 > 0) || !isNum(e1) || !isNum(b0) || !(b0 > 0) || !isNum(b1)) continue;
    out.push(e1 / e0 - 1 - (b1 / b0 - 1));
  }
  return out;
}

/* ------------------------------------------------------------------ in-sample / out-of-sample */

export type PeriodStats = {
  start: string;
  end: string;
  days: number;
  cagr: number | null;
  sharpe: number | null;
  max_dd: number | null;
  total_return: number | null;
  /** The benchmark over the same days. */
  bench_cagr: number | null;
  bench_sharpe: number | null;
  bench_max_dd?: number | null;
  /** Closed round trips (sells) in the period, and the share that gained. */
  trades: number;
  win_rate: number | null;
  /** Share of days with a position open (from the trade list; null when it was cut or has no trades). */
  exposure: number | null;
};

export type SplitStats = {
  /** First out-of-sample day. */
  oosStart: string;
  /** "holdout" (last part held out), "walk_forward", or "default_30" (Falcon split the last 30%; the script chose nothing). */
  method: "holdout" | "walk_forward" | "default_30";
  is: PeriodStats;
  oos: PeriodStats;
  /** Share of the IS Sharpe lost out of sample (0.6 = 60% lower); null when IS Sharpe is not positive. */
  sharpeDrop: number | null;
  /** Sampling error (1 SE, annualized) of the OOS Sharpe estimate given its length (Lo 2002). */
  sharpeSE?: number | null;
  /** How the result held up out of sample (see `oosGrade`). */
  grade?: OosGrade;
  /** grade === "fell_sharply" (kept for stored audits). */
  bigDrop: boolean;
};

export type OosGrade = "held_up" | "weaker" | "fell_sharply";

/** The words for each grade, as the panel and the model say them. */
export const OOS_GRADE_TEXT: Record<OosGrade, string> = {
  held_up: "held up out of sample",
  weaker: "weaker out of sample",
  fell_sharply: "fell sharply out of sample",
};

/**
 * Sampling error of an annualized Sharpe estimated on `days` daily returns
 * (Lo 2002): SE(per-day SR) = sqrt((1 + SR_d^2 / 2) / T), times sqrt(252).
 */
export function sharpeSE(annualSharpeValue: number, days: number): number | null {
  if (!(days > 1) || !Number.isFinite(annualSharpeValue)) return null;
  const d = annualSharpeValue / Math.sqrt(252);
  return Math.sqrt((1 + 0.5 * d * d) / days) * Math.sqrt(252);
}

/** Below this share of the in-sample Sharpe, a drop can count as sharp. */
export const OOS_KEEP_SHARE = 0.5;

/**
 * Grades in-sample vs out-of-sample:
 * - "fell sharply": OOS Sharpe below half the IS one (IS Sharpe at least 0.3)
 *   AND the drop bigger than the OOS Sharpe's sampling error; or the result
 *   beat the benchmark in sample and lost to it out of sample with the OOS
 *   Sharpe below half the IS one;
 * - "weaker": a drop beyond the sampling error, or below half the IS Sharpe
 *   but within noise, or beating the benchmark in sample and not after;
 * - "held up": otherwise (a small drop, e.g. 0.66 to 0.59, is noise).
 */
export function oosGrade(is: Pick<PeriodStats, "sharpe" | "cagr" | "bench_cagr">, oos: Pick<PeriodStats, "sharpe" | "cagr" | "bench_cagr" | "days">): { grade: OosGrade; se: number | null } {
  const sIs = is.sharpe;
  const sOos = oos.sharpe;
  const se = sOos === null ? null : sharpeSE(sOos, oos.days);
  const beatIs = is.cagr !== null && is.bench_cagr !== null && is.cagr > is.bench_cagr;
  const loseOos = oos.cagr !== null && oos.bench_cagr !== null && oos.cagr < oos.bench_cagr;
  const flipped = beatIs && loseOos;
  if (sIs === null || sOos === null) return { grade: flipped ? "weaker" : "held_up", se };
  const drop = sIs - sOos;
  const halved = sIs >= 0.3 && sOos < OOS_KEEP_SHARE * sIs;
  const beyondNoise = se !== null && drop > se;
  if ((halved && beyondNoise) || (flipped && halved)) return { grade: "fell_sharply", se };
  if (halved || flipped || (drop > 0 && beyondNoise)) return { grade: "weaker", se };
  return { grade: "held_up", se };
}

/** Default share held out when the script does not say. */
export const DEFAULT_OOS_SHARE = 0.3;
/** Minimum days on each side for the split to be shown. */
export const MIN_SPLIT_DAYS = 60;

function cagrOf(first: number, last: number, from: string, to: string): number | null {
  const years = (dayMs(to) - dayMs(from)) / (365.25 * 86_400_000);
  if (!(first > 0) || !(last > 0) || !(years > 0.05)) return null;
  return (last / first) ** (1 / years) - 1;
}

/**
 * Time-weighted exposure: the share of `dates` with any position open at the
 * close, by the trade list (buy opens, sell closes a ticker). The whole test
 * and its two parts use this on disjoint day sets that add up to the whole, so
 * the whole is always the day-weighted average of the parts.
 */
export function exposureOf(trades: readonly RunTrade[], dates: readonly string[]): number | null {
  if (!trades.length || !dates.length) return null;
  // Same day: sells first, so a sell-and-rebuy (a rebalance) keeps the name held.
  const sorted = [...trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));
  const open = new Set<string>();
  let k = 0;
  let held = 0;
  for (const d of dates) {
    // Positions opened up to and including d count from d; closed on d count as not held at d's close.
    while (k < sorted.length && sorted[k]!.date <= d) {
      const t = sorted[k++]!;
      if (t.side === "buy") open.add(t.ticker);
      else open.delete(t.ticker);
    }
    if (open.size) held++;
  }
  return held / dates.length;
}

/** Stats of the result between series indexes i0 (the base day) and i1 (inclusive). */
export function periodStats(r: RunResult, i0: number, i1: number, tradesComplete = true): PeriodStats {
  const s = r.series;
  const eq = s.equity.slice(i0, i1 + 1);
  const be = s.benchmark_equity.slice(i0, i1 + 1);
  const start = s.dates[i0]!;
  const end = s.dates[i1]!;
  const daily = dailyReturns(eq);
  let peak = -Infinity;
  let dd = 0;
  for (const e of eq) {
    peak = Math.max(peak, e);
    if (peak > 0) dd = Math.min(dd, e / peak - 1);
  }
  const bFirst = be.find((v): v is number => isNum(v) && v > 0);
  const bLast = [...be].reverse().find((v): v is number => isNum(v) && v > 0);
  const bDaily = dailyReturns(be.map((v) => (isNum(v) ? v : NaN)));
  let bPeak = -Infinity;
  let bDd = 0;
  let bSeen = 0;
  for (const v of be) {
    if (!isNum(v) || !(v > 0)) continue;
    bSeen++;
    bPeak = Math.max(bPeak, v);
    bDd = Math.min(bDd, v / bPeak - 1);
  }
  const inRange = (t: RunTrade) => t.date > (i0 === 0 ? "" : start) && t.date <= end;
  const sells = r.trades.filter((t) => t.side === "sell" && inRange(t));
  const scored = sells.filter((t) => t.pnl !== null);
  return {
    start,
    end,
    days: eq.length - 1,
    cagr: cagrOf(eq[0]!, eq[eq.length - 1]!, start, end),
    sharpe: annualSharpe(daily),
    max_dd: eq.length > 1 ? dd : null,
    total_return: eq[0]! > 0 ? eq[eq.length - 1]! / eq[0]! - 1 : null,
    bench_cagr: bFirst && bLast ? cagrOf(bFirst, bLast, start, end) : null,
    bench_sharpe: annualSharpe(bDaily),
    bench_max_dd: bSeen > 1 ? bDd : null,
    trades: sells.length,
    win_rate: scored.length ? scored.filter((t) => (t.pnl ?? 0) > 0).length / scored.length : null,
    exposure: tradesComplete ? exposureOf(r.trades, s.dates.slice(i0 === 0 ? 0 : i0 + 1, i1 + 1)) : null,
  };
}

/**
 * Splits the curve at the script's out-of-sample start (`split.oos_start`),
 * or holds out the last 30% when it gave none. Null when either side would
 * have fewer than MIN_SPLIT_DAYS days.
 */
export function splitStats(r: RunResult, tradesComplete = r.trade_count <= r.trades.length): SplitStats | null {
  const d = r.series.dates;
  const n = d.length;
  if (n < MIN_SPLIT_DAYS * 2 + 1) return null;
  const given = r.split?.oos_start ?? null;
  let k = given ? d.findIndex((x) => x >= given) : -1;
  const method: SplitStats["method"] = k > 0 ? (r.split?.method === "walk_forward" ? "walk_forward" : "holdout") : "default_30";
  if (!(k > 0)) k = Math.round(n * (1 - DEFAULT_OOS_SHARE));
  if (k < MIN_SPLIT_DAYS || n - k < MIN_SPLIT_DAYS) return null;
  const is = periodStats(r, 0, k - 1, tradesComplete);
  const oos = periodStats(r, k - 1, n - 1, tradesComplete);
  const sharpeDrop = is.sharpe !== null && is.sharpe > 0 && oos.sharpe !== null ? (is.sharpe - oos.sharpe) / is.sharpe : null;
  const g = oosGrade(is, oos);
  return { oosStart: d[k]!, method, is, oos, sharpeDrop, sharpeSE: g.se, grade: g.grade, bigDrop: g.grade === "fell_sharply" };
}

/** The grade of a split, for stored audits that predate it. */
export function gradeOf(s: SplitStats): OosGrade {
  return s.grade ?? oosGrade(s.is, s.oos).grade;
}

/* ------------------------------------------------------------------ whole period and headline */

/**
 * The whole test measured exactly like its two parts (same curve, same
 * formulas, exposure over the union of their days). Closed trades come from
 * the full count when the trade list was cut. Null under 2 points.
 */
export function wholeStats(r: RunResult, tradesComplete = r.trade_count <= r.trades.length): PeriodStats | null {
  const n = r.series.dates.length;
  if (n < 2) return null;
  const w = periodStats(r, 0, n - 1, tradesComplete);
  if (!tradesComplete && r.metrics.trades !== null) w.trades = r.metrics.trades;
  return w;
}

/** Whether the reported version was selected (a sweep of 2+ versions, or a period set aside to pick it). */
export function isSelected(r: Pick<RunResult, "sweep" | "split">): boolean {
  return (r.sweep?.configs_tried ?? 1) > 1 || !!r.split;
}

export type HeadlineFigures = {
  cagr: number | null;
  bench_cagr: number | null;
  /** Strategy CAGR minus benchmark CAGR, decimal (0.012 = +1.2 points a year). */
  excess: number | null;
  sharpe: number | null;
  bench_sharpe: number | null;
  max_dd: number | null;
  bench_max_dd: number | null;
  trades: number | null;
  exposure: number | null;
};

export type HeadlinePart = HeadlineFigures & { id: "oos" | "is" | "whole"; label: string; start: string; end: string };

export type Headline = {
  /** "oos" for a selected strategy with a held-out part; "whole" otherwise. */
  scope: "oos" | "whole";
  benchmark: string;
  /** The numbers on the headline tiles. */
  main: HeadlinePart;
  /** The secondary rows (in sample and the whole test, for a selected strategy). */
  secondary: HeadlinePart[];
};

/** The whole test's figures of a headline. */
export const wholeOf = (h: Headline): HeadlinePart | null => (h.main.id === "whole" ? h.main : (h.secondary.find((x) => x.id === "whole") ?? null));

const excessOf = (a: number | null, b: number | null) => (a !== null && b !== null ? a - b : null);

function figures(p: PeriodStats): HeadlineFigures {
  return { cagr: p.cagr, bench_cagr: p.bench_cagr, excess: excessOf(p.cagr, p.bench_cagr), sharpe: p.sharpe, bench_sharpe: p.bench_sharpe, max_dd: p.max_dd, bench_max_dd: p.bench_max_dd ?? null, trades: p.trades, exposure: p.exposure };
}

/** The script's own whole-period metrics, when the curve could not be measured. */
function fromMetrics(r: RunResult): HeadlineFigures {
  const m = r.metrics;
  return { cagr: m.cagr, bench_cagr: m.benchmark.cagr, excess: excessOf(m.cagr, m.benchmark.cagr), sharpe: m.sharpe, bench_sharpe: m.benchmark.sharpe, max_dd: m.max_dd, bench_max_dd: m.benchmark.max_dd, trades: m.trades, exposure: m.exposure ?? null };
}

/** Fills a measured period's gaps (no benchmark curve, no trade list) from the script's metrics. */
function withFallback(p: HeadlineFigures, f: HeadlineFigures): HeadlineFigures {
  const out = { ...p };
  (Object.keys(out) as (keyof HeadlineFigures)[]).forEach((k) => {
    if (out[k] === null) out[k] = f[k];
  });
  out.excess = excessOf(out.cagr, out.bench_cagr);
  return out;
}

export const OOS_LABEL = "Out of sample (not used to pick)";

/**
 * The headline both the panel and the model quote. A selected strategy (sweep
 * or selection period) leads with the out-of-sample part, the only part not
 * used to pick it; whole test and in sample follow as secondary rows.
 */
export function headlineOf(r: RunResult, whole: PeriodStats | null, split: SplitStats | null, benchmark = benchmarkName(r)): Headline {
  const metrics = fromMetrics(r);
  const w: HeadlinePart = { ...(whole ? withFallback(figures(whole), metrics) : metrics), id: "whole", label: "Whole test", start: whole?.start ?? r.period.start, end: whole?.end ?? r.period.end };
  if (isSelected(r) && split) {
    const oos: HeadlinePart = { ...figures(split.oos), id: "oos", label: OOS_LABEL, start: split.oosStart, end: split.oos.end };
    const is: HeadlinePart = { ...figures(split.is), id: "is", label: "In sample (used to pick)", start: split.is.start, end: split.is.end };
    return { scope: "oos", benchmark, main: oos, secondary: [is, w] };
  }
  return { scope: "whole", benchmark, main: w, secondary: [] };
}

/** "+1.2 pts" from a decimal difference. */
export function fmtPts(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const x = Math.round(v * 1000) / 10;
  return `${x > 0 ? "+" : ""}${x === 0 ? "0.0" : x.toFixed(1)} pts`;
}
