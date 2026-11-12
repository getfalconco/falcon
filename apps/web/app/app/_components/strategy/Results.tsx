"use client";

import { useMemo, useState } from "react";
import type { BacktestResult, CurveMetrics, ExitReason, StrategyMetrics, Trade } from "@falcon/backtest";
import { MONO, formatDate } from "../parts";
import { pct } from "./EquityChart";

export type MetricColumn = {
  id: string;
  label: string;
  color: string;
  dashed?: boolean;
  metrics: StrategyMetrics | CurveMetrics | null;
  /** Shown instead of numbers while this column runs or after it failed. */
  status?: string;
};

const isStrategy = (m: StrategyMetrics | CurveMetrics): m is StrategyMetrics => "tradeCount" in m;

const ROWS: { label: string; hint?: string; value: (m: StrategyMetrics | CurveMetrics) => string }[] = [
  { label: "Total return", value: (m) => pct(m.totalReturnPct) },
  { label: "Annual return", hint: "Compound annual growth", value: (m) => pct(m.annualizedReturnPct) },
  { label: "Sharpe", hint: "Daily returns, 0% risk-free rate", value: (m) => (m.sharpe === null ? "n/a" : m.sharpe.toFixed(2)) },
  { label: "Max drawdown", hint: "Largest fall from a peak", value: (m) => (m.maxDrawdownPct > 0 ? `-${m.maxDrawdownPct.toFixed(1)}%` : "0.0%") },
  { label: "Win rate", hint: "Trades that closed above their entry", value: (m) => (isStrategy(m) ? (m.winRatePct === null ? "n/a" : `${m.winRatePct.toFixed(0)}%`) : "") },
  { label: "Trades", value: (m) => (isStrategy(m) ? m.tradeCount.toLocaleString("en-US") : "") },
  { label: "Time invested", hint: "Sessions with a position open", value: (m) => (isStrategy(m) ? `${m.exposurePct.toFixed(0)}%` : "100%") },
];

function Swatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <svg width="14" height="6" aria-hidden className="shrink-0">
      <line x1="1" x2="13" y1="3" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "3 2" : undefined} strokeLinecap="round" />
    </svg>
  );
}

/** Strategy, compared strategies and SPY side by side, one row per metric. */
export function MetricsTable({ columns }: { columns: MetricColumn[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[460px] border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-black/[0.08]">
            <th scope="col" className="py-2 pr-3 text-left font-normal text-[#9a9a9a]">
              <span className="sr-only">Metric</span>
            </th>
            {columns.map((c) => (
              <th key={c.id} scope="col" className="max-w-[180px] py-2 pl-3 text-right font-normal text-[#4b4b48]">
                <span className="inline-flex max-w-full items-center justify-end gap-1.5">
                  <Swatch color={c.color} dashed={c.dashed} />
                  <span className="truncate" title={c.label}>
                    {c.label}
                  </span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.label} className="border-b border-black/[0.05] last:border-0">
              <th scope="row" className="py-2 pr-3 text-left font-normal text-[#767676]" title={row.hint}>
                {row.label}
              </th>
              {columns.map((c) => (
                <td key={c.id} className="py-2 pl-3 text-right tabular-nums text-[#1d1b1b]" style={{ fontFamily: MONO }}>
                  {c.metrics ? row.value(c.metrics) || <span className="text-[#c4c4c0]">-</span> : <span className="text-[#9a9a9a]">{c.status ?? ""}</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EXIT_LABEL: Record<ExitReason, string> = {
  signal: "Exit rule",
  stop_loss: "Stop loss",
  take_profit: "Take profit",
  max_holding: "Time limit",
  end: "End of test",
};

const money = (v: number) => `${v < 0 ? "-" : v > 0 ? "+" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const price = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type SortKey = "entry" | "return";

/** Every simulated trade, newest first; the first rows until expanded. */
export function TradesList({ result }: { result: BacktestResult }) {
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<SortKey>("entry");
  const trades = useMemo(() => {
    const t = [...result.trades];
    if (sort === "return") t.sort((a, b) => b.returnPct - a.returnPct);
    else t.sort((a, b) => (a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : a.ticker.localeCompare(b.ticker)));
    return t;
  }, [result.trades, sort]);
  const shown = open ? trades : trades.slice(0, 8);
  if (!trades.length) return <p className="py-3 text-[12.5px] text-[#9a9a9a]">No trades in this window.</p>;

  const head = (key: SortKey | null, label: string, align = "text-right") => (
    <th scope="col" className={`py-2 font-normal text-[#9a9a9a] ${align} pl-3 first:pl-0`} aria-sort={key && sort === key ? "descending" : undefined}>
      {key ? (
        <button type="button" onClick={() => setSort(key)} className={`outline-none hover:text-[#1d1b1b] focus-visible:underline ${sort === key ? "text-[#4b4b48]" : ""}`}>
          {label}
        </button>
      ) : (
        label
      )}
    </th>
  );

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-black/[0.08]">
              {head(null, "Ticker", "text-left")}
              {head("entry", "Entry")}
              {head(null, "Exit")}
              {head(null, "Days")}
              {head(null, "Entry price")}
              {head(null, "Exit price")}
              {head("return", "Return")}
              {head(null, "P&L")}
              {head(null, "Closed by", "text-left")}
            </tr>
          </thead>
          <tbody>
            {shown.map((t: Trade, i) => (
              <tr key={`${t.ticker}-${t.entryDate}-${i}`} className="border-b border-black/[0.05] last:border-0">
                <td className="py-1.5 text-left text-[#1d1b1b]" style={{ fontFamily: MONO }}>
                  {t.ticker}
                </td>
                <td className="py-1.5 pl-3 text-right tabular-nums text-[#4b4b48]">{formatDate(`${t.entryDate}T12:00:00Z`)}</td>
                <td className="py-1.5 pl-3 text-right tabular-nums text-[#4b4b48]">{formatDate(`${t.exitDate}T12:00:00Z`)}</td>
                <td className="py-1.5 pl-3 text-right tabular-nums text-[#4b4b48]">{t.sessionsHeld}</td>
                <td className="py-1.5 pl-3 text-right tabular-nums text-[#4b4b48]" style={{ fontFamily: MONO }}>
                  {price(t.entryPrice)}
                </td>
                <td className="py-1.5 pl-3 text-right tabular-nums text-[#4b4b48]" style={{ fontFamily: MONO }}>
                  {price(t.exitPrice)}
                </td>
                <td className="py-1.5 pl-3 text-right tabular-nums text-[#1d1b1b]" style={{ fontFamily: MONO }}>
                  {pct(t.returnPct)}
                </td>
                <td className="py-1.5 pl-3 text-right tabular-nums text-[#4b4b48]" style={{ fontFamily: MONO }}>
                  {money(t.pnl)}
                </td>
                <td className="py-1.5 pl-3 text-left text-[#767676]">{EXIT_LABEL[t.exitReason]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {trades.length > 8 ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="mt-2 inline-flex items-center text-[12px] text-[#4b4b48] underline decoration-black/20 underline-offset-2 outline-none hover:text-[#1d1b1b] focus-visible:decoration-black/60"
        >
          {open ? "Show fewer" : `Show all ${trades.length.toLocaleString("en-US")} trades`}
        </button>
      ) : null}
    </div>
  );
}
