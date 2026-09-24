import { useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { BriefingReport } from "../../../shared/briefing-types";
import { narrativeView } from "../../../shared/briefing-view";
import { QUIET_NOTE_CLASS } from "./briefing-styles";

type Props = {
  report: BriefingReport;
  masked: boolean;
  /** The degraded line for the narrative, when the engine reported one. */
  note?: string | null;
  className?: string;
};

/**
 * The lead: the one or two sentences over the stories, set directly under the
 * title as its subtitle. It is the whole night in a breath; the stories under
 * it are the same night told one event at a time.
 *
 * The report always arrives with the template text, and the model's version
 * follows a few seconds later. There is no spinner and no placeholder while
 * that is pending: the template is a complete summary of the same facts, so
 * the reader starts reading at once, and the text is exchanged with a fade
 * when the other version lands. A line that said something was still being
 * written would pull the eye to the one part of the panel that is already
 * fine to read.
 */
export default function BriefingNarrative({ report, masked, note, className }: Props) {
  const view = useMemo(() => narrativeView(report, masked), [report, masked]);
  const lead = view.sentences.join(" ");
  // The degraded line waits while the model's text is on its way: it says the
  // template stands in, and that may stop being true in a moment.
  const showNote = note && (lead === "" || !view.pending);
  if (lead === "" && !showNote) return null;

  return (
    <div className={className} data-gloss-context={lead || undefined}>
      {lead !== "" ? (
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={view.source}
            className="max-w-[70ch] font-sans text-[14.5px] leading-[1.6] text-[#4b5563]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
          >
            {lead}
          </motion.p>
        </AnimatePresence>
      ) : null}
      {showNote ? <p className={cn(QUIET_NOTE_CLASS, "mt-1.5")}>{note}</p> : null}
    </div>
  );
}
