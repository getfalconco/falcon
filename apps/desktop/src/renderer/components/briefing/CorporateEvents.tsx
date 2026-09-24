import { useMemo } from "react";
import { Coins, Megaphone, Scale, Split, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BriefingReport, CorporateEventKind } from "../../../shared/briefing-types";
import { corporateRows, type CorporateRowView } from "../../../shared/briefing-view";
import BriefingSection from "./BriefingSection";
import { MONO_CLASS, PILL_CLASS, QUIET_NOTE_CLASS } from "./briefing-styles";

type Props = {
  report: BriefingReport | null;
  now: Date;
  loading: boolean;
  /** The engine's degraded line for corporate events. */
  note?: string | null;
  onOpenStock: (ticker: string) => void;
};

const KIND_ICON: Record<CorporateEventKind, LucideIcon> = {
  dividend: Coins,
  split: Split,
  rebalance: Scale,
  earnings: Megaphone,
};

function EventRow({ row, onOpenStock }: { row: CorporateRowView; onOpenStock: (ticker: string) => void }) {
  const Icon = KIND_ICON[row.kind] ?? Scale;
  // The event's own name first, then the held names it reaches (for an index
  // change, the funds that track the index). The view already keeps the two
  // apart, so the list cannot name one symbol twice.
  const names = row.ticker ? [row.ticker, ...row.concerns] : row.concerns;
  return (
    <li className="grid grid-cols-[64px_22px_minmax(0,1fr)_auto] gap-3 py-2">
      <span>
        <span className={cn(MONO_CLASS, "block text-[12px] text-[#1d1b1b]")}>{row.dateLabel}</span>
        <span className="block text-[11px] text-[#9CA3AF]">{row.whenLabel}</span>
      </span>
      <span className="pt-px text-[#6b7280]" title={row.kindLabel}>
        <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        <span className="sr-only">{row.kindLabel}</span>
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] leading-[1.4] text-[#1d1b1b]">{row.title}</span>
        {row.detail ? <span className="block text-[12px] leading-[1.45] text-[#6b7280]">{row.detail}</span> : null}
        {row.certaintyNote ? <span className="block text-[11px] text-[#9CA3AF]">{row.certaintyNote}</span> : null}
      </span>
      <span className="flex max-w-[180px] flex-wrap content-start justify-end gap-1">
        {names.map((ticker) => (
          <button
            key={ticker}
            type="button"
            onClick={() => onOpenStock(ticker)}
            className={cn(PILL_CLASS, "app-no-drag transition-colors hover:bg-[#1d1b1b]/[0.1] hover:text-[#1d1b1b]")}
          >
            {ticker}
          </button>
        ))}
      </span>
    </li>
  );
}

/** What a highlight in this list is about, for the gloss. */
const GLOSS_CONTEXT =
  "The corporate events list of the handover briefing: dividends, splits, index rebalances and earnings dates on the names held, with how many sessions away each one is.";

export default function CorporateEvents({ report, now, loading, note, onOpenStock }: Props) {
  const view = useMemo(() => (report ? corporateRows(report, now) : null), [report, now]);
  const rows = view?.rows ?? [];
  const empty = !loading && rows.length === 0;

  return (
    <BriefingSection label="CORPORATE EVENTS" loading={loading} skeletonRows={3} glossContext={GLOSS_CONTEXT}>
      {rows.length > 0 ? (
        <ul className="mt-1 divide-y-[0.5px] divide-black/[0.06]">
          {rows.map((row) => (
            <EventRow key={row.id} row={row} onOpenStock={onOpenStock} />
          ))}
        </ul>
      ) : null}
      {/* Placed here and not in the section's notes, which come last: "nothing
          listed" has to be read before the lines that qualify it. */}
      {note || empty ? (
        <p className={cn(QUIET_NOTE_CLASS, "mt-2")}>{note ?? "Nothing on the corporate calendar for the names held."}</p>
      ) : null}
      {/* What the list cannot know (fund distributions, splits not yet in
          effect) is said under it, so an empty list is never read as "clear". */}
      {view && view.coverageNotes.length > 0 ? (
        <div className="mt-2 space-y-1">
          {view.coverageNotes.map((line) => (
            <p key={line} className="text-[11.5px] leading-[1.5] text-[#9CA3AF]">
              {line}
            </p>
          ))}
        </div>
      ) : null}
    </BriefingSection>
  );
}
