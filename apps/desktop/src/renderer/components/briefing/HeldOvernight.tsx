import { useMemo } from "react";
import { cn } from "@/lib/utils";
import StockIcon from "../stock/StockIcon";
import type { BriefingReport } from "../../../shared/briefing-types";
import { heldRows, type HeldItemView, type HeldRowView } from "../../../shared/briefing-view";
import BriefingSection from "./BriefingSection";
import { HEAD_CLASS, MONO_CLASS, PILL_CLASS, TONE_TEXT } from "./briefing-styles";

type Props = {
  report: BriefingReport | null;
  masked: boolean;
  loading: boolean;
  /** The engine's degraded lines that concern held names (prices, news, volatility). */
  notes?: ReadonlyArray<string | null | undefined>;
  onOpenStock: (ticker: string) => void;
};

/**
 * Six rows is what fits above the fold of the main column beside the market
 * table. The view orders the rows by how much each has to say, so the cut
 * falls on the quietest names, and what it drops is counted under the list.
 */
const ROW_LIMIT = 6;

/** Two items keep a row to three lines; the view hands over up to three, and the rest is a count. */
const ITEMS_SHOWN = 2;

/** What a highlight in this table is about, for the gloss; each row adds which name. */
const GLOSS_CONTEXT =
  "The held names table of the handover briefing: each name's move since the last US close, that move in units of its own daily volatility (sigma), its P/L and its weight in the book.";

const COLUMNS = "grid grid-cols-[28px_minmax(0,1fr)_76px_52px_104px_52px] items-center gap-3";

function countLine(count: number, one: string, many: string): string | null {
  if (count <= 0) return null;
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

function HeldItem({ item }: { item: HeldItemView }) {
  return (
    <span className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2">
      <span className={cn(PILL_CLASS, "max-w-[120px] truncate")}>{item.label}</span>
      <span className="truncate text-[12px] text-[#4b5563]">{item.text}</span>
      <span className={cn(MONO_CLASS, "text-[10.5px] text-[#9CA3AF]")}>{item.time}</span>
    </span>
  );
}

function HeldRow({ row, onOpen }: { row: HeldRowView; onOpen: (ticker: string) => void }) {
  const items = row.items.slice(0, ITEMS_SHOWN);
  const more = row.moreCount + (row.items.length - items.length);
  return (
    <li data-gloss-ticker={row.ticker}>
      {/* The whole row is the button: every figure on it is about one name, and
          that name's page is the only place any of them leads. */}
      <button
        type="button"
        onClick={() => onOpen(row.ticker)}
        className="app-no-drag -mx-2 block w-[calc(100%+16px)] rounded-xl px-2 py-2 text-left transition-colors hover:bg-black/[0.03]"
      >
        <span className={COLUMNS}>
          <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-[#E3E3E0]">
            <StockIcon symbol={row.ticker} size="sm" className="h-4 w-4" />
          </span>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="text-[13px] font-medium text-[#1d1b1b]">{row.ticker}</span>
            {row.flagNote ? <span className="truncate text-[11px] text-[#D97706]">{row.flagNote}</span> : null}
            {row.coverageNote ? <span className="truncate text-[11px] text-[#9CA3AF]">{row.coverageNote}</span> : null}
          </span>
          <span className={cn(MONO_CLASS, "text-right text-[12.5px]", TONE_TEXT[row.tone])} title={row.basisNote ?? undefined}>
            {row.move}
          </span>
          <span className={cn(MONO_CLASS, "text-right text-[11px] text-[#6b7280]")}>{row.z ?? ""}</span>
          <span className={cn(MONO_CLASS, "text-right text-[12px] text-[#1d1b1b]")}>{row.pnl}</span>
          <span className={cn(MONO_CLASS, "text-right text-[11px] text-[#6b7280]")}>{row.weight ?? ""}</span>
        </span>
        {items.length > 0 ? (
          <span className="mt-1.5 block space-y-1 pl-10">
            {items.map((item, i) => (
              <HeldItem key={`${item.kind}-${i}`} item={item} />
            ))}
            {more > 0 ? <span className="block text-[11px] text-[#9CA3AF]">{`+${more} more`}</span> : null}
          </span>
        ) : null}
      </button>
    </li>
  );
}

export default function HeldOvernight({ report, masked, loading, notes = [], onOpenStock }: Props) {
  const view = useMemo(() => (report ? heldRows(report, { limit: ROW_LIMIT, masked }) : null), [report, masked]);
  const rows = view?.rows ?? [];
  // Said only of a book that really is empty. A book with positions and no
  // rows is a section that failed, and the engine's own line covers that.
  const empty = !loading && rows.length === 0 && report !== null && !(report.book?.position_count > 0);

  return (
    <BriefingSection
      label="HELD OVERNIGHT"
      loading={loading}
      skeletonRows={5}
      glossContext={GLOSS_CONTEXT}
      notes={[
        view ? countLine(view.hiddenCount, "more name has something to report.", "more names have something to report.") : null,
        view ? countLine(view.quietCount, "other name was quiet.", "other names were quiet.") : null,
        ...notes,
        empty ? "No positions in this book." : null,
      ]}
    >
      {rows.length > 0 ? (
        <>
          <div className={cn(COLUMNS, HEAD_CLASS, "mt-3 pb-1 text-right")}>
            <span />
            <span className="text-left">Name</span>
            <span>Move</span>
            <span>Sigma</span>
            <span>P/L</span>
            <span>Weight</span>
          </div>
          <ul>
            {rows.map((row) => (
              <HeldRow key={row.ticker} row={row} onOpen={onOpenStock} />
            ))}
          </ul>
        </>
      ) : null}
    </BriefingSection>
  );
}
