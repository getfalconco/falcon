import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { BriefingReport } from "../../../shared/briefing-types";
import { storiesView, type StoryView } from "../../../shared/briefing-view";
import BriefingSection from "./BriefingSection";
import ReactionChip from "./ReactionChip";
import { HEAD_CLASS, PILL_CLASS, QUIET_NOTE_CLASS } from "./briefing-styles";

type Props = {
  report: BriefingReport | null;
  masked: boolean;
  loading: boolean;
  onOpenStock: (ticker: string) => void;
  className?: string;
};

/** A ready report with an empty list: the engine weighed the night and nothing in it makes a story. */
const NOTHING_ROSE = "Nothing since the close rises to a story; the figures are below.";

/** What a highlight inside this section is about, when the story block itself has not said. */
const GLOSS_CONTEXT = "A story from the handover briefing: what happened since the last US close and how the market or the held name reacted.";

function StoryBlock({ story, onOpenStock }: { story: StoryView; onOpenStock: (ticker: string) => void }) {
  return (
    // The block names its own subject for the gloss: a highlight of "beta" in
    // a story about NVDA is asked about with NVDA in hand, and the what
    // sentence stands as the context the highlighted words sit in.
    <li
      className="grid grid-cols-[64px_minmax(0,1fr)_auto] gap-x-3 py-3.5"
      data-gloss-ticker={story.tickers[0]}
      data-gloss-context={story.what}
    >
      <span className="pt-[4px] font-['Geist_Mono'] text-[10.5px] text-[#9CA3AF]">{story.at ?? ""}</span>
      <div className="min-w-0 max-w-[70ch]">
        <p className="text-[15.5px] font-medium leading-snug text-[#1d1b1b]">{story.what}</p>
        {story.reaction || story.reactions.length > 0 ? (
          <p className="mt-1.5 text-[13px] leading-relaxed text-[#374151]">
            {story.reaction}
            {story.reactions.length > 0 ? (
              <span className={cn("inline-flex flex-wrap gap-1 align-baseline", story.reaction && "ml-1.5")}>
                {story.reactions.map((reaction, i) => (
                  <ReactionChip key={`${reaction.label}-${i}`} reaction={reaction} />
                ))}
              </span>
            ) : null}
          </p>
        ) : null}
        {story.meaning ? (
          <p className="mt-2 flex items-baseline gap-2 text-[12.5px] leading-relaxed text-[#4b5563]">
            <span className={cn(HEAD_CLASS, "shrink-0 select-none")}>FOR YOUR BOOK</span>
            <span className="min-w-0">{story.meaning}</span>
          </p>
        ) : null}
      </div>
      <span className="flex max-w-[160px] flex-wrap content-start justify-end gap-1 pt-[3px]">
        {story.tickers.map((ticker) => (
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
 * What happened: the stories the report leads with. Each one is an event, the
 * reaction to it with the figures as chips, and, where something follows for
 * this book, what that is. A number on its own ("the S&P fell 0.39%") is not
 * a story and never leads here; the tables under THE FIGURES are where the
 * numbers live.
 *
 * A story written by the model and one assembled by the template look the
 * same: the template already reads as a complete sentence, and a badge or a
 * spinner would pull the eye to the one part of the panel that is fine as it
 * is. Order and wording are the engine's; this lays them out.
 */
export default function Stories({ report, masked, loading, onOpenStock, className }: Props) {
  const stories = useMemo(() => (report ? storiesView(report, masked) : []), [report, masked]);

  // A report from a main process that predates stories carries no list at
  // all. "Nothing rises to a story" would then be said of a night nobody
  // weighed, so the section stays out and the conclusions lead, as they did.
  if (!loading && !Array.isArray(report?.stories)) return null;

  return (
    <BriefingSection label="WHAT HAPPENED" loading={loading} skeletonRows={4} className={className} glossContext={GLOSS_CONTEXT}>
      {stories.length > 0 ? (
        <ol className="divide-y-[0.5px] divide-black/[0.06]">
          {stories.map((story) => (
            <StoryBlock key={story.id} story={story} onOpenStock={onOpenStock} />
          ))}
        </ol>
      ) : (
        <p className={cn(QUIET_NOTE_CLASS, "mt-3")}>{NOTHING_ROSE}</p>
      )}
    </BriefingSection>
  );
}
