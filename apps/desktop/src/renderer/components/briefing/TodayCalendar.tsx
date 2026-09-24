import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import type { BriefingReport } from "../../../shared/briefing-types";
import { calendarView } from "../../../shared/briefing-view";
import { CalendarRows, nowMarkerLabel, sessionStanding } from "./CalendarRail";
import { HEAD_CLASS, LABEL_CLASS, QUIET_NOTE_CLASS } from "./briefing-styles";

type Props = {
  report: BriefingReport | null;
  now: Date;
  loading: boolean;
  /** The engine's degraded line for the macro calendar. */
  note?: string | null;
};

/**
 * The panel's "Today" column: the session's calendar on the rail that
 * `CalendarRail` draws, under the column's own head and over the coverage
 * footnote. The dashboard's calendar card draws the same rail.
 */
export default function TodayCalendar({ report, now, loading, note }: Props) {
  const view = useMemo(() => (report ? calendarView(report, now) : null), [report, now]);
  const listRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const placed = useRef(false);

  // Once per opening, the list is scrolled so the "now" line sits mid-column: a
  // reader who opens the panel at 14:00 wants what is next, not the 08:30
  // print at the top. Only once, so the list never moves under a reader who
  // has scrolled it; and by hand, not with scrollIntoView, which would also
  // scroll every ancestor it can, the locked page behind the panel included.
  const ready = view !== null;
  useEffect(() => {
    if (!ready || placed.current) return;
    const list = listRef.current;
    const marker = markerRef.current;
    if (!list || !marker) return;
    placed.current = true;
    list.scrollTop = Math.max(0, marker.offsetTop - list.clientHeight / 2);
  }, [ready]);

  const nothing = view !== null && view.allDay.length === 0 && view.timed.length === 0;

  return (
    <>
      <div className="flex shrink-0 items-baseline justify-between gap-3 border-b-[0.5px] border-black/[0.06] pb-1.5">
        <h3 className={LABEL_CLASS}>TODAY</h3>
        <span className={HEAD_CLASS}>All times ET</span>
      </div>

      {loading ? (
        <div className="mt-3 space-y-3" aria-hidden>
          {["w-[80%]", "w-[64%]", "w-[72%]", "w-[58%]", "w-[76%]"].map((width, i) => (
            <div key={i} className={cn("h-3 animate-pulse rounded bg-black/[0.06] motion-reduce:animate-none", width)} />
          ))}
        </div>
      ) : null}

      {view ? (
        <div ref={listRef} className="scrollbar-meridian relative mt-3 min-h-0 flex-1 overflow-y-auto pr-1 max-[979px]:flex-none max-[979px]:overflow-visible">
          {report?.window.early_close ? (
            <p className="pb-3 text-[12px] leading-[1.45] text-[#D97706]">Early close: this session ends at 13:00 ET.</p>
          ) : null}

          <CalendarRows
            view={view}
            markerLabel={nowMarkerLabel(report ? sessionStanding(view, now, report.window.target_close_at) : "on", now)}
            markerRef={markerRef}
          />

          {nothing && !note ? <p className={QUIET_NOTE_CLASS}>Nothing scheduled for this session.</p> : null}
        </div>
      ) : (
        <div className="min-h-0 flex-1" />
      )}

      <div className="mt-3 shrink-0 space-y-1 border-t-[0.5px] border-black/[0.06] pt-2">
        {note ? <p className="text-[11px] leading-[1.45] text-[#9CA3AF]">{note}</p> : null}
        {view ? (
          <p className={cn("text-[11px] leading-[1.45]", view.footnote.tone === "warn" ? "text-[#D97706]" : "text-[#9CA3AF]")}>
            {view.footnote.text}
          </p>
        ) : null}
      </div>
    </>
  );
}
