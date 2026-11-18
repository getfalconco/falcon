/**
 * The results panel's figures as citable sources: each number the panel shows
 * (lab/RunPanel.tsx, lab/RunHonesty.tsx) with the audit or result field it
 * comes from, so a click on a panel number and a click on the same number in
 * the chat (`[%12,3](src:audit "oos.cagr")`, lib/desk/citations.ts) name the
 * same field. Pure and client-safe.
 */

import { fmtPct } from "./run-result";
import { fmtPts, type Headline, type PeriodStats, type SplitStats } from "./robustness";
import { parseShown, sameNumber } from "./citations";

export type PanelFigure = {
  /** Where it comes from: "audit.headline.oos.cagr", "audit.split.oos.win_rate", "result.metrics.cagr". */
  path: string;
  /** The part of the test: "oos", "is", "whole", or "script" (the script's own result file). */
  part: string;
  /** The measure: cagr, bench_cagr, excess, sharpe, bench_sharpe, max_dd, bench_max_dd, trades, exposure, win_rate, turnover. */
  measure: string;
  value: number;
  /** As the panel prints it. */
  shown: string;
};

const f2 = (v: number) => v.toFixed(2);
const pct0 = (v: number) => fmtPct(v, 0, false);
const FORMAT: Record<string, (v: number) => string> = {
  cagr: (v) => fmtPct(v),
  bench_cagr: (v) => fmtPct(v),
  excess: (v) => fmtPts(v),
  sharpe: f2,
  bench_sharpe: f2,
  max_dd: (v) => fmtPct(v),
  bench_max_dd: (v) => fmtPct(v),
  trades: (v) => String(v),
  exposure: pct0,
  win_rate: pct0,
  total_return: (v) => fmtPct(v),
};

/** Every figure the panel can show for a test: the audit's headline and split first, then the script's own metrics. */
export function panelFigures(src: { headline?: Headline | null; split?: SplitStats | null; whole?: PeriodStats | null; metrics?: Record<string, unknown> | null }): PanelFigure[] {
  const out: PanelFigure[] = [];
  const add = (path: string, part: string, measure: string, v: unknown) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    out.push({ path, part, measure, value: v, shown: (FORMAT[measure] ?? f2)(v) });
  };
  const h = src.headline;
  if (h) {
    for (const p of [h.main, ...h.secondary]) {
      for (const k of ["cagr", "bench_cagr", "excess", "sharpe", "bench_sharpe", "max_dd", "bench_max_dd", "trades", "exposure"] as const) add(`audit.headline.${p.id}.${k}`, p.id, k, p[k]);
    }
  }
  const periods: [string, PeriodStats | null | undefined][] = [
    ["oos", src.split?.oos],
    ["is", src.split?.is],
    ["whole", src.whole],
  ];
  for (const [part, p] of periods) {
    if (!p) continue;
    for (const k of ["win_rate", "total_return", "cagr", "sharpe", "max_dd", "bench_cagr", "bench_sharpe"] as const) add(`audit.${part === "whole" ? "whole" : `split.${part}`}.${k}`, part, k, p[k]);
  }
  const m = src.metrics;
  if (m) {
    for (const k of ["cagr", "sharpe", "max_dd", "total_return", "trades", "win_rate", "exposure"]) add(`result.metrics.${k}`, "script", k, m[k]);
    const b = (m.benchmark ?? {}) as Record<string, unknown>;
    add("result.metrics.benchmark.cagr", "script", "bench_cagr", b.cagr);
    add("result.metrics.benchmark.sharpe", "script", "bench_sharpe", b.sharpe);
    add("result.metrics.benchmark.max_dd", "script", "bench_max_dd", b.max_dd);
    if (typeof m.turnover === "number") out.push({ path: "result.metrics.turnover", part: "script", measure: "turnover", value: m.turnover, shown: `${m.turnover.toFixed(1)}× a year` });
  }
  return out;
}

/** The measure a row label or cited field names ("Max drawdown", "SPY CAGR", "oos.max_dd", "vs SPY"). */
export function measureOf(text: string): string | null {
  const t = text.toLowerCase();
  if (/bench|spy\b.*cagr|^\S+ cagr$/.test(t) && /cagr/.test(t)) return "bench_cagr";
  if (/max[ _-]?dd|drawdown/.test(t)) return /bench/.test(t) ? "bench_max_dd" : "max_dd";
  if (/sharpe/.test(t)) return /bench/.test(t) ? "bench_sharpe" : "sharpe";
  if (/excess|difference|diff|edge|^vs\b|puan|pts/.test(t)) return "excess";
  if (/cagr/.test(t)) return "cagr";
  if (/win/.test(t)) return "win_rate";
  if (/trades|işlem/.test(t)) return "trades";
  if (/exposure/.test(t)) return "exposure";
  if (/turnover/.test(t)) return "turnover";
  if (/total/.test(t)) return "total_return";
  return null;
}

/** The part a column header or cited field names ("Out of sample", "oos.cagr", "Whole test"). */
export function partOf(text: string): string | null {
  const t = text.toLowerCase();
  if (/\boos\b|out[ _-]?of[ _-]?sample/.test(t)) return "oos";
  if (/(^|\.|\s)is(\.|\s|$)|in[ _-]?sample/.test(t)) return "is";
  if (/whole|full|total test/.test(t)) return "whole";
  return null;
}

/** The figure a shown number is, with hints from its row and column (or a cited field); audit figures first. */
export function matchFigure(figs: PanelFigure[], text: string, hints: { measure?: string | null; part?: string | null } = {}): PanelFigure | null {
  const clean = text.replace(/\s+/g, " ").trim();
  const shown = parseShown(clean);
  if (!shown) return null;
  let best: { f: PanelFigure; score: number } | null = null;
  for (const f of figs) {
    const exact = f.shown === clean;
    if (!exact && !sameNumber(f.value, shown)) continue;
    const score = (exact ? 4 : 0) + (hints.measure && f.measure === hints.measure ? 8 : 0) + (hints.part && f.part === hints.part ? 2 : 0) + (f.part === "script" ? 0 : 1);
    if (!best || score > best.score) best = { f, score };
  }
  return best?.f ?? null;
}
