import { Fragment, type Ref } from "react";
import { cn } from "@/lib/utils";
import type { CalendarItemView, CalendarView } from "../../../shared/briefing-view";
import { etClock } from "./briefing-clock";
import { HEAD_CLASS, MONO_CLASS } from "./briefing-styles";

/**
 * The day's calendar drawn as a rail: a time column, a hairline with a node
 * per row, the title and what it covers, and one accented line that says
 * where the day stands. The panel's "Today" column and the dashboard's
 * calendar card both draw it from here, so a row can never look like one
 * thing on the card and another in the panel.
 */

/** The one accent on the rail, kept for the line that says where the day stands. */
export const NOW_ACCENT = "#189E9A";

/** A row's three tracks: the time, the rail, the text. Exported so a skeleton can stand in the same tracks. */
export const ROW_GRID = "grid grid-cols-[44px_16px_minmax(0,1fr)] gap-x-2";

/**
 * Importance is carried by the node's shape and the title's weight, never by
 * colour. Red and green already mean direction elsewhere on the dashboard; a
 * red CPI row would read as "down" before it read as "important".
 */
function Node({ importance }: { importance: 1 | 2 | 3 }) {
  if (importance === 3) return <span className="h-[7px] w-[7px] rounded-full bg-[#1d1b1b]" />;
  // The ring is filled white so the rail does not show through its middle.
  if (importance === 2) return <span className="h-[7px] w-[7px] rounded-full border border-[#1d1b1b] bg-white" />;
  return <span className="h-1 w-1 rounded-full bg-[#9CA3AF]" />;
}

function ItemText({ item }: { item: CalendarItemView }) {
  return (
    <span className="min-w-0 pb-3">
      <span
        className={cn(
          "block text-[12.5px] leading-[1.4]",
          item.importance === 3 ? "font-medium text-[#1d1b1b]" : item.importance === 2 ? "text-[#1d1b1b]" : "text-[#6b7280]",
        )}
      >
        {item.title}
      </span>
      {item.detail ? <span className="block text-[11.5px] leading-[1.45] text-[#6b7280]">{item.detail}</span> : null}
      <span className={cn(HEAD_CLASS, "mt-0.5 block truncate")}>{[item.kindLabel, ...item.tickers].join(" · ")}</span>
    </span>
  );
}

/** A rail cell: the hairline runs the full height of the row, the node sits on it level with the title. */
function Rail({ importance }: { importance: 1 | 2 | 3 }) {
  return (
    <span className="relative flex justify-center" aria-hidden>
      <span className="absolute inset-y-0 w-px bg-black/[0.06]" />
      <span className="relative mt-[5px] flex h-[7px] items-center">
        <Node importance={importance} />
      </span>
    </span>
  );
}

/**
 * Where the wall clock stands against the session the rail lists. "on" is the
 * day itself, from midnight to midnight New York time, the close included: a
 * reader at 17:00 is still on the day the rows belong to. "before" is any
 * earlier clock: from the close of the session before, the report is already
 * for the next one, so this covers the evening, the night and every weekend
 * and holiday until the day comes. "after" is a report the clock has left
 * behind: the session closed on an earlier day and the store has not managed
 * to replace the report yet (a request that failed on waking, say).
 */
export type SessionStanding = "before" | "on" | "after";

export function sessionStanding(view: CalendarView, now: Date, closeAtIso: string): SessionStanding {
  if (view.nowOnTargetDay) return "on";
  const close = Date.parse(closeAtIso);
  const t = now.getTime();
  return Number.isFinite(close) && Number.isFinite(t) && t >= close ? "after" : "before";
}

/**
 * What the accented line says. The wall clock only belongs on it while the
 * reader is on the day the rail lists: "NOW 21:30" printed above "08:30
 * Consumer Price Index" would read as 21:30 coming first on a rail whose
 * whole grammar is chronological, and "BEFORE THE OPEN" under rows that are
 * all dimmed as past would call an ended session a coming one.
 */
export function nowMarkerLabel(standing: SessionStanding, now: Date): string {
  if (standing === "before") return "BEFORE THE OPEN";
  if (standing === "after") return "SESSION ENDED";
  const clock = etClock(now);
  return clock ? `NOW ${clock}` : "NOW";
}

export function NowMarker({ label, markerRef }: { label: string; markerRef?: Ref<HTMLDivElement> }) {
  return (
    <div ref={markerRef} className="flex items-center gap-2 pb-3">
      <span className={cn(MONO_CLASS, "text-[9.5px] tracking-[0.06em]")} style={{ color: NOW_ACCENT }}>
        {label}
      </span>
      <span className="h-px flex-1" style={{ backgroundColor: NOW_ACCENT }} aria-hidden />
    </div>
  );
}

/**
 * The rows, all-day ones first, then the timed ones with the "now" line among
 * them: before the first row still ahead, or under the last row once every
 * one is behind. Rows behind the line are dimmed. The caller owns the box the
 * rows scroll in, which is why the marker's ref is passed through: the caller
 * is the one that can scroll the line into view.
 */
export function CalendarRows({
  view,
  markerLabel,
  markerRef,
}: {
  view: CalendarView;
  markerLabel: string;
  markerRef?: Ref<HTMLDivElement>;
}) {
  const marker = <NowMarker label={markerLabel} markerRef={markerRef} />;
  return (
    <>
      {view.allDay.map((item) => (
        <div key={item.id} className={cn(ROW_GRID, item.past && "opacity-[0.45]")}>
          <span className={cn(HEAD_CLASS, "pt-[3px]")}>All day</span>
          <Rail importance={item.importance} />
          <ItemText item={item} />
        </div>
      ))}

      {view.timed.map((item, i) => (
        <Fragment key={item.id}>
          {i === view.nowIndex ? marker : null}
          <div className={cn(ROW_GRID, item.past && "opacity-[0.45]")}>
            <span className={cn(MONO_CLASS, "pt-px text-[11.5px] text-[#4b5563]")}>{item.timeLabel}</span>
            <Rail importance={item.importance} />
            <ItemText item={item} />
          </div>
        </Fragment>
      ))}
      {view.timed.length > 0 && view.nowIndex >= view.timed.length ? marker : null}
    </>
  );
}
