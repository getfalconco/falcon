import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { BriefingReport } from "../../../shared/briefing-types";
import { implicationsView, type ImplicationView } from "../../../shared/briefing-view";
import BriefingSection from "./BriefingSection";
import { HEAD_CLASS, MONO_CLASS, PILL_CLASS, QUIET_NOTE_CLASS } from "./briefing-styles";

type Props = {
  report: BriefingReport | null;
  masked: boolean;
  loading: boolean;
  /**
   * Conclusions already carried by a story's "for your book" line, by id. They
   * are left out here so nothing is said twice; see `spokenImplicationIds`.
   */
  exclude?: ReadonlySet<string>;
  onOpenStock: (ticker: string) => void;
  className?: string;
};

/** The engine weighed the figures and none of them adds up to a conclusion worth leading with. */
const NOTHING_CLEARS = "Nothing in this morning's figures clears the bar for a conclusion.";

/** What a highlight inside this section is about, when the item itself has not said. */
const GLOSS_CONTEXT =
  "A conclusion in the handover briefing: what the overnight figures mean for the reader's book, with the figures it rests on and an either-way scenario.";

function ImplicationRow({ item, onOpenStock }: { item: ImplicationView; onOpenStock: (ticker: string) => void }) {
  return (
    <li className="grid grid-cols-[16px_minmax(0,1fr)_auto] gap-x-3 py-3" data-gloss-ticker={item.tickers[0]} data-gloss-context={item.headline}>
      <span className="pt-[3px] font-['Geist_Mono'] text-[11px] tabular-nums text-[#9CA3AF]">{item.index}</span>
      <div className="min-w-0 max-w-[68ch]">
        <p className="text-[15.5px] font-medium leading-snug text-[#1d1b1b]">{item.headline}</p>
        {item.because ? <p className="mt-1 text-[12.5px] leading-relaxed text-[#6b7280]">{item.because}</p> : null}
        {item.scenario ? (
          <p className="mt-1.5 flex items-baseline gap-2 text-[12.5px] leading-relaxed text-[#374151]">
            {/* A visual cue that the line is a hypothetical, not a word of the
                sentence: read aloud, "IF A 1% index move..." is not English. */}
            <span className={cn(HEAD_CLASS, "shrink-0")} aria-hidden>
              IF
            </span>
            <span className="min-w-0">
              {item.scenario}
              {item.scenarioUsd ? (
                <>
                  {" "}
                  <span className={cn(MONO_CLASS, "text-[11.5px] text-[#6b7280]")}>({item.scenarioUsd})</span>
                </>
              ) : null}
            </span>
          </p>
        ) : null}
      </div>
      <span className="flex max-w-[160px] flex-wrap content-start justify-end gap-1 pt-[3px]">
        {item.tickers.map((ticker) => (
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

/**
 * What the figures mean for this book: the report's conclusions, numbered,
 * each over the data it rests on and, where one can be sized, the either-way
 * scenario. It follows the stories, which carry the conclusions that belong
 * to an event; what is left here are the ones that stand on their own (a
 * concentration, an ex-dividend date, a release later today). Order and
 * wording are the engine's; this lays them out.
 */
export default function Implications({ report, masked, loading, exclude, onOpenStock, className }: Props) {
  const all = useMemo(() => (report ? implicationsView(report, masked) : []), [report, masked]);
  // Renumbered after the exclusion: a list that starts at 3 reads as one with
  // two rows missing, and the two are not missing, they are told above.
  const items = useMemo(
    () => (exclude && exclude.size > 0 ? all.filter((item) => !exclude.has(item.id)).map((item, i) => ({ ...item, index: i + 1 })) : all),
    [all, exclude],
  );

  // A report from a main process that predates conclusions carries no list at
  // all. "Nothing clears the bar" would then be said of figures nobody
  // weighed, so the section stays out and the handover note leads, as it did.
  if (!loading && !Array.isArray(report?.implications)) return null;
  // Every conclusion was said in a story. The section has nothing of its own
  // to add and no reason to say so.
  if (!loading && all.length > 0 && items.length === 0) return null;

  return (
    <BriefingSection label="WHAT IT MEANS FOR YOUR BOOK" loading={loading} skeletonRows={3} className={className} glossContext={GLOSS_CONTEXT}>
      {items.length > 0 ? (
        <ol className="divide-y-[0.5px] divide-black/[0.06]">
          {items.map((item) => (
            <ImplicationRow key={item.id} item={item} onOpenStock={onOpenStock} />
          ))}
        </ol>
      ) : (
        <p className={cn(QUIET_NOTE_CLASS, "mt-3")}>{NOTHING_CLEARS}</p>
      )}
    </BriefingSection>
  );
}
