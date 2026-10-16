import { useEffect, useId, useRef, type ComponentType, type ReactNode } from "react";
import StockIcon from "@/components/stock/StockIcon";
import { Kbd } from "@/components/ui/kbd";
import { useT, type MessageKey } from "@/lib/i18n";
import { comboLabels } from "@/lib/shortcuts";
import { useBinding } from "@/lib/use-shortcuts";
import { cn } from "@/lib/utils";
import { stockTabStore, useStockTab, type OpenStock } from "@/lib/stock-tab-store";
import type { StockSectionProps } from "./sections/types";
import HeaderSection from "./sections/HeaderSection";
import TodaySection from "./sections/TodaySection";
import ThesisSection from "./sections/ThesisSection";
import ChangesSection from "./sections/ChangesSection";
import FilingChangesSection from "./sections/FilingChangesSection";
import GraphSection from "./sections/GraphSection";
import ChainNewsSection from "./sections/ChainNewsSection";
import ReadthroughSection from "./sections/ReadthroughSection";
import EarningsSection from "./sections/EarningsSection";
import GuidanceSection from "./sections/GuidanceSection";
import CompetitorsSection from "./sections/CompetitorsSection";
import AgentReportsSection from "./sections/AgentReportsSection";
import ClassicSection from "./sections/ClassicSection";

/**
 * The Stock tab: the opened company, top to bottom. The header (your
 * context) first, and under it, only on a session that is unusual for the
 * stock, what is on record since the previous close; then the reader's thesis, what changed, the graph and its
 * news, how the stock moved on its linked companies' report days, earnings, competitors, agent reports, and the classic financials
 * last: there, not hidden, not leading.
 *
 * Every section fetches for itself and renders null when it has nothing
 * sourced to show; its heading goes with it (the `:has` rule on the section
 * below), so an empty section leaves no title behind. The whole body is keyed
 * by the ticker, so a switch starts every section fresh.
 */

type SectionEntry = { id: string; titleKey: MessageKey; Component: ComponentType<StockSectionProps> };

const SECTIONS: readonly SectionEntry[] = [
  { id: "thesis", titleKey: "stocktab.tab.section.thesis", Component: ThesisSection },
  { id: "changes", titleKey: "stocktab.tab.section.changes", Component: ChangesSection },
  { id: "filings", titleKey: "stocktab.tab.section.filings", Component: FilingChangesSection },
  { id: "graph", titleKey: "stocktab.tab.section.graph", Component: GraphSection },
  { id: "chain-news", titleKey: "stocktab.tab.section.chainNews", Component: ChainNewsSection },
  { id: "readthrough", titleKey: "stocktab.tab.section.readthrough", Component: ReadthroughSection },
  { id: "earnings", titleKey: "stocktab.tab.section.earnings", Component: EarningsSection },
  { id: "guidance", titleKey: "stocktab.tab.section.guidance", Component: GuidanceSection },
  { id: "competitors", titleKey: "stocktab.tab.section.competitors", Component: CompetitorsSection },
  { id: "reports", titleKey: "stocktab.tab.section.reports", Component: AgentReportsSection },
  { id: "classic", titleKey: "stocktab.tab.section.classic", Component: ClassicSection },
];

/** A titled block that disappears, heading and all, when its body renders nothing. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-12 [&:not(:has(>[data-stock-section-body]>*))]:hidden">
      <h2 id={id} className="mb-4 select-none text-[13px] font-medium tracking-[0.01em] text-content-secondary">
        {title}
      </h2>
      <div data-stock-section-body>{children}</div>
    </section>
  );
}

/** The recent stocks, newest first; the open one is marked. Arrow keys move along the row. */
function RecentStocks({ recent, current, className }: { recent: readonly OpenStock[]; current: string | null; className?: string }) {
  const t = useT();
  if (recent.length === 0 || (recent.length === 1 && recent[0]!.symbol === current)) return null;
  return (
    <nav aria-label={t("stocktab.tab.recent")} className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {recent.map((s) => {
        const on = s.symbol === current;
        return (
          <button
            key={s.symbol}
            type="button"
            aria-current={on ? "page" : undefined}
            aria-label={t("stocktab.tab.open", { ticker: s.symbol })}
            title={s.companyName}
            onClick={() => stockTabStore().open(s)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              const sib = (e.key === "ArrowLeft" ? e.currentTarget.previousElementSibling : e.currentTarget.nextElementSibling) as HTMLElement | null;
              if (sib) {
                e.preventDefault();
                sib.focus();
              }
            }}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium tabular-nums outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-edge-focus motion-reduce:transition-none",
              on
                ? "bg-fill-selected text-content-primary"
                : "text-content-secondary hover:bg-fill-hover hover:text-content-primary",
            )}
          >
            <StockIcon symbol={s.symbol} size="sm" className="h-4 w-4 rounded-full" />
            <span lang="en">{s.symbol}</span>
          </button>
        );
      })}
    </nav>
  );
}

function EmptyState({ recent }: { recent: readonly OpenStock[] }) {
  const t = useT();
  const keys = comboLabels(useBinding("search"));
  return (
    <div className="flex min-h-[46vh] flex-col items-center justify-center gap-5 text-center">
      <p className="flex flex-wrap items-center justify-center gap-2 text-[14px] text-content-secondary">
        {t("stocktab.tab.empty")}
        {keys.length > 0 ? (
          <span className="inline-flex items-center gap-1" aria-hidden>
            {keys.map((k) => (
              <Kbd key={k} size="xs" className="cursor-default">
                {k}
              </Kbd>
            ))}
          </span>
        ) : null}
      </p>
      <RecentStocks recent={recent} current={null} className="justify-center" />
    </div>
  );
}

function StockBody({ stock, recent }: { stock: OpenStock; recent: readonly OpenStock[] }) {
  const t = useT();
  return (
    <div>
      <RecentStocks recent={recent} current={stock.symbol} className="mb-5" />
      <HeaderSection ticker={stock.symbol} />
      <TodaySection ticker={stock.symbol} />
      {SECTIONS.map(({ id, titleKey, Component }) => (
        <Section key={id} title={t(titleKey)}>
          <Component ticker={stock.symbol} />
        </Section>
      ))}
    </div>
  );
}

export default function StockTab() {
  const { current, recent } = useStockTab();
  // A different stock starts at its top, whichever way it was opened.
  const root = useRef<HTMLDivElement | null>(null);
  const shownSymbol = useRef(current?.symbol ?? null);
  useEffect(() => {
    const symbol = current?.symbol ?? null;
    if (symbol === shownSymbol.current) return;
    shownSymbol.current = symbol;
    const scroller = root.current?.closest("main");
    if (scroller && root.current?.closest("[aria-hidden='true']") == null) scroller.scrollTo({ top: 0 });
  }, [current?.symbol]);
  return (
    <div ref={root} className="app-no-drag px-8 pb-16 pt-5">
      <div className="mx-auto w-full max-w-[1120px]">
        {current ? <StockBody key={current.symbol} stock={current} recent={recent} /> : <EmptyState recent={recent} />}
      </div>
    </div>
  );
}
