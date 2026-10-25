import { useEffect, useRef, useState, type ReactNode } from "react";
import { MiniChart } from "@/components/dashboard/StockPeekModal";
import { Segmented, SKELETON } from "@/components/earnings/earnings-ui";
import GaugeContextBlock from "@/components/gauge/GaugeContextBlock";
import StockPaperTradePanel from "@/components/stock/StockPaperTradePanel";
import StockView from "@/components/stock/StockView";
import { useLiveQuote } from "@/hooks/useLiveQuote";
import { useT, type MessageKey } from "@/lib/i18n";
import { subscribeDemoMode } from "@/lib/demo-mode";
import { hasPaperAccount, subscribePaperAccount } from "@/lib/paper-account";
import { getStockChart } from "@/lib/stock-api";
import { cn } from "@/lib/utils";
import { CHART_TIMEFRAMES, type ChartTimeframe, type PricePoint, type StockOverviewData } from "../../../../shared/stock-types";
import { useStockOverview } from "../use-stock-overview";
import { useTabActive } from "../use-tab-active";
import type { StockSectionProps } from "./types";

/**
 * Stock tab, 9: the classic stock page, last and in full. The price chart,
 * the day's key stats and the valuation multiples, the paper account's order
 * bar, the tape state, the company profile, and the filing research (the
 * relationship extraction the old stock screen ran). Every block is an
 * existing piece reused: the peek's chart, the overview the market data
 * provider answers (`stock:get-overview`), the paper trade panel, the gauge
 * block, and the stock screen's research flow.
 */

const STAT_ROWS: ReadonlyArray<{ key: keyof StockOverviewData["stats"]; label: MessageKey }> = [
  { key: "open", label: "stocktab.classic.open" },
  { key: "prevClose", label: "stocktab.classic.prevClose" },
  { key: "dayRange", label: "stocktab.classic.dayRange" },
  { key: "weekRange52", label: "stocktab.classic.weekRange52" },
  { key: "volume", label: "stocktab.classic.volume" },
];

const VALUATION_ROWS: ReadonlyArray<{ key: keyof StockOverviewData["stats"]; label: MessageKey }> = [
  { key: "marketCap", label: "stocktab.classic.marketCap" },
  { key: "peRatio", label: "stocktab.classic.peRatio" },
  { key: "eps", label: "stocktab.classic.eps" },
  { key: "dividendYield", label: "stocktab.classic.dividendYield" },
];

const PROFILE_ROWS: ReadonlyArray<{ key: keyof StockOverviewData["company"]; label: MessageKey }> = [
  { key: "sector", label: "stocktab.classic.sector" },
  { key: "industry", label: "stocktab.classic.industry" },
  { key: "ceo", label: "stocktab.classic.ceo" },
  { key: "fullTimeEmployees", label: "stocktab.classic.employees" },
  { key: "ipoDate", label: "stocktab.classic.ipoDate" },
  { key: "country", label: "stocktab.classic.country" },
  { key: "exchange", label: "stocktab.classic.exchange" },
];

/** A provider value worth printing: not empty, not its own "n/a". */
function shown(value: string | undefined | null): value is string {
  const v = value?.trim();
  return Boolean(v) && v!.toLowerCase() !== "n/a" && v !== "-";
}

function Sub({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <h3 className="mb-3 select-none text-[11.5px] font-medium tracking-[0.02em] text-content-tertiary">{title}</h3>
      {children}
    </div>
  );
}

function Pairs({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <dl className="divide-y divide-black/[0.06]">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between gap-4 py-2">
          <dt className="text-[12.5px] text-content-secondary">{r.label}</dt>
          <dd className="text-right text-[13px] tabular-nums text-content-primary">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PriceChart({ ticker }: { ticker: string }) {
  const t = useT();
  const [timeframe, setTimeframe] = useState<ChartTimeframe>("1M");
  const [series, setSeries] = useState<PricePoint[] | null>(null);
  const cache = useRef(new Map<string, PricePoint[]>());
  useEffect(() => {
    const key = `${ticker}:${timeframe}`;
    const hit = cache.current.get(key);
    if (hit) {
      setSeries(hit);
      return;
    }
    let cancelled = false;
    setSeries(null);
    getStockChart(ticker, timeframe)
      .then((points) => {
        if (cancelled) return;
        cache.current.set(key, points);
        setSeries(points);
      })
      .catch(() => {
        if (!cancelled) setSeries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, timeframe]);

  return (
    <figure aria-label={t("stocktab.classic.chart")}>
      <div className="flex justify-end">
        <Segmented
          value={timeframe}
          label={t("stocktab.classic.range")}
          onChange={setTimeframe}
          options={CHART_TIMEFRAMES.map((id) => ({ id, text: id }))}
        />
      </div>
      <div className="mt-3 h-56">{series ? <MiniChart series={series} /> : <div className={cn(SKELETON, "h-full w-full rounded-2xl")} />}</div>
    </figure>
  );
}

function usePaperOn(): boolean {
  const [on, setOn] = useState(hasPaperAccount);
  useEffect(() => {
    const read = () => setOn(hasPaperAccount());
    const offPaper = subscribePaperAccount(read);
    const offDemo = subscribeDemoMode(read);
    return () => {
      offPaper();
      offDemo();
    };
  }, []);
  return on;
}

function Description({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const long = text.length > 420;
  return (
    <div className="mt-4">
      <p className={cn("text-[13px] leading-relaxed text-content-body", long && !open && "line-clamp-4")}>{text}</p>
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="mt-1.5 text-[12px] text-content-secondary underline-offset-2 outline-none hover:underline focus-visible:underline"
        >
          {open ? t("stocktab.classic.less") : t("stocktab.classic.more")}
        </button>
      ) : null}
    </div>
  );
}

export default function ClassicSection({ ticker }: StockSectionProps) {
  const t = useT();
  const active = useTabActive();
  const overview = useStockOverview(ticker);
  const paper = usePaperOn();
  // Only the order bar needs a price here; the header polls its own, faster.
  const live = useLiveQuote(ticker, { enabled: active && paper, intervalMs: 10_000 });

  const stats = overview.data?.stats;
  const company = overview.data?.company;
  const statRows = stats ? STAT_ROWS.filter((r) => shown(stats[r.key])).map((r) => ({ label: t(r.label), value: stats[r.key] })) : [];
  const valuationRows = stats
    ? VALUATION_ROWS.filter((r) => shown(stats[r.key])).map((r) => ({ label: t(r.label), value: stats[r.key] }))
    : [];
  const profileRows = company
    ? PROFILE_ROWS.filter((r) => shown(company[r.key])).map((r) => ({ label: t(r.label), value: company[r.key]!.trim() }))
    : [];
  const description = company?.description?.trim() || null;

  return (
    <div className="space-y-10">
      <PriceChart ticker={ticker} />

      {overview.loading ? (
        <div className="grid gap-8 md:grid-cols-2" aria-hidden>
          {[0, 1].map((i) => (
            <div key={i} className="space-y-3">
              <div className={cn(SKELETON, "h-3 w-20")} />
              {[0, 1, 2, 3].map((r) => (
                <div key={r} className={cn(SKELETON, "h-4 w-full")} />
              ))}
            </div>
          ))}
        </div>
      ) : statRows.length > 0 || valuationRows.length > 0 ? (
        <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
          {statRows.length > 0 ? (
            <Sub title={t("stocktab.classic.stats")}>
              <Pairs rows={statRows} />
            </Sub>
          ) : null}
          {valuationRows.length > 0 ? (
            <Sub title={t("stocktab.classic.valuation")}>
              <Pairs rows={valuationRows} />
            </Sub>
          ) : null}
        </div>
      ) : null}

      {paper ? <StockPaperTradePanel symbol={ticker} price={live.quote?.price ?? null} variant="bar" /> : null}

      <GaugeContextBlock
        ticker={ticker}
        context={null}
        surface="stock"
        title={t("stock.gaugeTitle")}
        className="rounded-xl border border-edge bg-surface-2 px-3.5 py-3"
      />

      {profileRows.length > 0 || description ? (
        <Sub title={t("stocktab.classic.profile")}>
          {profileRows.length > 0 ? (
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
              {profileRows.map((r) => (
                <div key={r.label} className="min-w-0">
                  <dt className="text-[11.5px] text-content-tertiary">{r.label}</dt>
                  <dd className="mt-0.5 truncate text-[13px] text-content-primary" title={r.value}>
                    {r.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {description ? <Description text={description} /> : null}
        </Sub>
      ) : null}

      <Sub title={t("stocktab.classic.research")}>
        <StockView symbol={ticker} researchOnly />
      </Sub>
    </div>
  );
}
