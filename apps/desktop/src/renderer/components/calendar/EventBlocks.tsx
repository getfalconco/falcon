import { forwardRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Theme } from "@/lib/theme";
import { eventShade } from "./calendar-colors";
import { hhmm } from "./calendar-dates";
import type { CalEvent } from "./calendar-model";
import { besideTitle, countryName, econLines, markOf, underTitle, type EconLines } from "./econ-lines";
import { RowMark } from "./Flag";

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
  /** The clock, for a speech's "Completed"; left out, a past row counts as begun. */
  nowMs?: number;
};

function ariaLabel(event: CalEvent, when: string, lines?: EconLines): string {
  return [event.title, when, event.tickers.join(" "), lines?.completed, lines?.actual, lines?.forecast, lines?.previous].filter(Boolean).join(", ");
}

/** The figures and the speech state of a row, in the reader's words and number format. */
function useLines(event: CalEvent, nowMs: number | undefined, past: boolean | undefined): EconLines {
  const { t, locale } = useI18n();
  const clock = nowMs ?? (past ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
  return econLines(event, clock, (key, params) => t(key, params), locale);
}

/** The round flag or the company's logo, to the right of the row's dot. */
export function Mark({ event, size = 13 }: { event: CalEvent; size?: number }) {
  const { t, locale } = useI18n();
  const mark = markOf(event);
  if (!mark.ticker && !mark.country) return null;
  return <RowMark ticker={mark.ticker} country={mark.country} size={size} label={mark.country ? countryName(mark.country, locale, t("calendar.econ.euroArea")) : undefined} />;
}

/** A block on the hour grid. `start`/`end` are minutes on the drawn day, for the time line. */
export const TimedBlock = forwardRef<HTMLButtonElement, Common & { start: number; end: number; compact: boolean; continuesBefore?: boolean; continuesAfter?: boolean; resizable?: boolean; onResizeDown?: (e: ReactPointerEvent<HTMLElement>) => void }>(
  function TimedBlock({ event, theme, selected, past, onPointerDown, onClick, style, className, start, end, compact, continuesBefore, continuesAfter, resizable, onResizeDown, nowMs }, ref) {
    const shade = eventShade(event.color, theme);
    const time = event.origin === "market" ? hhmm(start) : `${hhmm(start)} - ${hhmm(end)}`;
    const lines = useLines(event, nowMs, past);
    const beside = besideTitle(lines);
    const under = underTitle(lines);
    return (
      <button
        ref={ref}
        type="button"
        data-cal-event={event.id}
        aria-label={ariaLabel(event, time, lines)}
        aria-pressed={selected}
        onPointerDown={onPointerDown}
        onClick={onClick}
        className={cn(
          "group/ev absolute flex min-h-0 select-none flex-col overflow-hidden rounded-md pl-[7px] pr-1.5 text-left outline-none transition-[background-color,box-shadow,opacity] duration-150 focus-visible:ring-2 focus-visible:ring-black/20",
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
          <span className="flex min-w-0 items-center gap-1 text-[11px] leading-[1.2]" style={{ color: shade.text }}>
            <Mark event={event} size={14} />
            <span className="truncate">
              <span className="font-medium">{event.title}</span>
              <span className="tabular-nums" style={{ color: shade.subtext }}> {hhmm(start)}</span>
              {beside ? <span style={{ color: shade.subtext }}> {beside}</span> : null}
            </span>
          </span>
        ) : (
          <>
            <span className="flex min-w-0 items-start gap-1">
              <span className="mt-[1px] flex shrink-0">
                <Mark event={event} size={14} />
              </span>
              <span className={cn("min-w-0 text-[11.5px] font-medium leading-[1.25]", end - start < 50 ? "truncate" : "line-clamp-2")} style={{ color: shade.text }}>
                {event.title}
              </span>
            </span>
            <span className="truncate text-[10.5px] leading-[1.35] tabular-nums" style={{ color: shade.subtext }}>
              {[time, beside, ...(event.country ? [] : event.tickers)].filter(Boolean).join(" · ")}
            </span>
            {under && end - start >= 45 ? (
              <span className="truncate text-[10.5px] leading-[1.35] tabular-nums" style={{ color: shade.subtext }}>
                {under}
              </span>
            ) : null}
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
export const EventBar = forwardRef<
  HTMLButtonElement,
  Common & {
    zoneMinutes?: number | null;
    clippedStart?: boolean;
    clippedEnd?: boolean;
    /** A list row (the day's list): the previous figure, and the actual once out, on a line under the title. */
    detailed?: boolean;
  }
>(function EventBar({ event, theme, selected, past, onPointerDown, onClick, style, className, zoneMinutes, clippedStart, clippedEnd, nowMs, detailed }, ref) {
  const { t } = useI18n();
  const shade = eventShade(event.color, theme);
  const timed = !event.allDay;
  const when = timed && zoneMinutes != null ? hhmm(zoneMinutes) : t("calendar.detail.allDay");
  const lines = useLines(event, nowMs, past);
  const beside = besideTitle(lines);
  const under = detailed ? underTitle(lines) : null;
  // Inside the title's own run, so a narrow cell cuts the figure before the title.
  const besideText = beside ? <span className={cn("font-normal tabular-nums text-content-secondary", detailed ? "text-[11.5px]" : "text-[10.5px]")}> {beside}</span> : null;
  return (
    <button
      ref={ref}
      type="button"
      data-cal-event={event.id}
      aria-label={ariaLabel(event, when, lines)}
      aria-pressed={selected}
      onPointerDown={onPointerDown}
      onClick={onClick}
      title={event.title}
      className={cn(
        "flex min-w-0 select-none overflow-hidden rounded-md px-1.5 text-left text-[11px] leading-none outline-none transition-[background-color,box-shadow,opacity] duration-150 focus-visible:ring-2 focus-visible:ring-black/20",
        detailed ? "flex-col items-stretch justify-center gap-[3px] py-[7px] text-[12.5px]" : "h-[20px] items-center",
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
      <span className="flex min-w-0 items-center gap-1.5">
        {timed ? (
          <>
            <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: shade.accent }} aria-hidden />
            <Mark event={event} size={detailed ? 17 : 15} />
            <span className={cn("shrink-0 tabular-nums text-content-secondary", detailed ? "text-[12px]" : "text-[10.5px]")}>{when}</span>
            <span className="truncate text-content-primary">
              {event.title}
              {besideText}
            </span>
          </>
        ) : (
          <>
            <span className="h-[10px] w-[3px] shrink-0 rounded-full" style={{ backgroundColor: shade.accent }} aria-hidden />
            <Mark event={event} size={detailed ? 17 : 15} />
            <span className={cn("truncate", event.emphasis ? "font-semibold" : "font-medium")}>
              {event.title}
              {besideText}
            </span>
            {event.estimated ? <span className="shrink-0 text-[10px] opacity-70">est.</span> : null}
          </>
        )}
      </span>
      {under ? <span className={cn("truncate text-[11.5px] tabular-nums text-content-tertiary", timed ? "pl-[36px]" : "pl-[32px]")}>{under}</span> : null}
    </button>
  );
});
