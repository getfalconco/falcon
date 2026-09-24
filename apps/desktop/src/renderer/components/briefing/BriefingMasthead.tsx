import { useEffect, useState } from "react";
import { RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { manualRefreshAvailableAt } from "@/lib/briefing-store";
import type { BriefingReport } from "../../../shared/briefing-types";
import { mastheadDate, phaseChip, type PhaseChip } from "../../../shared/briefing-view";
import { etClock } from "./briefing-clock";
import { LABEL_CLASS, MONO_CLASS } from "./briefing-styles";

type Props = {
  /** The dialog is labelled by the masthead's own title. */
  titleId: string;
  report: BriefingReport | null;
  now: Date;
  refreshing: boolean;
  /** False where a refresh has nothing to do: a demo report, a main process without the handlers. */
  canRefresh: boolean;
  onRefresh: () => void;
  onClose: () => void;
};

const PHASE_DOT: Record<PhaseChip["tone"], string> = { pre: "#D97706", open: "#16A34A", closed: "#9CA3AF" };

const ICON_BUTTON =
  "app-no-drag rounded-lg p-1.5 text-[#6b7280] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b] disabled:pointer-events-none disabled:opacity-40";

const TAG = "rounded-full border-[0.5px] border-black/[0.12] px-2 py-0.5 text-[10.5px] text-[#6b7280]";

/**
 * The store throttles the manual refresh. The button rests for the same span,
 * read from the store and not timed here, so it also rests when the press
 * happened somewhere else (the dashboard card) a few seconds ago; a button
 * that looks ready and does nothing reads as broken.
 */
function useRefreshResting(): [boolean, () => void] {
  const [resting, setResting] = useState(() => Date.now() < manualRefreshAvailableAt());
  useEffect(() => {
    if (!resting) return;
    const timer = setTimeout(() => setResting(false), Math.max(0, manualRefreshAvailableAt() - Date.now()));
    return () => clearTimeout(timer);
  }, [resting]);
  return [resting, () => setResting(true)];
}

/** Doubles as the window drag strip while the panel is up, so every control on it opts out of dragging. */
export default function BriefingMasthead({ titleId, report, now, refreshing, canRefresh, onRefresh, onClose }: Props) {
  const [resting, rest] = useRefreshResting();
  const chip = report ? phaseChip(report, now) : null;
  const asOf = report ? etClock(report.generated_at) : null;

  return (
    <div className="app-drag-region flex shrink-0 items-center justify-between gap-4">
      <div className="flex min-w-0 items-baseline gap-3">
        <span id={titleId} className={LABEL_CLASS}>
          HANDOVER
        </span>
        {report ? <span className={cn(MONO_CLASS, "select-none text-[11px] tracking-[0.04em] text-[#6b7280]")}>{mastheadDate(report)}</span> : null}
      </div>

      <div className="flex shrink-0 items-center gap-2.5">
        {chip ? (
          <span className="inline-flex select-none items-center gap-1.5 rounded-full bg-[#1d1b1b]/[0.05] px-2.5 py-1 text-[11px] font-medium text-[#4b5563]">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: PHASE_DOT[chip.tone] }} aria-hidden />
            {`${chip.label} · ${chip.detail}`}
          </span>
        ) : null}
        {asOf ? <span className={cn(MONO_CLASS, "select-none text-[10.5px] text-[#9CA3AF]")}>{`as of ${asOf} ET`}</span> : null}
        {report?.synthetic_now ? <span className={cn(TAG, "select-none")}>simulated clock</span> : null}
        {report?.demo ? <span className={cn(TAG, "select-none")}>demo</span> : null}

        <button
          type="button"
          onClick={() => {
            onRefresh();
            rest();
          }}
          disabled={!canRefresh || resting || refreshing}
          aria-label="Refresh the handover"
          className={ICON_BUTTON}
        >
          <RotateCw className={cn("h-4 w-4", refreshing && "animate-spin motion-reduce:animate-none")} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" onClick={onClose} aria-label="Close" className={ICON_BUTTON}>
          <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </div>
  );
}
