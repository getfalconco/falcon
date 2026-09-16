import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import EquityChart from "./EquityChart";
import type { BacktestReport, HorizonStats, SampleStats, StrategyRow } from "../../../shared/quantlab-types";
import { DASH, beatsBaseRate, edgeOf, pct, pctPlain, ratio } from "./quantlab-format";

/**
 * Results (§10) — the report, with every figure sitting next to the thing that
 * undermines it: the base rate beside the median, the interval beside the
 * point estimate, out-of-sample beside in-sample, the variant count above all
 * of it.
 */
export default function ResultsTab({
  reports,
  strategies,
  selectedId,
  onSelect,
}: {
  reports: BacktestReport[];
  strategies: StrategyRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [index, setIndex] = useState(0);
  // Collapsed by default: the chart answers the question, the tables are for
  // when you want to know why.
  const [showDetail, setShowDetail] = useState(false);
  const report = reports[Math.min(index, Math.max(0, reports.length - 1))] ?? null;

  return (
    <>
      <div className="w-[280px] shrink-0 overflow-y-auto border-r border-[#e0e0da]">
        {strategies.map((row) => (
          <button
            key={row.strategy.strategy_id}
            onClick={() => {
              onSelect(row.strategy.strategy_id);
              setIndex(0);
            }}
            className={`block w-full border-b border-[#e8e8e2] px-4 py-3 text-left text-[12px] transition-colors ${
              selectedId === row.strategy.strategy_id ? "bg-[#e8e8e2]" : "hover:bg-[#eeeee8]"
            }`}
          >
            <div className="text-[#1d1b1b]">{row.strategy.name}</div>
            <div className="mt-0.5 text-[10px] text-[#9CA3AF] tabular-nums">
              {row.runs} run{row.runs === 1 ? "" : "s"}
            </div>
          </button>
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {!report && (
          <div className="px-6 py-5 text-[12px] text-[#9CA3AF]">
            No backtest has been run for this strategy yet. Run one from the Builder tab.
          </div>
        )}
        {report && (
          <div className="px-6 py-5">
            <div className="flex items-baseline gap-3">
              <h2 className="font-baskerville text-[20px] text-[#1d1b1b]">{report.strategy_name}</h2>
              <span className="text-[11px] text-[#9CA3AF] tabular-nums">
                v{report.strategy_version} · variant {report.variant_number} · {report.window.from} →{" "}
                {report.window.to}
              </span>
              {reports.length > 1 && (
                <select
                  value={index}
                  onChange={(e) => setIndex(Number(e.target.value))}
                  className="ml-auto rounded border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#4b5563]"
                >
                  {reports.map((r, i) => (
                    <option key={r.report_id} value={i}>
                      variant {r.variant_number} · {r.created_at.slice(0, 10)}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="mt-3 rounded-lg border border-[#e0e0da] bg-white px-4 py-3">
              <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">VERDICT</div>
              <p className="mt-1 font-baskerville text-[15px] leading-relaxed text-[#1d1b1b]">{report.verdict}</p>
            </div>

            {[report.variant_warning, report.overfit_warning, report.split_warning]
              .filter((w): w is string => Boolean(w))
              .map((warning) => (
                <div
                  key={warning}
                  className="mt-2 rounded-lg border border-[#e0d9c8] bg-[#faf6ec] px-4 py-2 text-[12px] text-[#8a7a55]"
                >
                  {warning}
                </div>
              ))}
            {report.created_after_oos_view && (
              <div className="mt-2 rounded-lg border border-[#e0d9c8] bg-[#faf6ec] px-4 py-2 text-[12px] text-[#8a7a55]">
                This version was created after an out-of-sample result had been viewed.
              </div>
            )}

            {report.equity?.length > 0 && (
              <EquityChart
                curves={report.equity}
                oosFrom={report.out_of_sample.from}
                hasEdge={oosEdge(report)}
              />
            )}

            <button
              onClick={() => setShowDetail((v) => !v)}
              className="mt-5 flex items-center gap-1.5 text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF] hover:text-[#6b7280]"
            >
              {showDetail ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              DETAILED STATISTICS
            </button>

            {showDetail && (
              <>
                <div className="mt-3 grid grid-cols-2 gap-4">
                  <SampleBlock sample={report.in_sample} />
                  <SampleBlock sample={report.out_of_sample} highlight />
                </div>

                <div className="mt-5">
                  <SampleBlock sample={report.full} />
                </div>

                {report.full.horizons.map((h) =>
                  h.deciles.length > 0 ? <Deciles key={h.sessions} horizon={h} /> : null,
                )}
              </>
            )}

            {report.excluded.length > 0 && (
              <div className="mt-5">
                <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">EXCLUDED</div>
                <div className="mt-1 text-[12px] text-[#6b7280]">
                  {Object.entries(
                    report.excluded.reduce<Record<string, string[]>>((acc, e) => {
                      (acc[e.reason] ??= []).push(e.ticker);
                      return acc;
                    }, {}),
                  ).map(([reason, tickers]) => (
                    <div key={reason} className="mt-1">
                      <span className="text-[#4b5563]">{reason}</span> ({tickers.length}): {tickers.join(" ")}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-5">
              <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">CAVEATS</div>
              <ul className="mt-1 space-y-1">
                {report.caveats.map((c) => (
                  <li key={c} className="flex gap-2 text-[12px] text-[#6b7280]">
                    <span className="select-none text-[#c8c8c2]">·</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Did the out-of-sample block find an edge? Reads the horizon with the most
 * evidence, matching how the verdict line is chosen. Null when undecidable.
 */
function oosEdge(report: BacktestReport): boolean | null {
  const scored = report.out_of_sample.horizons.filter((h) => !h.insufficient);
  if (scored.length === 0) return null;
  const chosen = scored.reduce((a, h) => (h.n > a.n ? h : a));
  return beatsBaseRate(chosen);
}

function SampleBlock({ sample, highlight }: { sample: SampleStats; highlight?: boolean }) {
  const label = sample.label.replace(/_/g, "-").toUpperCase();
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        highlight ? "border-[#1d1b1b]/20 bg-white" : "border-[#e0e0da] bg-[#fafaf7]"
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">{label}</span>
        <span className="text-[10px] text-[#c0c0ba] tabular-nums">
          {sample.from} → {sample.to}
        </span>
      </div>
      <table className="mt-2 w-full text-[11px] tabular-nums">
        <thead>
          <tr className="text-[#9CA3AF]">
            <th className="text-left font-normal">hold</th>
            <th className="text-right font-normal">n</th>
            <th className="text-right font-normal">median</th>
            <th className="text-right font-normal">base</th>
            <th className="text-right font-normal">hit</th>
            <th className="text-right font-normal">Sharpe</th>
            <th className="text-right font-normal">Sortino</th>
            <th className="text-right font-normal">maxDD</th>
            <th className="text-right font-normal">95% CI</th>
          </tr>
        </thead>
        <tbody>
          {sample.horizons.map((h) => (
            <HorizonRow key={h.sessions} horizon={h} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HorizonRow({ horizon: h }: { horizon: HorizonStats }) {
  if (h.insufficient) {
    return (
      <tr className="border-t border-[#eeeee8] text-[#9CA3AF]">
        <td className="py-1 text-left">{h.sessions}d</td>
        <td className="text-right">{h.n}</td>
        <td colSpan={7} className="py-1 pl-3 text-left italic">
          insufficient signals — no point estimate
        </td>
      </tr>
    );
  }
  const beats = beatsBaseRate(h);
  const edge = edgeOf(h);
  return (
    <tr className="border-t border-[#eeeee8] text-[#4b5563]">
      <td className="py-1 text-left">{h.sessions}d</td>
      <td className="text-right">{h.n}</td>
      <td
        className={`text-right ${beats === true ? "text-[#1d7a55]" : beats === false ? "text-[#9CA3AF]" : ""}`}
        title={edge != null ? `edge over base rate: ${pct(edge)}` : undefined}
      >
        {pct(h.median)}
      </td>
      <td className="text-right text-[#9CA3AF]">{pct(h.base_rate_median)}</td>
      <td className="text-right">{pctPlain(h.hit_rate)}</td>
      <td className="text-right">{ratio(h.sharpe)}</td>
      <td className="text-right">{ratio(h.sortino)}</td>
      <td className="text-right">{pct(h.max_drawdown)}</td>
      <td className="text-right text-[#9CA3AF]">
        {h.ci_low == null ? DASH : `${pct(h.ci_low)} … ${pct(h.ci_high)}`}
      </td>
    </tr>
  );
}

/** The distribution as a bar row — central tendency alone hides the tails. */
function Deciles({ horizon }: { horizon: HorizonStats }) {
  const max = Math.max(...horizon.deciles.map((d) => Math.abs(d)), 1e-9);
  return (
    <div className="mt-5">
      <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">
        DISTRIBUTION · {horizon.sessions}d · p10 → p90
      </div>
      <div className="mt-2 flex items-end gap-1">
        {horizon.deciles.map((d, i) => (
          <div key={i} className="flex flex-1 flex-col items-center gap-1">
            <div className="flex h-16 w-full items-end justify-center">
              <div
                className={`w-full rounded-sm ${d >= 0 ? "bg-[#189E9A]" : "bg-[#c98b8b]"}`}
                style={{ height: `${Math.max(2, (Math.abs(d) / max) * 100)}%` }}
              />
            </div>
            <span className="text-[9px] text-[#9CA3AF] tabular-nums">{pct(d, 1)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
