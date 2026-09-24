import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { BriefingReport } from "../../../shared/briefing-types";
import { NOT_AVAILABLE, marketGroups, sinceLine } from "../../../shared/briefing-view";
import BriefingSection from "./BriefingSection";
import { HEAD_CLASS, MONO_CLASS, TONE_TEXT } from "./briefing-styles";

type Props = {
  report: BriefingReport | null;
  loading: boolean;
  /** The engine's degraded line for the market table. */
  note?: string | null;
};

/**
 * Where a withheld move would be. A market that has not traded since the last
 * US close has no move to report, and a blank cell would read as a row that
 * failed to load; the mark says "nothing here" and the state note beside the
 * name says why.
 *
 * It is the view's own missing-value mark, the one already printed in the
 * level column of the same row. A long dash would read the same way and break
 * the house typographic rule on screen.
 */
const NO_MOVE = NOT_AVAILABLE;

/** What a highlight in this table is about, for the gloss. */
const GLOSS_CONTEXT =
  "The overnight markets table of the handover briefing: the level and the move of each index, futures contract and macro rate since the last US close.";

export default function OvernightMarkets({ report, loading, note }: Props) {
  const groups = useMemo(() => (report ? marketGroups(report) : []), [report]);
  const empty = !loading && groups.length === 0;

  return (
    <BriefingSection
      label="OVERNIGHT MARKETS"
      aside={report ? sinceLine(report) : null}
      glossContext={GLOSS_CONTEXT}
      loading={loading}
      skeletonRows={6}
      notes={[note, empty && !note ? "No overnight prints yet." : null]}
    >
      {groups.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-5">
          {groups.map((group) => (
            <div key={group.key} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className={HEAD_CLASS}>{group.label}</span>
                {group.basisNote ? <span className="truncate text-[10.5px] text-[#9CA3AF]">{group.basisNote}</span> : null}
              </div>
              <ul className="mt-1">
                {group.rows.map((row) => (
                  <li key={row.symbol} className="grid grid-cols-[minmax(0,1fr)_84px_72px] items-baseline gap-3 py-[5px]">
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-[#1d1b1b]">{row.label}</span>
                      {row.stateNote ? <span className="block truncate text-[11px] leading-[1.35] text-[#9CA3AF]">{row.stateNote}</span> : null}
                    </span>
                    <span className={cn(MONO_CLASS, "text-right text-[12px] text-[#4b5563]")}>{row.last}</span>
                    <span className={cn(MONO_CLASS, "text-right text-[12px]", row.move ? TONE_TEXT[row.tone] : "text-[#9CA3AF]")}>
                      {row.move || NO_MOVE}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </BriefingSection>
  );
}
