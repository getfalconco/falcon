"use client";

import { useMemo } from "react";
import { Database, Info, Layers, Receipt, TriangleAlert } from "lucide-react";
import { TRADES_DEFINITION, benchmarkLong, benchmarkName, fmtPct, isTickerName } from "@/lib/desk/run-result";
import { dsrMethod, dsrPlain, fmtPts, gradeOf, headlineOf, splitStats, wholeOf, wholeStats, type Headline, type PeriodStats, type SplitStats } from "@/lib/desk/robustness";
import { MONO } from "../parts";
import type { LabRun } from "./run";

/**
 * The honest-reading parts of the results panel's Overview: key stats over
 * the whole test, in sample and out of sample (`KeyStats`), the strategy
 * against its benchmark and the list held equally (`Benchmarks`), and the caveats
 * that always show (`Caveats`: survivorship, data source, costs, versions
 * tried). The split comes from Falcon's audit (computed on the full curve);
 * without it, from the result when its curve was not cut.
 */

const f2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : v.toFixed(2));
const toneOf = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) || v === 0 ? "text-fore-2" : v > 0 ? "text-up" : "text-down");
const DATABENTO_FROM = "2024-07-01";

export type RunStats = { benchmark: string; split: SplitStats | null; whole: PeriodStats | null; headline: Headline };

/**
 * The one set of numbers the panel shows: from Falcon's audit (computed on the
 * full curve on the server; the same numbers the model is told to quote), or,
 * before the audit, measured the same way on the result when its curve was not cut.
 */
export function useRunStats(run: LabRun): RunStats | null {
  const r = run.result;
  const a = run.audit;
  return useMemo(() => {
    if (!r) return null;
    const benchmark = a?.benchmark ?? benchmarkName(r);
    const complete = !run.cut?.points;
    const split = a?.split ?? (complete ? splitStats(r, !run.cut?.trades && r.trade_count <= r.trades.length) : null);
    const whole = a?.whole ?? (complete ? wholeStats(r, !run.cut?.trades && r.trade_count <= r.trades.length) : null);
    return { benchmark, split, whole, headline: a?.headline ?? headlineOf(r, whole, split, benchmark) };
  }, [a, r, run.cut?.points, run.cut?.trades]);
}

export function useSplit(run: LabRun): SplitStats | null {
  return useRunStats(run)?.split ?? null;
}

function H({ children }: { children: React.ReactNode }) {
  return <h3 className="text-fs-12 font-medium uppercase tracking-[0.06em] text-faint">{children}</h3>;
}

type Row = { label: string; title?: string; full: string; is?: string; oos?: string; toneFull?: number | null; toneIs?: number | null; toneOos?: number | null };

export function KeyStats({ run }: { run: LabRun }) {
  const r = run.result!;
  const m = r.metrics;
  const st = useRunStats(run);
  const split = st?.split ?? null;
  const B = st?.benchmark ?? benchmarkName(r);
  const w = st ? wholeOf(st.headline) : null;
  const is = split?.is;
  const oos = split?.oos;
  const pct0 = (v: number | null | undefined) => fmtPct(v ?? null, 0, false);
  const diff = (p: PeriodStats | undefined) => (p && p.cagr !== null && p.bench_cagr !== null ? p.cagr - p.bench_cagr : null);
  const rows: Row[] = [
    { label: "CAGR", full: fmtPct(w?.cagr ?? null), is: fmtPct(is?.cagr ?? null), oos: fmtPct(oos?.cagr ?? null), toneFull: w?.cagr, toneIs: is?.cagr, toneOos: oos?.cagr },
    { label: isTickerName(B) ? `${B} CAGR` : "Benchmark CAGR", title: `The benchmark: ${benchmarkLong(B)}`, full: fmtPct(w?.bench_cagr ?? null), is: fmtPct(is?.bench_cagr ?? null), oos: fmtPct(oos?.bench_cagr ?? null) },
    { label: isTickerName(B) ? `vs ${B}` : "vs benchmark", title: `CAGR minus the CAGR of ${B} (the benchmark), percentage points a year`, full: fmtPts(w?.excess), is: fmtPts(diff(is)), oos: fmtPts(diff(oos)), toneFull: w?.excess, toneIs: diff(is), toneOos: diff(oos) },
    { label: "Sharpe", full: f2(w?.sharpe), is: f2(is?.sharpe), oos: f2(oos?.sharpe) },
    { label: "Max drawdown", full: fmtPct(w?.max_dd ?? null), is: fmtPct(is?.max_dd ?? null), oos: fmtPct(oos?.max_dd ?? null), toneFull: w?.max_dd, toneIs: is?.max_dd, toneOos: oos?.max_dd },
    { label: "Win rate", full: pct0(st?.whole?.win_rate ?? m.win_rate), is: pct0(is?.win_rate), oos: pct0(oos?.win_rate) },
    { label: "Closed trades", title: TRADES_DEFINITION, full: w?.trades === null || w?.trades === undefined ? "n/a" : String(w.trades), is: is ? String(is.trades) : undefined, oos: oos ? String(oos.trades) : undefined },
    {
      label: "Exposure",
      title: "Share of trading days with a position open at the close, measured on the same days for the whole test and its two parts (the whole is their day-weighted average).",
      full: pct0(w?.exposure),
      is: pct0(is?.exposure),
      oos: pct0(oos?.exposure),
    },
    { label: "Turnover", full: m.turnover === null ? "n/a" : `${m.turnover.toFixed(1)}× a year`, is: "", oos: "" },
  ];
  const grade = split ? gradeOf(split) : null;
  const se = split?.sharpeSE ?? null;
  return (
    <section className="flex flex-col gap-2.5" aria-label="Key stats">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <H>Key stats{split ? " · in sample vs out of sample" : ""}</H>
        {split ? (
          <span className="text-fs-11.5 text-faint">
            {split.method === "default_30" ? "Last 30% held out by Falcon" : split.method === "walk_forward" ? "Walk-forward" : "Held out by the test"} · from {split.oosStart}
          </span>
        ) : null}
      </div>
      <div className="overflow-x-auto rounded-xl border border-line/[0.08] bg-surface-3">
        <table className="w-full min-w-[360px] border-collapse text-fs-13 leading-fs-20">
          <thead>
            <tr className="border-b border-line/[0.08] text-fs-11.5 text-quiet">
              <th scope="col" className="px-3.5 py-2 text-left font-medium">
                <span className="sr-only">Measure</span>
              </th>
              <th scope="col" className="px-3.5 py-2 text-right font-medium">Whole test</th>
              {split ? (
                <>
                  <th scope="col" className="px-3.5 py-2 text-right font-medium">In sample</th>
                  <th scope="col" className="px-3.5 py-2 text-right font-medium">Out of sample</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-line/[0.05] last:border-b-0">
                <th scope="row" className="px-3.5 py-1.5 text-left font-normal text-quiet">
                  {row.title ? (
                    <span title={row.title} className="cursor-help underline decoration-line/25 decoration-dotted underline-offset-[3px]">
                      {row.label}
                    </span>
                  ) : (
                    row.label
                  )}
                </th>
                <td className={`px-3.5 py-1.5 text-right tabular-nums ${row.toneFull !== undefined ? toneOf(row.toneFull) : "text-fore-2"}`} style={{ fontFamily: MONO }}>
                  {row.full}
                </td>
                {split ? (
                  <>
                    <td className={`px-3.5 py-1.5 text-right tabular-nums ${row.toneIs !== undefined ? toneOf(row.toneIs) : "text-fore-3"}`} style={{ fontFamily: MONO }}>
                      {row.is ?? "n/a"}
                    </td>
                    <td className={`px-3.5 py-1.5 text-right tabular-nums ${row.toneOos !== undefined ? toneOf(row.toneOos) : "text-fore-3"}`} style={{ fontFamily: MONO }}>
                      {row.oos ?? "n/a"}
                    </td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {grade === "fell_sharply" ? (
        <p className="flex gap-2 rounded-lg bg-warn/[0.07] px-3 py-2 text-fs-12.5 leading-fs-18 text-fore-2">
          <TriangleAlert width={14} height={14} strokeWidth={2} className="mt-[2px] shrink-0 text-warn" aria-hidden />
          <span>
            The result fell sharply out of sample (Sharpe {f2(split?.is.sharpe)} → {f2(split?.oos.sharpe)}, more than its sampling error{se !== null ? ` of about ±${f2(se)}` : ""}), a common sign of a rule fitted to the past.
          </span>
        </p>
      ) : grade === "weaker" ? (
        <p className="flex gap-2 rounded-lg bg-line/[0.035] px-3 py-2 text-fs-12.5 leading-fs-18 text-fore-3">
          <Info width={14} height={14} strokeWidth={2} className="mt-[2px] shrink-0 text-quiet" aria-hidden />
          <span>
            Weaker out of sample: Sharpe {f2(split?.is.sharpe)} → {f2(split?.oos.sharpe)}
            {se !== null ? ` (sampling error about ±${f2(se)})` : ""}.
          </span>
        </p>
      ) : grade === "held_up" ? (
        <p className="text-fs-12 leading-fs-18 text-faint">
          Held up out of sample: Sharpe {f2(split?.is.sharpe)} → {f2(split?.oos.sharpe)}
          {se !== null ? `, within the sampling error of about ±${f2(se)} for ${split?.oos.days.toLocaleString("en-US")} days` : ""}.
        </p>
      ) : (
        <p className="text-fs-12 leading-fs-18 text-faint">The curve is too short (or kept in a smaller copy) to split into in-sample and out-of-sample parts.</p>
      )}
    </section>
  );
}

/** The benchmark's total return over the curve (first to last known value). */
function benchTotalOf(r: NonNullable<LabRun["result"]>): number | null {
  const be = r.series.benchmark_equity;
  const first = be.find((v): v is number => v !== null && v > 0);
  let last: number | null = null;
  for (let i = be.length - 1; i >= 0; i--) if (be[i] !== null && be[i]! > 0) {
    last = be[i]!;
    break;
  }
  return first && last ? last / first - 1 : null;
}

export function Benchmarks({ run }: { run: LabRun }) {
  const r = run.result!;
  const m = r.metrics;
  const b = m.benchmark;
  const c = run.audit?.comparison ?? null;
  const st = useRunStats(run);
  const B = st?.benchmark ?? benchmarkName(r);
  const w = st ? wholeOf(st.headline) : null;
  const whole = st?.whole ?? null;
  const benchTotal = whole ? benchTotalOf(r) : b.total_return;
  const rows: { k: string; cagr: number | null; sharpe: string; dd: number | null; total: number | null }[] = [
    { k: r.name || "Strategy", cagr: w?.cagr ?? m.cagr, sharpe: f2(w?.sharpe ?? m.sharpe), dd: w?.max_dd ?? m.max_dd, total: whole?.total_return ?? m.total_return },
    { k: benchmarkLong(B), cagr: w?.bench_cagr ?? b.cagr, sharpe: f2(w?.bench_sharpe ?? b.sharpe), dd: w?.bench_max_dd ?? b.max_dd, total: benchTotal ?? b.total_return },
  ];
  return (
    <section className="flex flex-col gap-2.5" aria-label="Benchmarks">
      <H>Against the benchmarks</H>
      <div className="overflow-x-auto rounded-xl border border-line/[0.08] bg-surface-3">
        <table className="w-full min-w-[360px] border-collapse text-fs-13 leading-fs-20">
          <thead>
            <tr className="border-b border-line/[0.08] text-fs-11.5 text-quiet">
              <th scope="col" className="px-3.5 py-2 text-left font-medium">
                <span className="sr-only">Portfolio</span>
              </th>
              <th scope="col" className="px-3.5 py-2 text-right font-medium">CAGR</th>
              <th scope="col" className="px-3.5 py-2 text-right font-medium">Sharpe</th>
              <th scope="col" className="px-3.5 py-2 text-right font-medium">Max DD</th>
              <th scope="col" className="px-3.5 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.k} className="border-b border-line/[0.05]">
                <th scope="row" className="max-w-[180px] truncate px-3.5 py-1.5 text-left font-normal text-fore-2">
                  {row.k}
                </th>
                <td className={`px-3.5 py-1.5 text-right tabular-nums ${toneOf(row.cagr)}`} style={{ fontFamily: MONO }}>
                  {fmtPct(row.cagr)}
                </td>
                <td className="px-3.5 py-1.5 text-right tabular-nums text-fore-2" style={{ fontFamily: MONO }}>
                  {row.sharpe}
                </td>
                <td className={`px-3.5 py-1.5 text-right tabular-nums ${toneOf(row.dd)}`} style={{ fontFamily: MONO }}>
                  {fmtPct(row.dd)}
                </td>
                <td className={`px-3.5 py-1.5 text-right tabular-nums ${toneOf(row.total)}`} style={{ fontFamily: MONO }}>
                  {fmtPct(row.total, 0)}
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row" className="max-w-[180px] truncate px-3.5 py-1.5 text-left font-normal text-fore-2">
                {c ? `${c.listName.charAt(0).toUpperCase()}${c.listName.slice(1)}, equal weight` : "The list, equal weight"}
              </th>
              {c ? (
                <>
                  <td className={`px-3.5 py-1.5 text-right tabular-nums ${toneOf(c.list)}`} style={{ fontFamily: MONO }}>
                    {fmtPct(c.list)}
                  </td>
                  <td colSpan={3} className="px-3.5 py-1.5 text-right text-fs-12 text-faint">
                    CAGR only
                  </td>
                </>
              ) : (
                <td colSpan={4} className="px-3.5 py-1.5 text-right text-fs-12 text-faint">
                  {run.audit ? "Not applicable: one ticker, no list" : run.status === "running" ? "After the audit" : "n/a"}
                </td>
              )}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Caveat({ icon: I, tone, children }: { icon: typeof Info; tone: "warn" | "quiet"; children: React.ReactNode }) {
  return (
    <li className={`flex gap-2.5 rounded-lg px-3 py-2 text-fs-12.5 leading-fs-19 ${tone === "warn" ? "bg-warn/[0.07] text-fore-2" : "bg-line/[0.035] text-fore-3"}`}>
      <I width={14} height={14} strokeWidth={2} className={`mt-[2px] shrink-0 ${tone === "warn" ? "text-warn" : "text-quiet"}`} aria-hidden />
      <span>{children}</span>
    </li>
  );
}

/** Survivorship, data source, costs and versions tried: shown on every test. */
export function Caveats({ run }: { run: LabRun }) {
  const r = run.result!;
  const a = run.audit;
  const sv = a?.caveats?.survivorship ?? null;
  const todaysList = !sv && /today|s&p 500 members|most traded|falcon/i.test(r.universe);
  const source = a?.caveats?.dataSource ?? (r.period.start >= DATABENTO_FROM ? "Prices: Databento daily bars from July 2024 (Yahoo Finance if Databento lacks a ticker), split-adjusted." : "Prices: Yahoo Finance daily bars, split- and dividend-adjusted (Falcon's Databento store starts July 2024).");
  const costs = r.assumptions.costs_bps;
  const mt = a?.multiple;
  const configs = mt?.configs ?? r.sweep?.configs_tried ?? 1;
  const B = a?.benchmark ?? benchmarkName(r);
  // The deflated Sharpe never looks reassuring next to a weak label: quiet only when it is high AND the label agrees.
  const weakLabel = !!a && (a.label.level === "thin" || a.label.level === "insufficient");
  const dsrQuiet = !!mt && mt.dsr !== null && mt.dsr >= 0.95 && !!a && !weakLabel;
  return (
    <section className="flex flex-col gap-2.5" aria-label="Caveats">
      <H>Read with care</H>
      <ul className="flex flex-col gap-1.5">
        {sv ? (
          <Caveat icon={TriangleAlert} tone="warn">
            <strong className="font-medium">Survivorship:</strong> the list is {sv.listName}, today&apos;s members.{" "}
            {sv.late ? `${sv.late.toLocaleString("en-US")} of ${sv.total.toLocaleString("en-US")} were not listed yet at the start, and` : "Companies"} that went bankrupt or were taken over before today are missing, which usually flatters the result.
          </Caveat>
        ) : todaysList ? (
          <Caveat icon={TriangleAlert} tone="warn">
            <strong className="font-medium">Survivorship:</strong> the list is today&apos;s membership; companies that dropped out before today are missing, which usually flatters the result.
          </Caveat>
        ) : null}
        {configs > 1 ? (
          <Caveat icon={Layers} tone={dsrQuiet ? "quiet" : "warn"}>
            <strong className="font-medium">Best of {configs.toLocaleString("en-US")} tried</strong>
            {r.sweep?.params ? ` (${r.sweep.params})` : ""}
            {mt ? `. ${dsrPlain({ ...mt, benchmark: mt.benchmark ?? B })}.` : "."}
            {weakLabel ? ` The evidence label stays "${a!.label.title}": this is one input, not proof on its own.` : ""}{" "}
            <span className="text-quiet">{dsrMethod(mt?.benchmark ?? B)}</span>
          </Caveat>
        ) : mt && mt.trials > 1 ? (
          <Caveat icon={Layers} tone={dsrQuiet ? "quiet" : "warn"}>
            {mt.trials} strategy tests in this conversation; the evidence label counts them. {dsrPlain({ ...mt, benchmark: mt.benchmark ?? B })}.
            {weakLabel ? ` The evidence label stays "${a!.label.title}".` : ""}
          </Caveat>
        ) : null}
        <Caveat icon={Receipt} tone={costs === null || !(costs > 0) ? "warn" : "quiet"}>
          {costs === null ? "Trading costs: the test does not say what it charged." : costs > 0 ? `Trading costs: ${costs} bps per side on every trade; no taxes, borrowing or market impact.` : "Trading costs: none charged, which flatters any strategy that trades."}
        </Caveat>
        <Caveat icon={Database} tone="quiet">
          {source}
        </Caveat>
      </ul>
    </section>
  );
}

