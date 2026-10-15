import type { ReactNode } from "react";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import { openFilingChangesAgent } from "@/components/agents/agents-store";
import { useWatchlistTickers } from "@/components/calendar/use-calendar-data";
import { SKELETON, useSay } from "@/components/earnings/earnings-ui";
import { requestFilingChangesView, useFilingOverview } from "@/lib/filings-store";
import { useHeldPositions } from "@/lib/readthrough-store";
import { openStock } from "@/lib/stock-open";
import { cn } from "@/lib/utils";
import { changeLabel, filingDate } from "../../../shared/filing-changes-view";
import type { FilingOverviewRow } from "../../../shared/filing-changes";

type Props = {
  onDuplicate?: () => void;
  onRemove?: () => void;
};

/** How many changes the card lists. */
const ROWS = 8;

/** The Stock tab for `ticker`, scrolled to its Filing changes section. */
function openFilings(ticker: string): void {
  openStock(ticker);
  requestFilingChangesView(ticker);
}

function Skeleton() {
  return (
    <div className="space-y-4 pt-1" aria-hidden>
      {["w-[78%]", "w-[64%]", "w-[70%]", "w-[58%]", "w-[66%]"].map((w) => (
        <div key={w} className="flex items-center gap-3">
          <div className={cn(SKELETON, "h-3 w-10")} />
          <div className={cn(SKELETON, "h-3", w)} />
        </div>
      ))}
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="flex flex-1 items-center justify-center px-4 text-center text-[13px] leading-[1.5] text-content-tertiary">{children}</p>;
}

function Row({ row }: { row: FilingOverviewRow }) {
  const { say, lang, t } = useSay();
  const label = changeLabel(row.item, say, lang, row.count);
  const date = filingDate(row.item.date, lang);
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => openFilings(row.ticker)}
        title={row.item.text ?? undefined}
        aria-label={`${row.ticker}, ${label}, ${row.item.form} ${date}. ${t("filings.card.openRow", { ticker: row.ticker })}`}
        className="app-no-drag grid w-full grid-cols-[44px_minmax(0,1fr)_auto] items-start gap-x-3 rounded-xl px-2 py-2 text-left outline-none transition-colors duration-150 hover:bg-fill-hover focus-visible:ring-2 focus-visible:ring-edge-focus motion-reduce:transition-none"
      >
        <span lang="en" className="truncate text-[12px] font-medium text-content-primary">
          {row.ticker}
        </span>
        <span className="line-clamp-2 text-[12.5px] leading-[1.4] text-content-body">{label}</span>
        <span className="whitespace-nowrap text-[11.5px] tabular-nums text-content-tertiary transition-opacity duration-150 group-focus-within:opacity-0 group-hover:opacity-0 motion-reduce:transition-none">
          <span lang="en">{row.item.form}</span> {date}
        </span>
      </button>
      {/* Over the form and date while the row is hovered or focused: an agent on this name's next filings. */}
      <button
        type="button"
        onClick={() => openFilingChangesAgent(row.ticker)}
        aria-label={t("filings.watchAria", { ticker: row.ticker })}
        className="app-no-drag absolute right-2 top-2 rounded-sm text-[11.5px] text-content-secondary underline-offset-2 opacity-0 outline-none transition-opacity duration-150 hover:text-content-primary hover:underline focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-edge-focus group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
      >
        {t("filings.watch")}
      </button>
    </li>
  );
}

/**
 * Filing changes on the dashboard: what the reader's names changed in their
 * latest 10-K, 20-F or 10-Q against the one before, and the red flags in
 * their EDGAR index (auditor changes, restatement notices, late filings).
 * One title line per change: ticker, what changed, form and date. A line
 * opens the Stock tab at that company's Filing changes section; the arrow
 * opens the first.
 */
export default function FilingChangesCard({ onDuplicate, onRemove }: Props) {
  const { t } = useSay();
  const held = useHeldPositions().map((h) => h.ticker);
  const watchlist = useWatchlistTickers();
  const state = useFilingOverview(held, watchlist);
  const answer = state.value;
  const rows = answer ? answer.rows.slice(0, ROWS) : [];
  const none = held.length === 0 && watchlist.length === 0;
  const total = answer ? answer.pending.length + answer.checked : 0;
  const reading = answer && answer.pending.length > 0;

  let body: ReactNode;
  if (none) body = <Quiet>{t("filings.card.noNames")}</Quiet>;
  else if (!answer && state.error !== null) body = <Quiet>{state.error === "restart" ? t("filings.error.restart") : t("filings.card.failed")}</Quiet>;
  else if (!answer || (rows.length === 0 && reading)) body = <Skeleton />;
  else if (rows.length === 0) body = <Quiet>{t("filings.card.empty")}</Quiet>;
  else {
    body = (
      <ul className="scrollbar-meridian -mx-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
        {rows.map((row) => (
          <Row key={row.id} row={row} />
        ))}
      </ul>
    );
  }

  const first = rows[0];
  return (
    <div className="flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      <ChartCardHeader
        label={t("filings.card.label")}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
        onOpen={first ? () => openFilings(first.ticker) : undefined}
        openLabel={first ? t("filings.card.view", { ticker: first.ticker }) : undefined}
      />
      <div className="flex min-h-0 flex-1 flex-col pt-4">{body}</div>
      {reading ? (
        <p className="pt-3 text-[11.5px] tabular-nums text-content-tertiary" aria-live="polite">
          {t("filings.card.reading", { done: answer.checked, total })}
        </p>
      ) : null}
    </div>
  );
}
