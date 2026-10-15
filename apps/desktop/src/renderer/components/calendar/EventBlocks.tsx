import { forwardRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Theme } from "@/lib/theme";
import { eventShade } from "./calendar-colors";
import { hhmm } from "./calendar-dates";
import type { CalEvent } from "./calendar-model";

/**
 * How one event looks, wherever it is drawn: a block on the hour grid, a bar
 * in the all-day lane or a month cell, a line in a list. Soft tint, a stripe
 * of the full colour down the leading edge, the title in the colour's deep
 * shade. Past events fade a little, the way the dashboard rail dims rows
 * behind the "now" line.
 */

type Common = {
  event: CalEvent;
  theme: Theme;
  selected?: boolean;
  past?: boolean;
  onPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  style?: CSSProperties;
  className?: string;
};

function ariaLabel(event: CalEvent, when: string): string {
  return [event.title, when, event.tickers.join(" ")].filter(Boolean).join(", ");
}

/** A block on the hour grid. `start`/`end` are minutes on the drawn day, for the time line. */
export const TimedBlock = forwardRef<HTMLButtonElement, Common & { start: number; end: number; compact: boolean; continuesBefore?: boolean; continuesAfter?: boolean; resizable?: boolean; onResizeDown?: (e: ReactPointerEvent<HTMLElement>) => void }>(
  function TimedBlock({ event, theme, selected, past, onPointerDown, onClick, style, className, start, end, compact, continuesBefore, continuesAfter, resizable, onResizeDown }, ref) {
    const shade = eventShade(event.color, theme);
    const time = event.origin === "market" ? hhmm(start) : `${hhmm(start)} - ${hhmm(end)}`;
    return (
      <button
        ref={ref}
        type="button"
        data-cal-event={event.id}
        aria-label={ariaLabel(event, time)}
        aria-pressed={selected}
        onPointerDown={onPointerDown}
        onClick={onClick}
        className={cn(
          "group/ev absolute flex min-h-0 select-none flex-col overflow-hidden rounded-[7px] pl-[7px] pr-1.5 text-left outline-none transition-[background-color,box-shadow,opacity] duration-150 focus-visible:ring-2 focus-visible:ring-black/20",
          compact ? "justify-center py-0" : "py-[3px]",
          continuesBefore && "rounded-t-none",
          continuesAfter && "rounded-b-none",
          past && !selected && "opacity-[0.55] hover:opacity-90",
          event.user ? "cursor-grab active:cursor-grabbing" : "cursor-default",
          className,
        )}
        style={{
          backgroundColor: selected ? shade.bgActive : shade.bg,
          boxShadow: selected ? `0 0 0 1.5px ${shade.accent}, 0 6px 16px rgba(0,0,0,0.12)` : undefined,
          ...style,
        }}
      >
        <span className="absolute inset-y-[3px] left-[2px] w-[3px] rounded-full" style={{ backgroundColor: shade.accent }} aria-hidden />
        {compact ? (
          <span className="truncate text-[11px] leading-[1.2]" style={{ color: shade.text }}>
            <span className="font-medium">{event.title}</span>
            <span style={{ color: shade.subtext }}> {hhmm(start)}</span>
          </span>
        ) : (
          <>
            <span className={cn("text-[11.5px] font-medium leading-[1.25]", end - start < 50 ? "truncate" : "line-clamp-2")} style={{ color: shade.text }}>
              {event.title}
            </span>
            <span className="truncate font-['Geist_Mono'] text-[10px] leading-[1.35] tabular-nums" style={{ color: shade.subtext }}>
              {[time, ...event.tickers].join(" · ")}
            </span>
          </>
        )}
        {resizable ? (
          <span
            role="presentation"
            onPointerDown={onResizeDown}
            className="absolute inset-x-0 bottom-0 h-[6px] cursor-ns-resize opacity-0 transition-opacity group-hover/ev:opacity-100"
          >
            <span className="mx-auto mt-[2px] block h-[2px] w-5 rounded-full" style={{ backgroundColor: shade.accent }} />
          </span>
        ) : null}
      </button>
    );
  },
);

/** A bar: all-day lane, month cell. A timed event in a month cell is a dot, its time and its title instead. */
export const EventBar = forwardRef<HTMLButtonElement, Common & { zoneMinutes?: number | null; clippedStart?: boolean; clippedEnd?: boolean }>(function EventBar(
  { event, theme, selected, past, onPointerDown, onClick, style, className, zoneMinutes, clippedStart, clippedEnd },
  ref,
) {
  const t = useT();
  const shade = eventShade(event.color, theme);
  const timed = !event.allDay;
  const when = timed && zoneMinutes != null ? hhmm(zoneMinutes) : t("calendar.detail.allDay");
  return (
    <button
      ref={ref}
      type="button"
      data-cal-event={event.id}
      aria-label={ariaLabel(event, when)}
      aria-pressed={selected}
      onPointerDown={onPointerDown}
      onClick={onClick}
      title={event.title}
      className={cn(
        "flex h-[20px] min-w-0 select-none items-center gap-1.5 overflow-hidden rounded-[6px] px-1.5 text-left text-[11px] leading-none outline-none transition-[background-color,box-shadow,opacity] duration-150 focus-visible:ring-2 focus-visible:ring-black/20",
        clippedStart && "rounded-l-none",
        clippedEnd && "rounded-r-none",
        past && !selected && "opacity-[0.55] hover:opacity-90",
        event.user ? "cursor-grab active:cursor-grabbing" : "cursor-default",
        className,
      )}
      style={{
        backgroundColor: timed ? (selected ? shade.bg : "transparent") : selected || event.emphasis ? shade.bgActive : shade.bg,
        // A held name's date (with "Highlight your positions" on) carries a hairline of its colour, so it reads first in a busy lane.
        boxShadow: selected && !timed ? `0 0 0 1.5px ${shade.accent}` : event.emphasis && !timed ? `inset 0 0 0 1px ${shade.accent}80` : undefined,
        color: timed ? undefined : shade.text,
        ...style,
      }}
    >
      {timed ? (
        <>
          <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: shade.accent }} aria-hidden />
          <span className="shrink-0 font-['Geist_Mono'] text-[10px] tabular-nums text-[#6b7280]">{when}</span>
          <span className="truncate text-[#1d1b1b]">{event.title}</span>
        </>
      ) : (
        <>
          <span className="h-[10px] w-[3px] shrink-0 rounded-full" style={{ backgroundColor: shade.accent }} aria-hidden />
          <span className={cn("truncate", event.emphasis ? "font-semibold" : "font-medium")}>{event.title}</span>
          {event.estimated ? <span className="shrink-0 text-[10px] opacity-70">est.</span> : null}
        </>
      )}
    </button>
  );
});
