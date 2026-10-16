import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Theme } from "@/lib/theme";
import { nowLineColor } from "./calendar-colors";
import { addDays, longDay, sameMonth, shortDay, weekday, weekdayName, zonedParts, zonedWallToMs } from "./calendar-dates";
import { fitRows, packSpans } from "./calendar-layout";
import { compareEvents, eventOnDay, type CalEvent } from "./calendar-model";
import { capturePointer, rectOf, type AnchorRect } from "./CalendarPopover";
import { EventBar } from "./EventBlocks";
import { MONO_HEAD } from "./calendar-styles";
import type { CreateRequest, DraftPreview, MoveRequest } from "./TimeGridView";

/**
 * Month view: six weeks of cells. Multi-day events run as bars across the
 * week they fall in; a timed event is a dot, its time and its title. A cell
 * shows what fits and a "+N more" line for the rest, which opens the day's
 * full list. A press on an empty part of a cell makes an all-day event there;
 * your own events can be dragged to another day, keeping their time.
 */

const ROW_PX = 22;
const HEAD_PX = 28;
const DRAG_THRESHOLD = 4;

type Props = {
  days: string[]; // 42
  anchor: string;
  today: string;
  zone: string | undefined;
  events: CalEvent[];
  nowMs: number;
  theme: Theme;
  selectedId: string | null;
  draft: DraftPreview;
  onSelect: (event: CalEvent, anchor: AnchorRect) => void;
  onCreate: (request: CreateRequest, anchor: AnchorRect) => void;
  onMove: (event: CalEvent, request: MoveRequest) => void;
  onShowDay: (ymd: string, events: CalEvent[], anchor: AnchorRect) => void;
  onOpenDay: (ymd: string) => void;
};

type Drag = { event: CalEvent; fromYmd: string; overYmd: string; x: number; y: number; moved: boolean; anchor: AnchorRect };

/** Sort keys for the packer: all-day before timed, timed by the clock. */
function packId(e: CalEvent, zone: string | undefined): string {
  if (e.allDay) return `a:${String(9 - e.importance)}:${e.id}`;
  const m = e.startMs === null ? 0 : zonedParts(e.startMs, zone).minutes;
  return `t:${String(m).padStart(4, "0")}:${e.id}`;
}

export default function MonthView(props: Props) {
  const { days, anchor, today, zone, events, nowMs, theme, selectedId, draft } = props;
  const { t, locale } = useI18n();
  const gridRef = useRef<HTMLDivElement>(null);
  const [rowsFit, setRowsFit] = useState(3);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  // How many event rows a cell has room for, from its measured height.
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const cellHeight = el.clientHeight / 6;
      setRowsFit(Math.max(1, Math.floor((cellHeight - HEAD_PX - 4) / ROW_PX)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const weeks = useMemo(() => Array.from({ length: 6 }, (_, w) => days.slice(w * 7, w * 7 + 7)), [days]);

  const byPackId = useMemo(() => {
    const map = new Map<string, CalEvent>();
    for (const e of events) map.set(packId(e, zone), e);
    return map;
  }, [events, zone]);

  /** Every event as a run of dates in the viewing zone. A dragged one is drawn where it would land. */
  const spanItems = useMemo(() => {
    const items: Array<{ id: string; start: string; end: string }> = [];
    for (const [id, e] of byPackId) {
      let start: string;
      let end: string;
      if (e.allDay) {
        start = e.startDate;
        end = e.endDate;
      } else {
        if (e.startMs === null || e.endMs === null) continue;
        start = zonedParts(e.startMs, zone).ymd;
        end = start;
      }
      if (drag && drag.moved && drag.event.id === e.id) {
        const shift = Math.round((Date.parse(`${drag.overYmd}T12:00:00Z`) - Date.parse(`${drag.fromYmd}T12:00:00Z`)) / 86_400_000);
        start = addDays(start, shift);
        end = addDays(end, shift);
      }
      items.push({ id, start, end });
    }
    if (draft && draft.allDay) items.push({ id: "z:__draft", start: draft.date, end: draft.endDate });
    return items;
  }, [byPackId, zone, drag, draft]);

  const onBarDown = (e: ReactPointerEvent<HTMLElement>, event: CalEvent, ymd: string) => {
    if (e.button !== 0 || !event.user) return;
    e.stopPropagation();
    capturePointer(e.currentTarget, e.pointerId);
    setDrag({ event, fromYmd: ymd, overYmd: ymd, x: e.clientX, y: e.clientY, moved: false, anchor: rectOf(e.currentTarget) });
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const moved = d.moved || Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_THRESHOLD;
      const cell = document.elementsFromPoint(e.clientX, e.clientY).find((el) => (el as HTMLElement).dataset?.calDay) as HTMLElement | undefined;
      setDrag({ ...d, moved, overYmd: cell?.dataset.calDay ?? d.overYmd });
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      if (!d.moved) {
        props.onSelect(d.event, d.anchor);
        return;
      }
      if (d.overYmd === d.fromYmd) return;
      const shift = Math.round((Date.parse(`${d.overYmd}T12:00:00Z`) - Date.parse(`${d.fromYmd}T12:00:00Z`)) / 86_400_000);
      const ev = d.event;
      if (ev.allDay) {
        props.onMove(ev, { allDay: true, date: addDays(ev.startDate, shift), endDate: addDays(ev.endDate, shift) });
      } else if (ev.startMs !== null && ev.endMs !== null) {
        const start = zonedParts(ev.startMs, zone);
        const startMs = zonedWallToMs(addDays(start.ymd, shift), start.minutes, zone);
        props.onMove(ev, { allDay: false, startMs, endMs: startMs + (ev.endMs - ev.startMs) });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", () => setDrag(null), { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // The handlers read the live drag through the ref.
  }, [drag !== null]);

  const lineColor = nowLineColor(theme);
  const headDays = weeks[0] ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-7 border-b border-black/[0.06]">
        {headDays.map((ymd) => (
          <div key={ymd} className={cn(MONO_HEAD, "py-2 text-center")}>
            {weekdayName(weekday(ymd), locale)}
          </div>
        ))}
      </div>
      <div ref={gridRef} className="grid min-h-0 flex-1 grid-rows-6">
        {weeks.map((week, w) => {
          const placements = packSpans(spanItems, week);
          const fit = fitRows(placements, 7, rowsFit);
          return (
            <div key={week[0]} className={cn("relative grid min-h-0 grid-cols-7", w > 0 && "border-t border-black/[0.06]")}>
              {week.map((ymd, i) => {
                const isToday = ymd === today;
                const inMonth = sameMonth(ymd, anchor);
                const over = drag?.moved && drag.overYmd === ymd;
                return (
                  <div
                    key={ymd}
                    data-cal-day={ymd}
                    className={cn("relative min-h-0 cursor-cell border-l border-black/[0.06] transition-colors", i === 0 && "border-l-0", over && "bg-black/[0.04]")}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("[data-cal-event],[data-cal-more],[data-cal-date]")) return;
                      props.onCreate({ allDay: true, date: ymd, endDate: ymd }, rectOf(e.currentTarget));
                    }}
                  >
                    <div className="flex h-[28px] items-center px-1.5">
                      <button
                        type="button"
                        data-cal-date
                        onClick={() => props.onOpenDay(ymd)}
                        aria-label={t("calendar.openDay", { date: longDay(ymd, locale) })}
                        className={cn(
                          "app-no-drag flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1 text-[12px] tabular-nums transition-colors",
                          isToday ? "font-medium text-white" : inMonth ? "text-[#1d1b1b] hover:bg-black/[0.05]" : "text-[#9CA3AF] hover:bg-black/[0.05]",
                        )}
                        style={isToday ? { backgroundColor: lineColor } : undefined}
                      >
                        {Number(ymd.slice(8)) === 1 ? shortDay(ymd, locale) : Number(ymd.slice(8))}
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Bars, over the cells. */}
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 grid grid-cols-7"
                style={{ top: HEAD_PX, gridAutoRows: `${ROW_PX}px`, alignContent: "start" }}
              >
                {placements.map((p) => {
                  if (!fit.drawn.has(p.id)) return null;
                  if (p.id === "z:__draft") {
                    return (
                      <div
                        key={p.id}
                        className="mx-1 my-[1px] rounded-[6px] border border-dashed border-black/20 bg-black/[0.04]"
                        style={{ gridColumn: `${p.startIndex + 1} / span ${p.span}`, gridRow: p.row + 1 }}
                      />
                    );
                  }
                  const event = byPackId.get(p.id);
                  if (!event) return null;
                  const ymd = week[p.startIndex];
                  const minutes = !event.allDay && event.startMs !== null ? zonedParts(event.startMs, zone).minutes : null;
                  const past = event.allDay ? event.endDate < today : (event.endMs ?? 0) <= nowMs;
                  return (
                    <div key={p.id} className="pointer-events-auto min-w-0 px-1 py-[1px]" style={{ gridColumn: `${p.startIndex + 1} / span ${p.span}`, gridRow: p.row + 1 }}>
                      <EventBar
                        event={event}
                        theme={theme}
                        selected={selectedId === event.id}
                        past={past}
                        nowMs={nowMs}
                        zoneMinutes={minutes}
                        clippedStart={event.allDay && event.startDate < week[p.startIndex]}
                        clippedEnd={event.allDay && event.endDate > week[p.startIndex + p.span - 1]}
                        className="w-full"
                        onPointerDown={(e) => onBarDown(e, event, ymd)}
                        onClick={(e) => {
                          if (!event.user) props.onSelect(event, rectOf(e.currentTarget));
                        }}
                      />
                    </div>
                  );
                })}
                {fit.hidden.map((n, i) =>
                  n > 0 ? (
                    <button
                      key={`more-${week[i]}`}
                      type="button"
                      data-cal-more
                      onClick={(e) => {
                        const ymd = week[i];
                        const list = events.filter((ev) => eventOnDay(ev, ymd, zone)).sort(compareEvents);
                        props.onShowDay(ymd, list, rectOf(e.currentTarget));
                      }}
                      className="app-no-drag pointer-events-auto mx-1 truncate rounded-[6px] px-1.5 text-left text-[11px] text-[#6b7280] hover:bg-black/[0.05] hover:text-[#1d1b1b]"
                      style={{ gridColumn: `${i + 1} / span 1`, gridRow: rowsFit }}
                    >
                      {t("calendar.more", { n })}
                    </button>
                  ) : null,
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
