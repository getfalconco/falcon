import { na } from "@/lib/i18n/na";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useI18n, useT, type MessageKey } from "@/lib/i18n";
import { plural } from "../base/plural";
import EquityChart from "./EquityChart";
import type { BacktestReport, HorizonStats, SampleStats, StrategyRow } from "../../../shared/quantlab-types";
import { beatsBaseRate, edgeOf, pct, pctPlain, ratio } from "./quantlab-format";

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
  const { t, locale } = useI18n();
  const [index, setIndex] = useState(0);
  // Collapsed by default: the chart answers the question, the tables are for
  // when you want to know why.
  const [showDetail, setShowDetail] = useState(false);
  const report = reports[Math.min(index, Math.max(0, reports.length - 1))] ?? null;

  return (
    <>
      <div className="w-[280px] shrink-0 overflow-y-auto border-r border-edge">
        {strategies.map((row) => (
          <button
            key={row.strategy.strategy_id}
            onClick={() => {
              onSelect(row.strategy.strategy_id);
              setIndex(0);
            }}
            className={`block w-full border-b border-edge px-4 py-3 text-left text-[12px] transition-colors ${
              selectedId === row.strategy.strategy_id ? "bg-surface-3" : "hover:bg-surface-3"
            }`}
          >
            <div className="text-content-primary">{row.strategy.name}</div>
            <div className="mt-0.5 text-[10px] text-content-tertiary tabular-nums">
              {t(plural(locale, row.runs, "instruments.quantlab.runs.one", "instruments.quantlab.runs.other"), { n: row.runs })}
            </div>
          </button>
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {!report && (
          <div className="px-6 py-5 text-[12px] text-content-tertiary">
            {t("instruments.quantlab.noBacktest")}
          </div>
        )}
        {report && (
          <div className="px-6 py-5">
            <div className="flex items-baseline gap-3">
              <h2 className="font-baskerville text-[20px] text-content-primary">{report.strategy_name}</h2>
              <span className="text-[11px] text-content-tertiary tabular-nums">
                {t("instruments.quantlab.reportMeta", {
                  version: report.strategy_version,
                  variant: report.variant_number,
                  from: report.window.from,
                  to: report.window.to,
                })}
              </span>
              {reports.length > 1 && (
                <select
                  value={index}
                  onChange={(e) => setIndex(Number(e.target.value))}
                  className="ml-auto rounded border border-edge bg-white px-2 py-1 text-[11px] text-content-body"
                >
                  {reports.map((r, i) => (
                    <option key={r.report_id} value={i}>
                      {t("instruments.quantlab.variantOption", { variant: r.variant_number, date: r.created_at.slice(0, 10) })}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="mt-3 rounded-lg border border-edge bg-white px-4 py-3">
              <div className="text-[10px] font-medium tracking-[0.08em] text-content-tertiary">{t("instruments.quantlab.verdict")}</div>
              <p className="mt-1 font-baskerville text-[15px] leading-relaxed text-content-primary">{report.verdict}</p>
            </div>

            {[report.variant_warning, report.overfit_warning, report.split_warning]
              .filter((w): w is string => Boolean(w))
              .map((warning) => (
                <div
                  key={warning}
                  className="mt-2 rounded-lg border border-edge-strong bg-surface-2 px-4 py-2 text-[12px] text-tone-warning-muted"
                >
                  {warning}
                </div>
              ))}
            {report.created_after_oos_view && (
              <div className="mt-2 rounded-lg border border-edge-strong bg-surface-2 px-4 py-2 text-[12px] text-tone-warning-muted">
                {t("instruments.quantlab.createdAfterOos")}
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
              className="mt-5 flex items-center gap-1.5 text-[10px] font-medium tracking-[0.08em] text-content-tertiary hover:text-content-secondary"
            >
              {showDetail ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {t("instruments.quantlab.detailed")}
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
                <div className="text-[10px] font-medium tracking-[0.08em] text-content-tertiary">{t("instruments.quantlab.excluded")}</div>
                <div className="mt-1 text-[12px] text-content-secondary">
                  {Object.entries(
                    report.excluded.reduce<Record<string, string[]>>((acc, e) => {
                      (acc[e.reason] ??= []).push(e.ticker);
                      return acc;
                    }, {}),
                  ).map(([reason, tickers]) => (
                    <div key={reason} className="mt-1">
                      <span className="text-content-body">{reason}</span> ({tickers.length}): {tickers.join(" ")}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-5">
              <div className="text-[10px] font-medium tracking-[0.08em] text-content-tertiary">{t("instruments.quantlab.caveats")}</div>
              <ul className="mt-1 space-y-1">
                {report.caveats.map((c) => (
                  <li key={c} className="flex gap-2 text-[12px] text-content-secondary">
                    <span className="select-none text-content-disabled">·</span>
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

const SAMPLE_LABEL: Record<SampleStats["label"], MessageKey> = {
  in_sample: "instruments.quantlab.sample.inSample",
  out_of_sample: "instruments.quantlab.sample.outOfSample",
  full: "instruments.quantlab.sample.full",
};

function SampleBlock({ sample, highlight }: { sample: SampleStats; highlight?: boolean }) {
  const t = useT();
  const key = SAMPLE_LABEL[sample.label];
  const label = key ? t(key) : String(sample.label).replace(/_/g, "-").toUpperCase();
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        highlight ? "border-content-primary/20 bg-white" : "border-edge bg-surface-2"
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-medium tracking-[0.08em] text-content-tertiary">{label}</span>
        <span className="text-[10px] text-content-disabled tabular-nums">
          {sample.from} → {sample.to}
        </span>
      </div>
      <table className="mt-2 w-full text-[11px] tabular-nums">
        <thead>
          <tr className="text-content-tertiary">
            <th className="text-left font-normal">{t("instruments.quantlab.col.hold")}</th>
            <th className="text-right font-normal">n</th>
            <th className="text-right font-normal">{t("instruments.quantlab.col.median")}</th>
            <th className="text-right font-normal">{t("instruments.quantlab.col.base")}</th>
            <th className="text-right font-normal">{t("instruments.quantlab.col.hit")}</th>
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
  const t = useT();
  if (h.insufficient) {
    return (
      <tr className="border-t border-edge-subtle text-content-tertiary">
        <td className="py-1 text-left">{t("instruments.quantlab.days", { n: h.sessions })}</td>
        <td className="text-right">{h.n}</td>
        <td colSpan={7} className="py-1 pl-3 text-left italic">
          {t("instruments.quantlab.insufficient")}
        </td>
      </tr>
    );
  }
  const beats = beatsBaseRate(h);
  const edge = edgeOf(h);
  return (
    <tr className="border-t border-edge-subtle text-content-body">
      <td className="py-1 text-left">{t("instruments.quantlab.days", { n: h.sessions })}</td>
      <td className="text-right">{h.n}</td>
      <td
        className={`text-right ${beats === true ? "text-tone-positive" : beats === false ? "text-content-tertiary" : ""}`}
        title={edge != null ? t("instruments.quantlab.edgeHint", { value: pct(edge) }) : undefined}
      >
        {pct(h.median)}
      </td>
      <td className="text-right text-content-tertiary">{pct(h.base_rate_median)}</td>
      <td className="text-right">{pctPlain(h.hit_rate)}</td>
      <td className="text-right">{ratio(h.sharpe)}</td>
      <td className="text-right">{ratio(h.sortino)}</td>
      <td className="text-right">{pct(h.max_drawdown)}</td>
      <td className="text-right text-content-tertiary">
        {h.ci_low == null ? na() : `${pct(h.ci_low)} … ${pct(h.ci_high)}`}
      </td>
    </tr>
  );
}

/** The distribution as a bar row — central tendency alone hides the tails. */
function Deciles({ horizon }: { horizon: HorizonStats }) {
  const t = useT();
  const max = Math.max(...horizon.deciles.map((d) => Math.abs(d)), 1e-9);
  return (
    <div className="mt-5">
      <div className="text-[10px] font-medium tracking-[0.08em] text-content-tertiary">
        {t("instruments.quantlab.distribution", { horizon: t("instruments.quantlab.days", { n: horizon.sessions }) })}
      </div>
      <div className="mt-2 flex items-end gap-1">
        {horizon.deciles.map((d, i) => (
          <div key={i} className="flex flex-1 flex-col items-center gap-1">
            <div className="flex h-16 w-full items-end justify-center">
              <div
                className={`w-full rounded-sm ${d >= 0 ? "bg-tone-teal-fill" : "bg-tone-negative-fill"}`}
                style={{ height: `${Math.max(2, (Math.abs(d) / max) * 100)}%` }}
              />
            </div>
            <span className="text-[9px] text-content-tertiary tabular-nums">{pct(d, 1)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
