import { na } from "@/lib/i18n/na";
import { useEffect, useMemo, useState } from "react";
import { ExcelTable } from "@/components/ui/excel-style-table";
import { useT, type MessageKey } from "@/lib/i18n";
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

const SECTIONS: Array<{ key: Section; label: MessageKey }> = [
  { key: "quant", label: "instruments.tracker.section.quant" },
  { key: "bars", label: "instruments.tracker.section.bars" },
  { key: "news", label: "instruments.tracker.section.news" },
  { key: "filings", label: "instruments.tracker.section.filings" },
  { key: "insiders", label: "instruments.tracker.section.insiders" },
  { key: "earnings", label: "instruments.tracker.section.earnings" },
  { key: "detectors", label: "instruments.tracker.section.detectors" },
  { key: "raw", label: "instruments.tracker.section.raw" },
];

const num = (v: number | null | undefined, d = 4) =>
  v == null ? na() : Number(v).toFixed(d);
const pct = (v: number | null | undefined, d = 2) =>
  v == null ? na() : `${(v * 100).toFixed(d)}%`;
const int = (v: number | null | undefined) =>
  v == null ? na() : Math.round(v).toLocaleString("en-US");

/** Error value for "the preload has no Tracker bridge"; rendered through t(). */
const BRIDGE_MISSING = "\u0000bridge-missing";

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
  const t = useT();
  if (!quant) {
    return (
      <div className="py-6 text-center font-mono text-[11px] text-[#a3a39c]">
        {t("instruments.tracker.computing")}
      </div>
    );
  }
  // Field names are the stored identifiers and stay as they are; formulas
  // (vol_30d ÷ vol_90d) read the same in every language.
  const rows: Array<[string, string, string]> = [
    ["beta_90d", num(quant.beta_90d, 3), t("instruments.tracker.def.beta")],
    ["r_squared", num(quant.r_squared, 3), t("instruments.tracker.def.r2")],
    ["daily_vol_30d", num(quant.daily_vol_30d, 5), t("instruments.tracker.def.vol30")],
    ["vol_regime", num(quant.vol_regime, 3), "vol_30d ÷ vol_90d"],
    ["move_today", pct(quant.move_today), t("instruments.tracker.def.moveToday")],
    ["move_zscore", num(quant.move_zscore, 3), "move ÷ daily_vol_30d"],
    ["residual_move", pct(quant.residual_move), "move − beta × benchmark move"],
    ["residual_zscore", num(quant.residual_zscore, 3), t("instruments.tracker.def.residualZ")],
    [
      "volume_ratio",
      quant.volume_ratio == null
        ? na()
        : `${num(quant.volume_ratio, 2)}${quant.volume_ratio_partial ? ` ${t("instruments.tracker.partial")}` : ""}`,
      t("instruments.tracker.def.volumeRatio"),
    ],
    ["momentum_5d", pct(quant.momentum_5d), t("instruments.tracker.def.trailing", { n: 5 })],
    ["momentum_20d", pct(quant.momentum_20d), t("instruments.tracker.def.trailing", { n: 20 })],
    ["momentum_60d", pct(quant.momentum_60d), t("instruments.tracker.def.trailing", { n: 60 })],
    ["pct_from_52w_high", pct(quant.pct_from_52w_high), t("instruments.tracker.def.window252")],
    ["pct_from_52w_low", pct(quant.pct_from_52w_low), t("instruments.tracker.def.window252")],
    ["earnings_rhythm", pct(quant.earnings_rhythm), t("instruments.tracker.def.rhythm")],
    ["prev_close", num(quant.prev_close, 2), t("instruments.tracker.def.prevClose")],
    ["last_price", num(quant.last_price, 2), t("instruments.tracker.def.lastPrice")],
    ["price_asof", quant.price_asof ?? na(), t("instruments.tracker.def.priceAsof")],
    ["session", quant.session, t("instruments.tracker.def.session")],
  ];
  return (
    <>
      <div className="mb-2 font-mono text-[10px] text-[#a3a39c]">
        {t("instruments.tracker.stateLine", {
          cik: state.cik ?? na(),
          backfilled: state.backfilledAt ?? t("instruments.tracker.notYet"),
          bars: state.barsAsOf ?? na(),
          quant: state.quantAsOf ?? t("instruments.tracker.notComputed"),
          dash: na(),
        })}
      </div>
      <Table
        title={t("instruments.tracker.section.quant")}
            exportName={`${state.ticker}-quant`}
            headers={[t("instruments.tracker.col.field"), t("instruments.tracker.col.value"), t("instruments.tracker.col.definition")]}
        rows={rows.map(([a, b, c]) => [a, b, c])}
        empty=""
      />
    </>
  );
}

export default function TrackerDataView({ ticker }: { ticker: string }) {
  const t = useT();
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
        setError(res?.error ?? BRIDGE_MISSING);
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
      <div className="py-8 text-center font-mono text-[11px] text-[#b45309]">
        {error === BRIDGE_MISSING ? t("instruments.common.bridgeUnavailable", { name: "Tracker" }) : error}
      </div>
    );
  }
  if (!state) {
    return (
      <div className="py-8 text-center font-mono text-[11px] text-[#a3a39c]">{t("instruments.tracker.loadingTicker", { ticker })}</div>
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
              {t(s.label)}
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
            title={t("instruments.tracker.barsTitle")}
            exportName={`${state.ticker}-bars`}
            headers={[
              t("instruments.tracker.col.date"),
              t("instruments.tracker.col.open"),
              t("instruments.tracker.col.high"),
              t("instruments.tracker.col.low"),
              t("instruments.tracker.col.close"),
              t("instruments.tracker.col.volume"),
            ]}
            rows={recentBars.map((b) => [
              b.d,
              num(b.o, 2),
              num(b.h, 2),
              num(b.l, 2),
              num(b.c, 2),
              int(b.v),
            ])}
            empty={t("instruments.tracker.noBars")}
          />
        )}

        {section === "news" && (
          <>
            <div className="mb-2 font-mono text-[10px] text-[#a3a39c]">
              {t("instruments.tracker.newsMeta", {
                ids: state.seenArticleIds.length,
                timestamps: state.newsTimestamps.length,
                days: newsDays.length,
              })}
            </div>
            <Table
              title={t("instruments.tracker.newsTitle")}
            exportName={`${state.ticker}-news-counts`}
            headers={[t("instruments.tracker.col.tradingDay"), t("instruments.tracker.col.articles")]}
              rows={newsDays.map(([day, count]) => [day, count])}
              empty={t("instruments.tracker.noNews")}
            />
          </>
        )}

        {section === "filings" && (
          <Table
            title={t("instruments.tracker.section.filings")}
            exportName={`${state.ticker}-filings`}
            headers={[
              t("instruments.tracker.col.filed"),
              t("instruments.tracker.col.form"),
              t("instruments.tracker.col.items"),
              t("instruments.tracker.col.period"),
              t("instruments.tracker.col.accepted"),
              t("instruments.tracker.col.accession"),
            ]}
            rows={[...state.filings]
              .sort((a, b) => b.filedAt.localeCompare(a.filedAt))
              .map((f) => [
                f.filedAt,
                f.form,
                f.items.join(", ") || na(),
                f.reportDate ?? na(),
                f.acceptedAt ?? na(),
                f.accessionNumber,
              ])}
            empty={t("instruments.tracker.noFilings")}
          />
        )}

        {section === "insiders" && (
          <Table
            title={t("instruments.tracker.insidersTitle")}
            exportName={`${state.ticker}-insiders`}
            headers={[
              t("instruments.tracker.col.txnDate"),
              t("instruments.tracker.col.filed"),
              t("instruments.tracker.col.insider"),
              t("instruments.tracker.col.role"),
              t("instruments.tracker.col.code"),
              "10b5-1",
              t("instruments.tracker.col.shares"),
              t("instruments.tracker.col.value"),
              t("instruments.tracker.col.dir"),
            ]}
            rows={[...state.insiderTxns]
              .sort((a, b) => b.filedAt.localeCompare(a.filedAt))
              .map((txn) => [
                txn.transactionDate ?? na(),
                txn.filedAt.slice(0, 10),
                txn.insiderName,
                txn.role,
                txn.transactionCode || na(),
                txn.is10b51Plan ? t("instruments.tracker.yes") : t("instruments.tracker.no"),
                int(txn.shares),
                txn.value == null ? na() : `$${int(txn.value)}`,
                txn.direction ?? na(),
              ])}
            empty={t("instruments.tracker.noInsiders")}
          />
        )}

        {section === "earnings" && (
          <>
            <div className="mb-1 font-mono text-[10px] text-[#8b8b86]">
              {t("instruments.tracker.reportedNote")}
            </div>
            <Table
              title={t("instruments.tracker.reportedTitle")}
            exportName={`${state.ticker}-earnings-reported`}
            headers={[t("instruments.tracker.col.date"), t("instruments.tracker.col.fiscalPeriod"), t("instruments.tracker.col.timing")]}
              rows={state.earnings.map((e) => [e.date, e.fiscalPeriod, e.hour ?? na()])}
              empty={t("instruments.tracker.noReported")}
            />
            <div className="mb-1 mt-4 font-mono text-[10px] text-[#8b8b86]">
              {t("instruments.tracker.scheduledNote")}
            </div>
            <Table
              title={t("instruments.tracker.scheduledTitle")}
            exportName={`${state.ticker}-earnings-scheduled`}
            headers={[t("instruments.tracker.col.dueAt"), t("instruments.tracker.col.fiscalPeriod")]}
              rows={state.scheduledEarnings.map((e) => [e.dueAt, e.fiscalPeriod])}
              empty={t("instruments.tracker.noneAnnounced")}
            />
          </>
        )}

        {section === "detectors" && (
          <>
            <div className="mb-1 font-mono text-[10px] text-[#8b8b86]">
              {t("instruments.tracker.snapshotNote")}
            </div>
            <Table
              title={t("instruments.tracker.snapshotTitle")}
            exportName={`${state.ticker}-detectors-snapshot`}
            headers={[t("instruments.tracker.col.detector"), t("instruments.tracker.col.lastFiredDay"), t("instruments.tracker.col.lastValue")]}
              rows={(
                [
                  ["gap", state.detectors.gap],
                  ["volume", state.detectors.volume],
                  ["unexplained_move", state.detectors.unexplained],
                ] as const
              ).map(([name, d]) => [name, d.lastFiredDay ?? t("instruments.tracker.never"), num(d.lastFiredValue, 3)])}
              empty=""
            />
            <div className="mb-1 mt-4 font-mono text-[10px] text-[#8b8b86]">
              {t("instruments.tracker.edgeNote")}
            </div>
            <Table
              title={t("instruments.tracker.edgeTitle")}
            exportName={`${state.ticker}-detectors-edge`}
            headers={[
              t("instruments.tracker.col.detector"),
              t("instruments.tracker.col.active"),
              t("instruments.tracker.col.lastFired"),
              t("instruments.tracker.col.lastValue"),
              t("instruments.tracker.col.falseSince"),
            ]}
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
                d.active ? t("instruments.tracker.yes") : t("instruments.tracker.no"),
                d.lastFiredAt ?? t("instruments.tracker.never"),
                num(d.lastFiredValue, 3),
                d.falseSinceDay ?? na(),
              ])}
              empty=""
            />
            <div className="mb-1 mt-4 font-mono text-[10px] text-[#8b8b86]">
              {t("instruments.tracker.bookkeeping")}
            </div>
            <Table
              title={t("instruments.tracker.bookkeeping")}
            exportName={`${state.ticker}-bookkeeping`}
            headers={[t("instruments.tracker.col.field"), t("instruments.tracker.col.value")]}
              rows={[
                ["lastGapCheckedFor", state.lastGapCheckedFor ?? na()],
                ["lastCloseComputedFor", state.lastCloseComputedFor ?? na()],
              ]}
              empty=""
            />
          </>
        )}

        {section === "raw" && (
          <>
            <div className="mb-2 font-mono text-[10px] text-[#a3a39c]">
              {t("instruments.tracker.onDisk", { path: `${dataDir}\\state\\${state.ticker}.json` })}
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
