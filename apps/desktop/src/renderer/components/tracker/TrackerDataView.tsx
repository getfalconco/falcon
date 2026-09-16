import { useEffect, useMemo, useState } from "react";
import { ExcelTable } from "@/components/ui/excel-style-table";
import type {
  TrackerDailyBar,
  TrackerQuantContext,
  TrackerTickerState,
} from "../../../shared/tracker-types";

/**
 * Raw-data browser: every series the engine holds for a ticker, shown as it is
 * stored. Nothing is summarized away or hidden behind the message stream.
 */

type Section =
  | "quant"
  | "bars"
  | "news"
  | "filings"
  | "insiders"
  | "earnings"
  | "detectors"
  | "raw";

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: "quant", label: "Quant state" },
  { key: "bars", label: "Price bars" },
  { key: "news", label: "News" },
  { key: "filings", label: "Filings" },
  { key: "insiders", label: "Insiders" },
  { key: "earnings", label: "Earnings" },
  { key: "detectors", label: "Detectors" },
  { key: "raw", label: "Raw JSON" },
];

const num = (v: number | null | undefined, d = 4) =>
  v == null ? "—" : Number(v).toFixed(d);
const pct = (v: number | null | undefined, d = 2) =>
  v == null ? "—" : `${(v * 100).toFixed(d)}%`;
const int = (v: number | null | undefined) =>
  v == null ? "—" : Math.round(v).toLocaleString();

function Table({
  headers,
  rows,
  empty,
  title,
  exportName,
}: {
  headers: string[];
  rows: Array<Array<string | number>>;
  empty: string;
  /** Toolbar heading for this grid. */
  title: string;
  /** Base name for the CSV export. */
  exportName: string;
}) {
  if (rows.length === 0) {
    return <div className="py-6 text-center font-mono text-[11px] text-[#a3a39c]">{empty}</div>;
  }
  // Tracker data is measured, not authored — the grid is read-only on purpose.
  return (
    <ExcelTable
      title={title}
      exportName={exportName}
      headers={headers}
      data={rows.map((row) => row.map((cell) => String(cell)))}
      editable={false}
    />
  );
}

function QuantSection({
  quant,
  state,
}: {
  quant: TrackerQuantContext | null;
  state: TrackerTickerState;
}) {
  if (!quant) {
    return (
      <div className="py-6 text-center font-mono text-[11px] text-[#a3a39c]">
        computing live quant state…
      </div>
    );
  }
  const rows: Array<[string, string, string]> = [
    ["beta_90d", num(quant.beta_90d, 3), "OLS slope vs benchmark, 90 trading days"],
    ["r_squared", num(quant.r_squared, 3), "fit of the beta regression"],
    ["daily_vol_30d", num(quant.daily_vol_30d, 5), "1.4826 × MAD of 30d returns"],
    ["vol_regime", num(quant.vol_regime, 3), "vol_30d ÷ vol_90d"],
    ["move_today", pct(quant.move_today), "vs previous session close"],
    ["move_zscore", num(quant.move_zscore, 3), "move ÷ daily_vol_30d"],
    ["residual_move", pct(quant.residual_move), "move − beta × benchmark move"],
    ["residual_zscore", num(quant.residual_zscore, 3), "residual ÷ robust σ of residuals"],
    [
      "volume_ratio",
      quant.volume_ratio == null
        ? "—"
        : `${num(quant.volume_ratio, 2)}${quant.volume_ratio_partial ? " (partial)" : ""}`,
      "vs median 20-day volume",
    ],
    ["momentum_5d", pct(quant.momentum_5d), "trailing 5 trading days"],
    ["momentum_20d", pct(quant.momentum_20d), "trailing 20 trading days"],
    ["momentum_60d", pct(quant.momentum_60d), "trailing 60 trading days"],
    ["pct_from_52w_high", pct(quant.pct_from_52w_high), "252-day window"],
    ["pct_from_52w_low", pct(quant.pct_from_52w_low), "252-day window"],
    ["earnings_rhythm", pct(quant.earnings_rhythm), "mean |1-day move| over last 4 earnings"],
    ["prev_close", num(quant.prev_close, 2), "baseline for move_today"],
    ["last_price", num(quant.last_price, 2), "live quote or latest bar close"],
    ["price_asof", quant.price_asof ?? "—", "timestamp of last_price"],
    ["session", quant.session, "NY session at price_asof"],
  ];
  return (
    <>
      <div className="mb-2 font-mono text-[10px] text-[#a3a39c]">
        cik {state.cik ?? "—"} · backfilled {state.backfilledAt ?? "not yet"} · bars through{" "}
        {state.barsAsOf ?? "—"} · stored quant as of {state.quantAsOf ?? "not computed"} · “—”
        means not computable, never zero
      </div>
      <Table
        title="Quant state"
            exportName={`${state.ticker}-quant`}
            headers={["field", "value", "definition"]}
        rows={rows.map(([a, b, c]) => [a, b, c])}
        empty=""
      />
    </>
  );
}

export default function TrackerDataView({ ticker }: { ticker: string }) {
  const [state, setState] = useState<TrackerTickerState | null>(null);
  const [quant, setQuant] = useState<TrackerQuantContext | null>(null);
  const [dataDir, setDataDir] = useState<string>("");
  const [section, setSection] = useState<Section>("quant");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setQuant(null);
    setError(null);

    void window.meridian?.getTrackerTickerState(ticker).then((res) => {
      if (cancelled) return;
      if (res?.ok) {
        setState(res.state);
        setDataDir(res.dataDir);
      } else {
        setError(res?.error ?? "tracker bridge unavailable");
      }
    });
    void window.meridian?.getTrackerQuant(ticker).then((res) => {
      if (!cancelled && res?.ok) setQuant(res.quant);
    });

    return () => {
      cancelled = true;
    };
  }, [ticker]);

  const newsDays = useMemo(() => {
    if (!state) return [] as Array<[string, number]>;
    return Object.entries(state.newsCounts).sort((a, b) => b[0].localeCompare(a[0]));
  }, [state]);

  if (error) {
    return (
      <div className="py-8 text-center font-mono text-[11px] text-[#b45309]">{error}</div>
    );
  }
  if (!state) {
    return (
      <div className="py-8 text-center font-mono text-[11px] text-[#a3a39c]">loading {ticker}…</div>
    );
  }

  const recentBars: TrackerDailyBar[] = [...state.bars].reverse();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-[#eeeee8] pb-2">
        {SECTIONS.map((s) => {
          const count =
            s.key === "bars"
              ? state.bars.length
              : s.key === "news"
                ? state.newsTimestamps.length
                : s.key === "filings"
                  ? state.filings.length
                  : s.key === "insiders"
                    ? state.insiderTxns.length
                    : s.key === "earnings"
                      ? state.earnings.length + state.scheduledEarnings.length
                      : null;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setSection(s.key)}
              className={`rounded px-2 py-1 text-[11px] transition-colors ${
                section === s.key
                  ? "bg-[#1d1b1b] text-white"
                  : "text-[#6b7280] hover:bg-[#efefe9] hover:text-[#1d1b1b]"
              }`}
            >
              {s.label}
              {count != null && (
                <span className={section === s.key ? "text-white/60" : "text-[#a3a39c]"}>
                  {" "}
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-auto pt-2">
        {section === "quant" && <QuantSection quant={quant} state={state} />}

        {section === "bars" && (
          <Table
            title="Price bars (adjusted)"
            exportName={`${state.ticker}-bars`}
            headers={["date", "open", "high", "low", "close", "volume"]}
            rows={recentBars.map((b) => [
              b.d,
              num(b.o, 2),
              num(b.h, 2),
              num(b.l, 2),
              num(b.c, 2),
              int(b.v),
            ])}
            empty="no bars"
          />
        )}

        {section === "news" && (
          <>
            <div className="mb-2 font-mono text-[10px] text-[#a3a39c]">
              {state.seenArticleIds.length} article ids seen · {state.newsTimestamps.length}{" "}
              timestamps retained · baseline window covers {newsDays.length} trading days
            </div>
            <Table
              title="News counts per trading day"
            exportName={`${state.ticker}-news-counts`}
            headers={["trading day", "articles"]}
              rows={newsDays.map(([day, count]) => [day, count])}
              empty="no news counts"
            />
          </>
        )}

        {section === "filings" && (
          <Table
            title="Filings"
            exportName={`${state.ticker}-filings`}
            headers={["filed", "form", "items", "period", "accepted", "accession"]}
            rows={[...state.filings]
              .sort((a, b) => b.filedAt.localeCompare(a.filedAt))
              .map((f) => [
                f.filedAt,
                f.form,
                f.items.join(", ") || "—",
                f.reportDate ?? "—",
                f.acceptedAt ?? "—",
                f.accessionNumber,
              ])}
            empty="no filings"
          />
        )}

        {section === "insiders" && (
          <Table
            title="Insider transactions"
            exportName={`${state.ticker}-insiders`}
            headers={["txn date", "filed", "insider", "role", "code", "10b5-1", "shares", "value", "dir"]}
            rows={[...state.insiderTxns]
              .sort((a, b) => b.filedAt.localeCompare(a.filedAt))
              .map((t) => [
                t.transactionDate ?? "—",
                t.filedAt.slice(0, 10),
                t.insiderName,
                t.role,
                t.transactionCode || "—",
                t.is10b51Plan ? "yes" : "no",
                int(t.shares),
                t.value == null ? "—" : `$${int(t.value)}`,
                t.direction ?? "—",
              ])}
            empty="no Form 4 transactions in the tracked window"
          />
        )}

        {section === "earnings" && (
          <>
            <div className="mb-1 font-mono text-[10px] text-[#8b8b86]">
              Reported (from 8-K item 2.02 acceptance times)
            </div>
            <Table
              title="Reported earnings"
            exportName={`${state.ticker}-earnings-reported`}
            headers={["date", "fiscal period", "timing"]}
              rows={state.earnings.map((e) => [e.date, e.fiscalPeriod, e.hour ?? "—"])}
              empty="no reported earnings recorded"
            />
            <div className="mb-1 mt-4 font-mono text-[10px] text-[#8b8b86]">
              Scheduled (earnings calendar)
            </div>
            <Table
              title="Scheduled earnings"
            exportName={`${state.ticker}-earnings-scheduled`}
            headers={["due at", "fiscal period"]}
              rows={state.scheduledEarnings.map((e) => [e.dueAt, e.fiscalPeriod])}
              empty="none announced"
            />
          </>
        )}

        {section === "detectors" && (
          <>
            <div className="mb-1 font-mono text-[10px] text-[#8b8b86]">
              Snapshot detectors — fire once per trading day unless escalated
            </div>
            <Table
              title="Snapshot detectors"
            exportName={`${state.ticker}-detectors-snapshot`}
            headers={["detector", "last fired day", "last value"]}
              rows={(
                [
                  ["gap", state.detectors.gap],
                  ["volume", state.detectors.volume],
                  ["unexplained_move", state.detectors.unexplained],
                ] as const
              ).map(([name, d]) => [name, d.lastFiredDay ?? "never", num(d.lastFiredValue, 3)])}
              empty=""
            />
            <div className="mb-1 mt-4 font-mono text-[10px] text-[#8b8b86]">
              Edge-triggered detectors — fire on the false→true transition
            </div>
            <Table
              title="Edge-triggered detectors"
            exportName={`${state.ticker}-detectors-edge`}
            headers={["detector", "active", "last fired", "last value", "false since"]}
              rows={(
                [
                  ["silence", state.detectors.silence],
                  ["filing_overdue", state.detectors.filingOverdue],
                  ["drift", state.detectors.drift],
                  ["news_burst", state.detectors.newsBurst],
                  ["insider_cluster", state.detectors.insiderCluster],
                ] as const
              ).map(([name, d]) => [
                name,
                d.active ? "yes" : "no",
                d.lastFiredAt ?? "never",
                num(d.lastFiredValue, 3),
                d.falseSinceDay ?? "—",
              ])}
              empty=""
            />
            <div className="mb-1 mt-4 font-mono text-[10px] text-[#8b8b86]">
              Evaluation bookkeeping
            </div>
            <Table
              title="Evaluation bookkeeping"
            exportName={`${state.ticker}-bookkeeping`}
            headers={["field", "value"]}
              rows={[
                ["lastGapCheckedFor", state.lastGapCheckedFor ?? "—"],
                ["lastCloseComputedFor", state.lastCloseComputedFor ?? "—"],
              ]}
              empty=""
            />
          </>
        )}

        {section === "raw" && (
          <>
            <div className="mb-2 font-mono text-[10px] text-[#a3a39c]">
              on disk: {dataDir}\state\{state.ticker}.json
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded border border-[#eeeee8] bg-white p-2 font-mono text-[10px] leading-relaxed text-[#3f3f46]">
              {JSON.stringify(state, null, 1)}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
