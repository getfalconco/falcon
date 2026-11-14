"use client";

import { useMemo, useState } from "react";
import { HYPOTHETICAL, type QualityReport, type RunResultV2, type TradeV2 } from "@falcon/backtest";
import type { AuditState, ReviewState } from "@/lib/workspace/strategies";
import { MONO, Panel, SERIF, SectionTitle, formatDate } from "../parts";
import { ChartLegend, EquityChart, pct, type ChartSeries } from "./EquityChart";

const INK = "#1d1b1b";
const SPY_COLOR = "#a3a39e";
const EW_COLOR = "#2a78d6";
const DD_COLOR = "#b3432f";

const EXIT_LABEL: Record<TradeV2["exitReason"], string> = {
  signal: "Exit rule",
  stop_loss: "Stop loss",
  trailing_stop: "Trailing stop",
  take_profit: "Take profit",
  max_holding: "Holding days",
  rebalance: "Rebalance",
  end: "End of test",
};

function series(values: number[], dates: string[], base: number): Map<string, number> {
  const m = new Map<string, number>();
  values.forEach((v, i) => m.set(dates[i]!, (v / (base || 1) - 1) * 100));
  return m;
}

function drawdown(values: number[], dates: string[]): Map<string, number> {
  const m = new Map<string, number>();
  let peak = -Infinity;
  values.forEach((v, i) => {
    peak = Math.max(peak, v);
    m.set(dates[i]!, peak > 0 ? (v / peak - 1) * 100 : 0);
  });
  return m;
}

const num = (v: unknown, d = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "n/a");

/** The evidence label first (design 6.5), then curves, key numbers, flags, years, trades, provenance. */
export function ResultsV2({
  name,
  result,
  stale,
  audit,
  review,
  onExplain,
}: {
  name: string;
  result: RunResultV2;
  stale: boolean;
  audit: AuditState | null;
  review: ReviewState | null;
  onExplain: (quality: QualityReport) => void;
}) {
  const quality = audit?.status === "done" ? audit.quality : result.quality;
  const v = quality.values;
  const dates = result.dates;
  const curves = result.curves;

  const chart: ChartSeries[] = useMemo(() => {
    if (!curves) return [];
    const cap = result.spec.capital;
    const out: ChartSeries[] = [{ id: "self", label: name, color: INK, values: series(curves.strategy, dates, cap) }];
    if (curves.equalWeight) out.push({ id: "ew", label: "Same list, equal weight, held", color: EW_COLOR, weight: 1.5, values: series(curves.equalWeight, dates, cap) });
    out.push({ id: "spy", label: "SPY held throughout", color: SPY_COLOR, weight: 1.5, values: series(curves.benchmark, dates, cap) });
    return out;
  }, [curves, dates, name, result.spec.capital]);
  const dd: ChartSeries[] = useMemo(() => (curves ? [{ id: "dd", label: "Fall from the previous high", color: DD_COLOR, weight: 1.5, values: drawdown(curves.strategy, dates) }] : []), [curves, dates]);

  return (
    <section className={`flex flex-col gap-5 transition-opacity ${stale ? "opacity-60" : ""}`} aria-live="polite">
      <Evidence quality={quality} stale={stale} result={result} />

      {curves ? (
        <>
          <Panel className="px-5 py-4">
            <ChartLegend series={chart} last={dates[dates.length - 1]} />
            <div className="mt-3">
              <EquityChart dates={dates} series={chart} />
            </div>
            <div className="mt-4 border-t border-black/[0.06] pt-3">
              <span className="text-[12px] text-[#767676]">Drawdown: fall from the previous high</span>
              <div className="mt-1">
                <EquityChart dates={dates} series={dd} height={120} />
              </div>
            </div>
          </Panel>
          <KeyNumbers result={result} quality={quality} />
        </>
      ) : null}

      {result.eventStudy ? <EventStudyView result={result} /> : null}

      <Flags quality={quality} audit={audit} />

      <ExplainBox review={review} onExplain={() => onExplain(quality)} />

      {result.yearly.length ? <Years result={result} /> : null}
      {result.trades.length ? <Trades trades={result.trades} /> : null}

      <footer className="flex flex-col gap-2 border-t border-black/[0.06] pt-4 text-[12px] leading-[18px] text-[#9a9a9a]">
        {result.warnings.map((w) => (
          <p key={w}>{w}</p>
        ))}
        {result.caveats.map((c) => (
          <p key={c}>{c}</p>
        ))}
        <details>
          <summary className="cursor-pointer select-none text-[#767676] outline-none hover:text-[#1d1b1b] focus-visible:underline">How the simulation fills orders, and provenance</summary>
          <ul className="mt-1.5 flex flex-col gap-1">
            {result.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
            <li>
              Prices: {result.sources.prices}
              {result.sources.earnings ? `; earnings: ${result.sources.earnings}` : ""}
              {result.sources.rates ? `; cash rate: ${result.sources.rates}` : ""}.
              {result.provenance.betaSource ? " Beta data source, not reproducible." : ""}
            </li>
            <li style={{ fontFamily: MONO }}>
              spec {result.provenance.specHash} · engine {result.provenance.engine} · trial {result.provenance.trial}
              {typeof v.multiple?.dsr === "number" ? ` · DSR ${num(v.multiple.dsr)}` : ""}
            </li>
          </ul>
        </details>
      </footer>
    </section>
  );
}

function Evidence({ quality, stale, result }: { quality: QualityReport; stale: boolean; result: RunResultV2 }) {
  const level = quality.label.level;
  const tone = level === "consistent" ? "border-black/40" : level === "some" ? "border-black/25" : "border-black/12";
  return (
    <Panel className={`border-l-[3px] px-5 py-4 ${tone}`}>
      <span className="text-[11px] uppercase tracking-[0.16em] text-[#1d1b1b]/50" style={{ fontFamily: MONO }}>
        {quality.label.heading}
      </span>
      <p className="mt-1 text-[24px] leading-[32px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
        {quality.label.title}
      </p>
      {quality.label.reasons.length ? <p className="mt-1 text-[12.5px] leading-[19px] text-[#4b4b48]">{quality.label.reasons.join(" ")}</p> : null}
      <p className="mt-2 text-[11.5px] leading-[17px] text-[#767676]">{quality.label.subtitle}</p>
      <p className="mt-1 text-[11.5px] leading-[17px] text-[#767676]">
        {HYPOTHETICAL} {formatDate(`${result.period.start}T12:00:00Z`)} to {formatDate(`${result.period.end}T12:00:00Z`)}, {result.period.sessions.toLocaleString("en-US")} sessions.
        {stale ? " The rules changed since this run." : ""}
      </p>
    </Panel>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11.5px] text-[#767676]">{label}</span>
      <span className="text-[16px] tabular-nums text-[#1d1b1b]" style={{ fontFamily: MONO }}>
        {value}
      </span>
      {sub ? <span className="text-[11px] leading-[15px] text-[#9a9a9a]">{sub}</span> : null}
    </div>
  );
}

function KeyNumbers({ result, quality }: { result: RunResultV2; quality: QualityReport }) {
  const m = result.metrics;
  const v = quality.values;
  const range = typeof v.active?.range_lo === "number" ? `90% range ${pct(v.active.range_lo as number)} to ${pct(v.active.range_hi as number)}` : undefined;
  return (
    <Panel className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-3">
      <Stat label={`Active return a year vs ${result.benchmark.ticker === "EW" ? "the list" : "SPY"}`} value={pct(m.activeAnnualPct, 2)} sub={range} />
      <Stat label="Max drawdown" value={m.strategy.maxDrawdownPct > 0 ? `-${m.strategy.maxDrawdownPct.toFixed(1)}%` : "0.0%"} sub={`SPY ${m.benchmark.maxDrawdownPct > 0 ? `-${m.benchmark.maxDrawdownPct.toFixed(1)}%` : "0.0%"}`} />
      <Stat label="Annual return" value={pct(m.strategy.annualizedReturnPct)} sub={`SPY ${pct(m.benchmark.annualizedReturnPct)}${m.equalWeight ? `, list ${pct(m.equalWeight.annualizedReturnPct)}` : ""}`} />
      <Stat label="Trades" value={m.tradeCount.toLocaleString("en-US")} sub={m.winRatePct !== null ? `${m.winRatePct.toFixed(0)}% closed above entry` : undefined} />
      <Stat label="Time invested" value={`${m.exposurePct.toFixed(0)}%`} sub={`Turnover ${m.turnoverAnnual.toFixed(1)}x a year`} />
      <Stat
        label="Sharpe over T-bills"
        value={m.strategy.sharpeRf === null ? "n/a" : m.strategy.sharpeRf.toFixed(2)}
        sub={typeof v.costs?.break_even_bps === "number" ? `Break-even cost about ${num(v.costs.break_even_bps, 1)} bp` : undefined}
      />
    </Panel>
  );
}

function Flags({ quality, audit }: { quality: QualityReport; audit: AuditState | null }) {
  return (
    <section>
      <SectionTitle count={quality.flags.length}>Flags</SectionTitle>
      <Panel className="mt-2 px-5 py-3">
        {quality.flags.length ? (
          <ul className="flex flex-col gap-2">
            {quality.flags.map((f) => (
              <li key={f.check_id} className="flex gap-2.5 text-[12.5px] leading-[19px] text-[#2d2b2a]">
                <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${f.severity === "high" ? "bg-[#b3432f]" : "bg-[#c9a227]"}`} aria-hidden />
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-[#4b4b48]">No check raised a flag.</p>
        )}
        <p className="mt-2 text-[11.5px] text-[#9a9a9a]" role="status">
          {audit?.status === "running"
            ? "More checks are running: random strategies, nearby parameters, leaving out each ticker, market regimes."
            : audit?.status === "error"
              ? `Extra checks: ${audit.message}`
              : audit?.status === "done"
                ? "Extra checks included."
                : ""}
        </p>
        <details className="mt-2">
          <summary className="cursor-pointer select-none text-[12px] text-[#767676] outline-none hover:text-[#1d1b1b] focus-visible:underline">All checks</summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {quality.checks.map((c) => (
              <li key={`${c.id}-${c.tier}`} className="grid grid-cols-[110px_minmax(0,1fr)] gap-2 text-[12px] leading-[18px]">
                <span className="text-[#767676]">
                  {c.name} <span className="text-[#b0b0ab]">{c.status === "pass" ? "ok" : c.status}</span>
                </span>
                <span className="text-[#4b4b48]">{c.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      </Panel>
    </section>
  );
}

function ExplainBox({ review, onExplain }: { review: ReviewState | null; onExplain: () => void }) {
  return (
    <section>
      <SectionTitle
        action={
          <button
            type="button"
            onClick={onExplain}
            disabled={review?.status === "running"}
            className="inline-flex h-7 items-center rounded-md border border-black/10 px-2.5 text-[12px] text-[#1d1b1b] outline-none hover:bg-[#efefec] focus-visible:border-black/45 disabled:opacity-40"
          >
            {review?.status === "running" ? "Explaining" : review?.status === "done" ? "Explain again" : "Explain"}
          </button>
        }
      >
        Explain
      </SectionTitle>
      {review?.status === "done" ? (
        <Panel className="mt-2 flex flex-col gap-3 px-5 py-4 text-[12.5px] leading-[19px] text-[#2d2b2a]">
          <p className="text-[13.5px] text-[#1d1b1b]">{review.review.headline}</p>
          {review.review.flags.length ? (
            <ul className="flex flex-col gap-2">
              {review.review.flags.map((f) => (
                <li key={f.check_id}>
                  {f.meaning}
                  {f.tryNext ? <span className="text-[#767676]"> {f.tryNext}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {review.review.interpretationRisks.length ? (
            <div>
              <span className="text-[12px] text-[#767676]">Where the rules may differ from your words</span>
              <ul className="mt-1 list-disc pl-4">
                {review.review.interpretationRisks.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {review.review.nextExperiments.length ? (
            <div>
              <span className="text-[12px] text-[#767676]">Experiments that would test it (each costs 1 trial)</span>
              <ul className="mt-1 list-disc pl-4">
                {review.review.nextExperiments.map((e) => (
                  <li key={e.change}>
                    {e.change} <span className="text-[#767676]">{e.why}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-[11px] text-[#9a9a9a]">Written by {review.review.model} from the checks above; every number is filled in by Falcon.</p>
        </Panel>
      ) : review?.status === "error" ? (
        <p className="mt-2 text-[12px] text-[#b3432f]">{review.message}</p>
      ) : (
        <p className="mt-1 text-[12px] text-[#9a9a9a]">A plain-language walk-through of the flags, written from the checks. Optional.</p>
      )}
    </section>
  );
}

function Years({ result }: { result: RunResultV2 }) {
  return (
    <section>
      <SectionTitle>Years</SectionTitle>
      <Panel className="mt-2 overflow-x-auto px-5 py-3">
        <table className="w-full min-w-[420px] text-right text-[12.5px] tabular-nums" style={{ fontFamily: MONO }}>
          <thead className="text-[11.5px] text-[#767676]">
            <tr>
              <th className="py-1 text-left font-normal">Year</th>
              <th className="font-normal">Strategy</th>
              <th className="font-normal">SPY</th>
              {result.yearly[0]?.equalWeightPct !== null ? <th className="font-normal">List</th> : null}
              <th className="font-normal">Active</th>
            </tr>
          </thead>
          <tbody>
            {result.yearly.map((y) => (
              <tr key={y.year} className="border-t border-black/[0.05]">
                <td className="py-1 text-left text-[#4b4b48]">{y.year}</td>
                <td>{pct(y.strategyPct)}</td>
                <td className="text-[#767676]">{pct(y.benchmarkPct)}</td>
                {y.equalWeightPct !== null ? <td className="text-[#767676]">{pct(y.equalWeightPct)}</td> : null}
                <td>{pct(y.activePct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </section>
  );
}

function Trades({ trades }: { trades: TradeV2[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? trades : trades.slice(-60).reverse();
  return (
    <section>
      <SectionTitle count={trades.length}>Trades</SectionTitle>
      <Panel className="mt-2 overflow-x-auto px-5 py-3">
        <table className="w-full min-w-[520px] text-right text-[12px] tabular-nums" style={{ fontFamily: MONO }}>
          <thead className="text-[11.5px] text-[#767676]">
            <tr>
              <th className="py-1 text-left font-normal">Ticker</th>
              <th className="text-left font-normal">Entry</th>
              <th className="text-left font-normal">Exit</th>
              <th className="font-normal">Return</th>
              <th className="font-normal">Sessions</th>
              <th className="font-normal">Why it exited</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t, i) => (
              <tr key={`${t.ticker}-${t.entryDate}-${i}`} className="border-t border-black/[0.05]">
                <td className="py-1 text-left text-[#1d1b1b]">{t.ticker}</td>
                <td className="text-left text-[#4b4b48]">{t.entryDate}</td>
                <td className="text-left text-[#4b4b48]">{t.exitDate}</td>
                <td>{pct(t.returnPct)}</td>
                <td>{t.sessionsHeld}</td>
                <td className="text-[#767676]">{EXIT_LABEL[t.exitReason]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {trades.length > 60 ? (
          <button type="button" onClick={() => setAll((a) => !a)} className="mt-2 text-[12px] text-[#4b4b48] underline decoration-black/20 underline-offset-2">
            {all ? "Show the latest 60" : `Show all ${trades.length.toLocaleString("en-US")} (oldest first)`}
          </button>
        ) : null}
      </Panel>
    </section>
  );
}

function EventStudyView({ result }: { result: RunResultV2 }) {
  const s = result.eventStudy!;
  return (
    <section>
      <SectionTitle count={s.events.length}>Event study</SectionTitle>
      <Panel className="mt-2 overflow-x-auto px-5 py-3">
        <table className="w-full min-w-[520px] text-right text-[12px] tabular-nums" style={{ fontFamily: MONO }}>
          <thead className="text-[11.5px] text-[#767676]">
            <tr>
              <th className="py-1 text-left font-normal">Sessions</th>
              <th className="font-normal">Events (N)</th>
              <th className="font-normal">Dates (G)</th>
              <th className="font-normal">Measured</th>
              <th className="font-normal">Tradable</th>
              <th className="font-normal">Dates up</th>
              <th className="font-normal">t</th>
            </tr>
          </thead>
          <tbody>
            {s.windows.map((w) => (
              <tr key={w.window} className="border-t border-black/[0.05]">
                <td className="py-1 text-left">{w.window}</td>
                <td>{w.n}</td>
                <td>{w.g}</td>
                <td>{pct(w.meanPct, 2)}</td>
                <td>{pct(w.tradableMeanPct, 2)}</td>
                <td>
                  {w.datesUp} of {w.g}
                </td>
                <td>{num(w.t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11.5px] leading-[17px] text-[#9a9a9a]">
          Measured from the close before the event; tradable from the next open after it. {s.method}
        </p>
      </Panel>
    </section>
  );
}
