import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n, type MessageKey, type TFunction } from "@/lib/i18n";
import { openStock } from "@/lib/stock-open";
import { cn } from "@/lib/utils";
import { BUTTON, HeldMarker, LABEL, SKELETON } from "@/components/earnings/earnings-ui";
import { shortDate } from "../../../../shared/earnings-view";
import {
  STOCK_GRAPH_TABS,
  neighbourRows,
  sharedHoldings,
  strongestInfluence,
  type LinkRole,
  type NeighbourRow,
  type StockGraph,
  type StockGraphTab,
  type StrengthTier,
} from "../../../../shared/stock-graph";
import EgoGraph, { TAB_COLOR } from "../graph/EgoGraph";
import { egoLayout } from "../graph/ego-layout";
import { useReaderTickers, useResearchCompany, useStockGraph } from "../graph/use-stock-graph";
import type { StockSectionProps } from "./types";

/**
 * Stock tab: the company's filing graph. Two questions answered from the
 * graph alone (no model), the ego drawing, then the neighbours of one group
 * with each link's strength, the share the filing discloses, its source and
 * whether the reader holds the company.
 */

const TAB_KEY: Record<StockGraphTab, MessageKey> = {
  suppliers: "stocktab.graph.tab.suppliers",
  customers: "stocktab.graph.tab.customers",
  competitors: "stocktab.graph.tab.competitors",
  dependencies: "stocktab.graph.tab.dependencies",
};

const ROLE_KEY: Record<Exclude<LinkRole, "dependent">, MessageKey> = {
  supplier: "stocktab.graph.role.supplier",
  customer: "stocktab.graph.role.customer",
  competitor: "stocktab.graph.role.competitor",
  partner: "stocktab.graph.role.partner",
  dependency: "stocktab.graph.role.dependency",
};

const TIER_KEY: Record<StrengthTier, MessageKey> = {
  critical: "stocktab.graph.tier.critical",
  important: "stocktab.graph.tier.important",
  marginal: "stocktab.graph.tier.marginal",
};

const TIER_TONE: Record<StrengthTier, string> = {
  critical: "text-[#1d1b1b] font-medium",
  important: "text-[#4b5563]",
  marginal: "text-[#9CA3AF]",
};

const LIST_LIMIT = 6;
const TILE = "rounded-2xl border border-white/60 bg-white/40 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04]";
const PLAIN_TICKER =
  "app-no-drag cursor-pointer font-medium text-[#1d1b1b] underline-offset-2 outline-none hover:underline focus-visible:underline";

function roleText(row: NeighbourRow, center: string, t: TFunction): string {
  return row.role === "dependent" ? t("stocktab.graph.role.dependent", { ticker: center }) : t(ROLE_KEY[row.role]);
}

function formatPct(pct: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(pct);
}

/** "19% of revenue" for the stock's own filing, "19% of TSM revenue" for the neighbour's. */
function shareText(row: NeighbourRow, t: TFunction, locale: string): string | null {
  const { share, filer } = row.link;
  if (share === null) return null;
  const pct = formatPct(share, locale);
  return row.inbound ? t("stocktab.graph.share.filer", { pct, ticker: filer }) : t("stocktab.graph.share.own", { pct });
}

/** "per 10-K, filed Feb 4"; "per TSM 20-F, filed Apr 17" when the link is from the neighbour's filing. */
function sourceText(row: NeighbourRow, t: TFunction, locale: string): string {
  const form = row.link.form ?? t("stocktab.graph.filing");
  const doc = row.inbound ? `${row.link.filer} ${form}` : form;
  const ymd = row.link.filingDate;
  if (ymd && /^\d{4}-\d{2}-\d{2}/.test(ymd)) {
    return t("stocktab.graph.sourceDated", { doc, date: shortDate(ymd.slice(0, 10), locale) });
  }
  return t("stocktab.graph.source", { doc });
}

function openSource(url: string): void {
  if (url) void window.meridian?.openExternal(url);
}

function Name({ ticker, name }: { ticker: string | null; name: string }) {
  const { t } = useI18n();
  if (!ticker) return <span className="truncate text-[#1d1b1b]">{name}</span>;
  return (
    <button
      type="button"
      onClick={() => openStock(ticker, name)}
      aria-label={t("stocktab.tab.open", { ticker })}
      title={name !== ticker ? name : undefined}
      className={PLAIN_TICKER}
    >
      {ticker}
    </button>
  );
}

function Question({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={TILE}>
      <p className={LABEL}>{label}</p>
      <div className="mt-1.5 text-[13px] leading-snug">{children}</div>
    </div>
  );
}

function MostAffecting({ graph }: { graph: StockGraph }) {
  const { t, locale } = useI18n();
  const top = useMemo(() => strongestInfluence(graph), [graph]);
  if (!top) return <p className="text-[#9CA3AF]">{t("stocktab.graph.q.mostNone")}</p>;
  const parts = [
    t("stocktab.graph.reason", { role: roleText(top, graph.ticker, t), tier: t(TIER_KEY[top.link.tier]) }),
    shareText(top, t, locale),
    sourceText(top, t, locale),
  ].filter(Boolean);
  return (
    <>
      <div className="flex min-w-0 items-baseline gap-2">
        <Name ticker={top.ticker} name={top.name} />
        {top.ticker && top.name !== top.ticker ? <span className="truncate text-[12px] text-[#6b7280]">{top.name}</span> : null}
      </div>
      <p className="mt-0.5 text-[12px] leading-snug text-[#6b7280]" title={top.link.quote}>
        {parts.join(", ")}
      </p>
    </>
  );
}

function SharedWithHoldings({ graph, held }: { graph: StockGraph; held: string[] }) {
  const { t, locale } = useI18n();
  const others = useMemo(() => held.filter((h) => h !== graph.ticker), [held, graph.ticker]);
  const shared = useMemo(() => sharedHoldings(graph, others), [graph, others]);
  if (others.length === 0) return <p className="text-[#9CA3AF]">{t("stocktab.graph.q.sharedNoHoldings")}</p>;
  if (shared.length === 0) return <p className="text-[#9CA3AF]">{t("stocktab.graph.q.sharedNone")}</p>;
  const list = new Intl.ListFormat(locale, { style: "narrow", type: "conjunction" });
  return (
    <ul className="space-y-0.5">
      {shared.slice(0, 3).map((h) => {
        const names = h.shared.slice(0, 4).map((s) => s.ticker ?? s.name);
        const more = h.shared.length - names.length;
        return (
          <li key={h.ticker} className="flex min-w-0 items-baseline gap-2">
            <Name ticker={h.ticker} name={h.ticker} />
            <span className="truncate text-[12px] text-[#6b7280]" title={h.shared.map((s) => s.name).join(", ")}>
              {more > 0 ? `${list.format(names)} +${more}` : list.format(names)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function NeighbourList({
  rows,
  center,
  held,
  watching,
}: {
  rows: NeighbourRow[];
  center: string;
  held: ReadonlySet<string>;
  watching: ReadonlySet<string>;
}) {
  const { t, locale } = useI18n();
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [rows]);
  const shown = all ? rows : rows.slice(0, LIST_LIMIT);
  return (
    <div>
      <ul className="divide-y divide-black/[0.06]">
        {shown.map((row) => {
          const share = shareText(row, t, locale);
          const isHeld = row.ticker !== null && held.has(row.ticker);
          const isWatched = row.ticker !== null && watching.has(row.ticker);
          return (
            <li key={`${row.tab}|${row.id}`} className="flex min-w-0 items-center gap-3 py-1.5 text-[12.5px]">
              <span className="w-3 shrink-0">
                <HeldMarker row={{ held: isHeld, watchlist: !isHeld && isWatched }} />
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <Name ticker={row.ticker} name={row.name} />
                {row.ticker && row.name !== row.ticker ? (
                  <span className="truncate text-[12px] text-[#9CA3AF]">{row.name}</span>
                ) : null}
              </span>
              {share ? <span className="shrink-0 text-[11.5px] tabular-nums text-[#4b5563]">{share}</span> : null}
              <span
                className={cn("w-[84px] shrink-0 truncate text-right text-[11.5px]", TIER_TONE[row.link.tier])}
                title={roleText(row, center, t)}
              >
                {t(TIER_KEY[row.link.tier])}
              </span>
              <button
                type="button"
                onClick={() => openSource(row.link.sourceUrl)}
                title={row.link.quote}
                aria-label={t("stocktab.graph.openSource")}
                className="app-no-drag w-[220px] shrink-0 cursor-pointer truncate text-right text-[11.5px] text-[#6b7280] underline-offset-2 outline-none hover:text-[#1d1b1b] hover:underline focus-visible:underline"
              >
                {sourceText(row, t, locale)}
              </button>
            </li>
          );
        })}
      </ul>
      {rows.length > LIST_LIMIT ? (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="app-no-drag mt-1 cursor-pointer text-[12px] text-[#6b7280] outline-none hover:text-[#1d1b1b] focus-visible:underline"
        >
          {all ? t("stocktab.graph.showFewer") : t("stocktab.graph.showAll", { count: rows.length })}
        </button>
      ) : null}
    </div>
  );
}

function ResearchButton({ ticker, onDone }: { ticker: string; onDone: () => void }) {
  const { t } = useI18n();
  const research = useResearchCompany(ticker, onDone);
  return (
    <span className="flex items-center gap-3">
      <button type="button" onClick={research.start} disabled={research.state === "running"} className={BUTTON}>
        {research.state === "running" ? t("stocktab.graph.researching") : t("stocktab.graph.research")}
      </button>
      {research.state === "failed" ? <span className="text-[12px] text-[#9CA3AF]">{t("stocktab.graph.researchFailed")}</span> : null}
    </span>
  );
}

export default function GraphSection({ ticker }: StockSectionProps) {
  const { t } = useI18n();
  const symbol = ticker.trim().toUpperCase();
  const state = useStockGraph(symbol);
  const { held, watching } = useReaderTickers();
  const heldSet = useMemo(() => new Set(held), [held]);
  const watchSet = useMemo(() => new Set(watching), [watching]);

  const graph = state.status === "ready" ? state.graph : null;
  const rows = useMemo(() => (graph ? neighbourRows(graph) : null), [graph]);
  const tabs = useMemo(() => (rows ? STOCK_GRAPH_TABS.filter((tab) => rows[tab].length > 0) : []), [rows]);
  const [tab, setTab] = useState<StockGraphTab | null>(null);
  useEffect(() => setTab(null), [symbol]);
  const active = tab && tabs.includes(tab) ? tab : (tabs[0] ?? null);
  const layout = useMemo(() => (graph && rows ? egoLayout(graph, rows, { prefer: held }) : null), [graph, rows, held]);

  if (state.status === "unavailable") return null;
  if (state.status === "loading") {
    return (
      <div className="space-y-3" aria-hidden>
        <div className="grid gap-3 md:grid-cols-2">
          <div className={cn(SKELETON, "h-[64px] rounded-2xl")} />
          <div className={cn(SKELETON, "h-[64px] rounded-2xl")} />
        </div>
        <div className={cn(SKELETON, "h-[220px] rounded-2xl")} />
      </div>
    );
  }

  if (!graph || !rows || !layout || tabs.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 py-1">
        <p className="text-[13px] text-[#6b7280]">{t("stocktab.graph.empty", { ticker: symbol })}</p>
        <ResearchButton ticker={symbol} onDone={state.reload} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Question label={t("stocktab.graph.q.most")}>
          <MostAffecting graph={graph} />
        </Question>
        <Question label={t("stocktab.graph.q.shared")}>
          <SharedWithHoldings graph={graph} held={held} />
        </Question>
      </div>

      <EgoGraph layout={layout} ticker={symbol} selected={active} held={heldSet} watching={watchSet} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label={t("stocktab.tab.section.graph")} className="flex flex-wrap items-center gap-1">
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active === id}
              onClick={() => setTab(id)}
              className={cn(
                "app-no-drag flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] outline-none transition-colors focus-visible:bg-black/[0.04]",
                active === id ? "bg-black/[0.06] text-[#1d1b1b]" : "text-[#6b7280] hover:bg-black/[0.04] hover:text-[#1d1b1b]",
              )}
            >
              <span aria-hidden className="block h-[6px] w-[6px] rounded-full" style={{ backgroundColor: TAB_COLOR[id] }} />
              {t(TAB_KEY[id])}
              <span className="tabular-nums text-[#9CA3AF]">{rows[id].length}</span>
            </button>
          ))}
        </div>
        {!graph.researched ? <ResearchButton ticker={symbol} onDone={state.reload} /> : null}
      </div>

      {active ? <NeighbourList rows={rows[active]} center={symbol} held={heldSet} watching={watchSet} /> : null}
    </div>
  );
}
