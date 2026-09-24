import { cn } from "@/lib/utils";
import type { StoryReactionView } from "../../../shared/briefing-view";
import { CHIP_CLASS, TONE_TEXT } from "./briefing-styles";

/**
 * One figure a story rests on, beside the sentence that names it: the label
 * in grey, the move in the tone of its sign. The dashboard card and the panel
 * draw the same chip, so a reader who saw "S&P fut +0.42%" on the card finds
 * the same thing where the story is told in full.
 */
export default function ReactionChip({ reaction, className }: { reaction: StoryReactionView; className?: string }) {
  return (
    <span className={cn(CHIP_CLASS, className)}>
      <span>{reaction.label}</span>
      <span className={TONE_TEXT[reaction.tone]}>{reaction.move}</span>
    </span>
  );
}
