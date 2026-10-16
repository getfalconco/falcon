import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Theme } from "@/lib/theme";
import { nowLineColor } from "./calendar-colors";
import { MINUTES_PER_DAY, addDays, hhmm, longDay, snapMinutes, weekday, weekdayName, zonedParts, zonedWallToMs } from "./calendar-dates";
import { fitRows, packSpans, packTimed } from "./calendar-layout";
import { compareEvents, timedSegments, type CalEvent, type DaySegment } from "./calendar-model";
import { capturePointer, rectOf, type AnchorRect } from "./CalendarPopover";
import { EventBar, TimedBlock } from "./EventBlocks";
import { MONO_HEAD } from "./calendar-styles";

/**
 * Week and day view: a column per day under its date, the all-day lane, and
 * the hour grid with the current-time line.
 *
 * Pointer work on the grid: press and drag on empty space to sketch a new
 * event (a plain click makes an hour), press a block of your own to move it
 * (across days too), or its bottom edge to change its end. Market events only
 * open their details. Everything snaps to a quarter hour.
 */

export const HOUR_PX = 44;
const PX_PER_MIN = HOUR_PX / 60;
const GUTTER = 52;
/** A block is never drawn shorter than this, so a release at an instant still has room for its title. */
const MIN_BLOCK_MIN = 22;
const ALL_DAY_ROW = 22;
const ALL_DAY_COLLAPSED_ROWS = 3;
const DRAG_THRESHOLD = 4;

export type CreateRequest =
  | { allDay: true; date: string; endDate: string }
  | { allDay: false; startMs: number; endMs: number };

export type MoveRequest =
  | { allDay: true; date: string; endDate: string }
  | { allDay: false; startMs: number; endMs: number };

/** The ghost of an event being drawn in the editor: where a new one would go. */
export type DraftPreview = CreateRequest | null;

type Props = {
  days: string[];
  today: string;
  zone: string | undefined;
  zoneText: string;
  events: CalEvent[];
  nowMs: number;
  theme: Theme;
  selectedId: string | null;
  draft: DraftPreview;
  /** Per day: the US regular session in minutes of the viewing zone, for the faint band. */
  sessions: Record<string, { open: number; close: number } | null>;
  onSelect: (event: CalEvent, anchor: AnchorRect) => void;
  onCreate: (request: CreateRequest, anchor: AnchorRect) => void;
  onMove: (event: CalEvent, request: MoveRequest) => void;
  onOpenDay: (ymd: string) => void;
};

type Gesture =
  | { kind: "create"; dayIndex: number; startMin: number; currentMin: number; moved: boolean; x: number; y: number }
  | { kind: "move"; event: CalEvent; seg: DaySegment; dayIndex: number; x: number; y: number; deltaMin: number; deltaDays: number; moved: boolean; anchor: AnchorRect }
  | { kind: "resize"; event: CalEvent; seg: DaySegment; y: number; deltaMin: number; moved: boolean }
  | { kind: "bar"; event: CalEvent; x: number; dayIndex: number; deltaDays: number; moved: boolean; anchor: AnchorRect };

export default function TimeGridView(props: Props) {
  const { days, today, zone, events, nowMs, theme, selectedId, draft, sessions } = props;
  const { t, locale } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  gestureRef.current = gesture;
  const [laneOpen, setLaneOpen] = useState(false);

  const now = zonedParts(nowMs, zone);
  const todayIndex = days.indexOf(today);

  // --- All-day lane --------------------------------------------------------
  const allDay = useMemo(() => events.filter((e) => e.allDay).sort(compareEvents), [events]);
  const allDayById = useMemo(() => new Map(allDay.map((e) => [e.id, e])), [allDay]);
  const spans = useMemo(() => {
    const items = allDay.map((e) => ({ id: e.id, start: e.startDate, end: e.endDate }));
    // A bar being dragged is drawn where it would land.
    const g = gesture;
    if (g && g.kind === "bar" && g.moved) {
      const it = items.find((i) => i.id === g.event.id);
      if (it) {
        it.start = addDays(it.start, g.deltaDays);
        it.end = addDays(it.end, g.deltaDays);
      }
    }
    if (draft && draft.allDay) items.push({ id: "__draft", start: draft.date, end: draft.endDate });
    return packSpans(items, days);
  }, [allDay, days, gesture, draft]);
  const rowCount = spans.reduce((n, s) => Math.max(n, s.row + 1), 0);
  const fit = useMemo(() => fitRows(spans, days.length, laneOpen ? Number.MAX_SAFE_INTEGER : ALL_DAY_COLLAPSED_ROWS), [spans, days.length, laneOpen]);
  const anyHidden = fit.hidden.some((h) => h > 0);
  const shownRows = laneOpen ? rowCount : Math.min(rowCount, ALL_DAY_COLLAPSED_ROWS);

  // --- Timed ---------------------------------------------------------------
  const segmentsByDay = useMemo(() => {
    const out = days.map(() => [] as DaySegment[]);
    for (const e of events) {
      if (e.allDay) continue;
      for (const seg of timedSegments(e, days, zone)) out[days.indexOf(seg.ymd)]?.push(seg);
    }
    return out;
  }, [events, days, zone]);

  const placements = useMemo(
    () =>
      segmentsByDay.map((segs) => {
        const packed = packTimed(
          segs.map((s) => ({ id: s.event.id, start: s.start, end: s.end })),
          MIN_BLOCK_MIN,
        );
        return new Map(packed.map((p) => [p.id, p]));
      }),
    [segmentsByDay],
  );

  // --- Scroll to the working day -------------------------------------------
  const scrollKey = `${days[0]}:${days.length}`;
  const placedFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || placedFor.current === scrollKey) return;
    placedFor.current = scrollKey;
    const targetMin = todayIndex >= 0 ? Math.max(0, now.minutes - 120) : 7 * 60;
    el.scrollTop = targetMin * PX_PER_MIN;
  }, [scrollKey]);

  // --- Pointer gestures ----------------------------------------------------
  const columnRects = () => {
    const cols = columnsRef.current?.querySelectorAll<HTMLElement>("[data-cal-col]");
    return cols ? [...cols].map((c) => c.getBoundingClientRect()) : [];
  };
  const dayIndexAt = (clientX: number, rects: DOMRect[]): number => {
    if (rects.length === 0) return 0;
    for (let i = 0; i < rects.length; i++) if (clientX < rects[i].right) return i;
    return rects.length - 1;
  };
  const minuteAt = (clientY: number, colTop: number): number =>
    Math.min(MINUTES_PER_DAY, Math.max(0, (clientY - colTop) / PX_PER_MIN));

  const onColumnDown = (e: ReactPointerEvent<HTMLDivElement>, dayIndex: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-cal-event]")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const min = minuteAt(e.clientY, rect.top);
    capturePointer(e.currentTarget, e.pointerId);
    setGesture({ kind: "create", dayIndex, startMin: min, currentMin: min, moved: false, x: e.clientX, y: e.clientY });
  };

  const onEventDown = (e: ReactPointerEvent<HTMLElement>, seg: DaySegment, dayIndex: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const target = e.currentTarget;
    if (!seg.event.user) return; // market events: the click opens them
    capturePointer(target, e.pointerId);
    setGesture({ kind: "move", event: seg.event, seg, dayIndex, x: e.clientX, y: e.clientY, deltaMin: 0, deltaDays: 0, moved: false, anchor: rectOf(target) });
  };

  const onResizeDown = (e: ReactPointerEvent<HTMLElement>, seg: DaySegment) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    capturePointer(e.currentTarget, e.pointerId);
    setGesture({ kind: "resize", event: seg.event, seg, y: e.clientY, deltaMin: 0, moved: false });
  };

  const onBarDown = (e: ReactPointerEvent<HTMLElement>, event: CalEvent) => {
    if (e.button !== 0 || !event.user) return;
    e.stopPropagation();
    capturePointer(e.currentTarget, e.pointerId);
    const rects = columnRects();
    setGesture({ kind: "bar", event, x: e.clientX, dayIndex: dayIndexAt(e.clientX, rects), deltaDays: 0, moved: false, anchor: rectOf(e.currentTarget) });
  };

  useEffect(() => {
    if (!gesture) return;
    const onMove = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      if (g.kind === "create") {
        const rects = columnRects();
        const rect = rects[g.dayIndex];
        if (!rect) return;
        const currentMin = minuteAt(e.clientY, rect.top);
        const moved = g.moved || Math.abs(e.clientY - g.y) > DRAG_THRESHOLD;
        setGesture({ ...g, currentMin, moved });
      } else if (g.kind === "move") {
        const moved = g.moved || Math.hypot(e.clientX - g.x, e.clientY - g.y) > DRAG_THRESHOLD;
        const rects = columnRects();
        setGesture({ ...g, moved, deltaMin: snapMinutes((e.clientY - g.y) / PX_PER_MIN), deltaDays: dayIndexAt(e.clientX, rects) - g.dayIndex });
      } else if (g.kind === "resize") {
        setGesture({ ...g, moved: true, deltaMin: snapMinutes((e.clientY - g.y) / PX_PER_MIN) });
      } else if (g.kind === "bar") {
        const moved = g.moved || Math.abs(e.clientX - g.x) > DRAG_THRESHOLD;
        setGesture({ ...g, moved, deltaDays: dayIndexAt(e.clientX, columnRects()) - g.dayIndex });
      }
    };
    const onUp = () => {
      const g = gestureRef.current;
      setGesture(null);
      if (!g) return;
      finish(g);
    };
    const onCancel = () => setGesture(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [gesture !== null]);

  /** The rectangle a stretch of minutes covers in a column, for anchoring the editor. */
  const anchorFor = (dayIndex: number, startMin: number, endMin: number): AnchorRect => {
    const rect = columnRects()[dayIndex];
    if (!rect) return { left: 0, top: 0, right: 0, bottom: 0 };
    return { left: rect.left, right: rect.right, top: rect.top + startMin * PX_PER_MIN, bottom: rect.top + endMin * PX_PER_MIN };
  };

  const finish = (g: Gesture) => {
    if (g.kind === "create") {
      const ymd = days[g.dayIndex];
      let start: number;
      let end: number;
      if (!g.moved) {
        start = Math.min(MINUTES_PER_DAY - 60, Math.floor(g.startMin / 30) * 30);
        end = start + 60;
      } else {
        const a = snapMinutes(Math.min(g.startMin, g.currentMin));
        const b = snapMinutes(Math.max(g.startMin, g.currentMin));
        start = a;
        end = Math.max(b, a + 15);
      }
      props.onCreate(
        { allDay: false, startMs: zonedWallToMs(ymd, start, zone), endMs: zonedWallToMs(ymd, Math.min(end, MINUTES_PER_DAY), zone) },
        anchorFor(g.dayIndex, start, end),
      );
      return;
    }
    if (g.kind === "move") {
      if (!g.moved) {
        props.onSelect(g.event, g.anchor);
        return;
      }
      if ((g.deltaMin === 0 && g.deltaDays === 0) || g.event.startMs === null || g.event.endMs === null) return;
      const start = zonedParts(g.event.startMs, zone);
      const startMs = zonedWallToMs(addDays(start.ymd, g.deltaDays), start.minutes + g.deltaMin, zone);
      props.onMove(g.event, { allDay: false, startMs, endMs: startMs + (g.event.endMs - g.event.startMs) });
      return;
    }
    if (g.kind === "resize") {
      if (g.deltaMin === 0 || g.event.startMs === null || g.event.endMs === null) return;
      const endParts = zonedParts(g.event.endMs, zone);
      const endMs = Math.max(g.event.startMs + 15 * 60_000, zonedWallToMs(endParts.ymd, endParts.minutes + g.deltaMin, zone));
      props.onMove(g.event, { allDay: false, startMs: g.event.startMs, endMs });
      return;
    }
    if (g.kind === "bar") {
      if (!g.moved) {
        props.onSelect(g.event, g.anchor);
        return;
      }
      if (g.deltaDays === 0) return;
      props.onMove(g.event, { allDay: true, date: addDays(g.event.startDate, g.deltaDays), endDate: addDays(g.event.endDate, g.deltaDays) });
    }
  };

  /** Where a segment is drawn right now: moved or stretched while dragged. */
  const liveSegment = (seg: DaySegment, dayIndex: number): { dayIndex: number; start: number; end: number } => {
    const g = gesture;
    if (g && g.kind === "move" && g.moved && g.event.id === seg.event.id) {
      const length = seg.end - seg.start;
      const start = Math.min(MINUTES_PER_DAY - Math.min(length, 15), Math.max(-length + 15, seg.start + g.deltaMin));
      return { dayIndex: Math.min(days.length - 1, Math.max(0, dayIndex + g.deltaDays)), start: Math.max(0, start), end: Math.min(MINUTES_PER_DAY, start + length) };
    }
    if (g && g.kind === "resize" && g.event.id === seg.event.id && !seg.continuesAfter) {
      return { dayIndex, start: seg.start, end: Math.max(seg.start + 15, seg.end + g.deltaMin) };
    }
    return { dayIndex, start: seg.start, end: seg.end };
  };

  const createGhost = (() => {
    const g = gesture;
    if (g && g.kind === "create" && g.moved) {
      const a = snapMinutes(Math.min(g.startMin, g.currentMin));
      const b = Math.max(snapMinutes(Math.max(g.startMin, g.currentMin)), a + 15);
      return { dayIndex: g.dayIndex, start: a, end: b };
    }
    if (draft && !draft.allDay) {
      const s = zonedParts(draft.startMs, zone);
      const e = zonedParts(draft.endMs, zone);
      const dayIndex = days.indexOf(s.ymd);
      if (dayIndex === -1) return null;
      return { dayIndex, start: s.minutes, end: e.ymd === s.ymd ? e.minutes : MINUTES_PER_DAY };
    }
    return null;
  })();

  const lineColor = nowLineColor(theme);
  const cols = `${GUTTER}px repeat(${days.length}, minmax(0, 1fr))`;
  const sessionTint = theme === "dark" ? "rgba(255,255,255,0.022)" : "rgba(29,27,27,0.022)";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Day heads */}
      <div className="grid shrink-0 border-b border-black/[0.06]" style={{ gridTemplateColumns: cols }}>
        <div className={cn(MONO_HEAD, "flex items-end justify-end pb-1.5 pr-2 text-right normal-case leading-[1.2] tracking-normal")}>{props.zoneText}</div>
        {days.map((ymd) => {
          const isToday = ymd === today;
          const dow = weekday(ymd);
          return (
            <button
              key={ymd}
              type="button"
              onClick={() => props.onOpenDay(ymd)}
              className="app-no-drag group flex items-center justify-center gap-1.5 py-2 outline-none"
              aria-label={t("calendar.openDay", { date: longDay(ymd, locale) })}
            >
              <span className={cn(MONO_HEAD, (dow === 0 || dow === 6) && "opacity-70")}>{weekdayName(dow, locale)}</span>
              <span
                className={cn(
                  "flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[13px] tabular-nums transition-colors",
                  isToday ? "font-medium text-white" : "text-[#1d1b1b] group-hover:bg-black/[0.05]",
                )}
                style={isToday ? { backgroundColor: lineColor } : undefined}
              >
                {Number(ymd.slice(8))}
              </span>
            </button>
          );
        })}
      </div>

      {/* All-day lane */}
      <div className="grid shrink-0 border-b border-black/[0.06]" style={{ gridTemplateColumns: cols }}>
        <div className="flex items-start justify-end gap-0.5 pr-1.5 pt-1.5">
          {anyHidden || laneOpen ? (
            <button
              type="button"
              onClick={() => setLaneOpen((v) => !v)}
              className="app-no-drag flex h-5 w-5 items-center justify-center rounded-md text-[#9CA3AF] hover:bg-black/[0.05] hover:text-[#1d1b1b]"
              aria-label={laneOpen ? t("calendar.lane.collapse") : t("calendar.lane.expand")}
              aria-expanded={laneOpen}
            >
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", laneOpen && "rotate-180")} strokeWidth={2} />
            </button>
          ) : null}
          <span className={cn(MONO_HEAD, "pt-[3px] normal-case")}>{t("calendar.allDayLabel")}</span>
        </div>
        <div
          className="scrollbar-meridian relative max-h-[148px] overflow-y-auto"
          style={{ gridColumn: `2 / span ${days.length}` }}
        >
          <div
            className="relative grid py-1"
            style={{
              gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
              gridAutoRows: `${ALL_DAY_ROW}px`,
              minHeight: Math.max(1, shownRows + (anyHidden ? 1 : 0)) * ALL_DAY_ROW + 8,
            }}
          >
            {/* Empty cells: a click makes an all-day event on that day. */}
            {days.map((ymd, i) => (
              <div
                key={ymd}
                className={cn("absolute inset-y-0 border-l border-black/[0.06]", i === 0 && "border-l-0")}
                style={{ left: `${(i / days.length) * 100}%`, width: `${100 / days.length}%` }}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("[data-cal-event]")) return;
                  props.onCreate({ allDay: true, date: ymd, endDate: ymd }, rectOf(e.currentTarget));
                }}
              />
            ))}
            {spans.map((p) => {
              if (!fit.drawn.has(p.id)) return null;
              if (p.id === "__draft") {
                return (
                  <div
                    key="__draft"
                    className="pointer-events-none z-[1] mx-0.5 rounded-[6px] border border-dashed border-black/20 bg-black/[0.04]"
                    style={{ gridColumn: `${p.startIndex + 1} / span ${p.span}`, gridRow: p.row + 1 }}
                  />
                );
              }
              const event = allDayById.get(p.id);
              if (!event) return null;
              return (
                <div key={p.id} className="z-[1] min-w-0 px-0.5" style={{ gridColumn: `${p.startIndex + 1} / span ${p.span}`, gridRow: p.row + 1 }}>
                  <EventBar
                    event={event}
                    theme={theme}
                    selected={selectedId === event.id}
                    past={event.endDate < today}
                    nowMs={nowMs}
                    clippedStart={event.startDate < days[p.startIndex]}
                    clippedEnd={event.endDate > days[p.startIndex + p.span - 1]}
                    className="w-full"
                    onPointerDown={(e) => onBarDown(e, event)}
                    onClick={(e) => {
                      if (!event.user) props.onSelect(event, rectOf(e.currentTarget));
                    }}
                  />
                </div>
              );
            })}
            {!laneOpen
              ? fit.hidden.map((n, i) =>
                  n > 0 ? (
                    <button
                      key={`more-${days[i]}`}
                      type="button"
                      onClick={() => setLaneOpen(true)}
                      className="app-no-drag z-[1] mx-0.5 truncate rounded-[6px] px-1.5 text-left text-[11px] text-[#6b7280] hover:bg-black/[0.05]"
                      style={{ gridColumn: `${i + 1} / span 1`, gridRow: ALL_DAY_COLLAPSED_ROWS }}
                    >
                      {t("calendar.more", { n })}
                    </button>
                  ) : null,
                )
              : null}
          </div>
        </div>
      </div>

      {/* Hour grid */}
      <div ref={scrollRef} className="scrollbar-meridian relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="relative grid" style={{ gridTemplateColumns: cols, height: 24 * HOUR_PX }}>
          {/* Hour labels and lines */}
          <div className="relative">
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <span key={h} className={cn(MONO_HEAD, "absolute right-2 -translate-y-1/2 normal-case tabular-nums")} style={{ top: h * HOUR_PX }}>
                {hhmm(h * 60)}
              </span>
            ))}
            {todayIndex >= 0 ? (
              <span
                className="absolute right-1 z-[3] -translate-y-1/2 rounded-[5px] px-1 py-px text-[10px] font-medium tabular-nums text-white"
                style={{ top: now.minutes * PX_PER_MIN, backgroundColor: lineColor }}
              >
                {hhmm(now.minutes)}
              </span>
            ) : null}
          </div>
          <div ref={columnsRef} className="relative grid" style={{ gridColumn: `2 / span ${days.length}`, gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {/* Lines across every column, drawn once. */}
            <div className="pointer-events-none absolute inset-0" aria-hidden>
              {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
                <div key={h} className="absolute inset-x-0 border-t border-black/[0.06]" style={{ top: h * HOUR_PX }} />
              ))}
            </div>
            {days.map((ymd, dayIndex) => {
              const session = sessions[ymd];
              return (
                <div
                  key={ymd}
                  data-cal-col
                  onPointerDown={(e) => onColumnDown(e, dayIndex)}
                  className={cn("relative h-full cursor-cell border-l border-black/[0.06]", dayIndex === 0 && "border-l-0")}
                >
                  {session ? (
                    <div
                      className="pointer-events-none absolute inset-x-0"
                      style={{ top: session.open * PX_PER_MIN, height: (session.close - session.open) * PX_PER_MIN, backgroundColor: sessionTint }}
                      title={t("calendar.note.sessionBand")}
                      aria-hidden
                    />
                  ) : null}
                </div>
              );
            })}

            {/* Blocks, drawn over the columns so a dragged one can cross between them. */}
            <div className="pointer-events-none absolute inset-0">
              {segmentsByDay.flatMap((segs, dayIndex) =>
                segs.map((seg) => {
                  const place = placements[dayIndex].get(seg.event.id);
                  const live = liveSegment(seg, dayIndex);
                  const dragging = gesture && (gesture.kind === "move" || gesture.kind === "resize") && gesture.event.id === seg.event.id && gesture.moved;
                  const columns = dragging ? 1 : (place?.columns ?? 1);
                  const column = dragging ? 0 : (place?.column ?? 0);
                  const widthPct = 100 / days.length;
                  const height = Math.max(MIN_BLOCK_MIN, live.end - live.start) * PX_PER_MIN - 2;
                  const compact = height < 34;
                  const past = (seg.event.endMs ?? 0) <= nowMs;
                  return (
                    <TimedBlock
                      key={`${seg.event.id}:${seg.ymd}`}
                      event={seg.event}
                      theme={theme}
                      start={live.start}
                      end={live.end}
                      compact={compact}
                      continuesBefore={seg.continuesBefore}
                      continuesAfter={seg.continuesAfter}
                      selected={selectedId === seg.event.id || Boolean(dragging)}
                      past={past}
                      nowMs={nowMs}
                      resizable={Boolean(seg.event.user) && !seg.continuesAfter}
                      onResizeDown={(e) => onResizeDown(e, seg)}
                      onPointerDown={(e) => onEventDown(e, seg, dayIndex)}
                      onClick={(e) => {
                        if (!seg.event.user) props.onSelect(seg.event, rectOf(e.currentTarget));
                      }}
                      className={cn("pointer-events-auto", dragging && "z-[4] shadow-lg")}
                      style={{
                        top: live.start * PX_PER_MIN + 1,
                        height,
                        left: `calc(${live.dayIndex * widthPct}% + ${(column / columns) * widthPct}% + 2px)`,
                        width: `calc(${widthPct / columns}% - 4px)`,
                      }}
                    />
                  );
                }),
              )}

              {createGhost ? (
                <div
                  className="absolute z-[2] rounded-[7px] border border-dashed border-black/20 bg-black/[0.04] px-2 py-1 text-[10px] tabular-nums text-[#4b5563]"
                  style={{
                    top: createGhost.start * PX_PER_MIN + 1,
                    height: Math.max(15, createGhost.end - createGhost.start) * PX_PER_MIN - 2,
                    left: `calc(${(createGhost.dayIndex * 100) / days.length}% + 2px)`,
                    width: `calc(${100 / days.length}% - 4px)`,
                  }}
                  aria-hidden
                >
                  {hhmm(createGhost.start)} - {hhmm(createGhost.end)}
                </div>
              ) : null}

              {/* The current time: faint across the week, solid on today. */}
              {todayIndex >= 0 ? (
                <>
                  <div className="absolute inset-x-0 z-[3] h-px opacity-30" style={{ top: now.minutes * PX_PER_MIN, backgroundColor: lineColor }} aria-hidden />
                  <div
                    className="absolute z-[3] h-[2px]"
                    style={{ top: now.minutes * PX_PER_MIN - 0.5, left: `${(todayIndex * 100) / days.length}%`, width: `${100 / days.length}%`, backgroundColor: lineColor }}
                    aria-hidden
                  >
                    <span className="absolute -left-[4px] -top-[3px] h-2 w-2 rounded-full" style={{ backgroundColor: lineColor }} />
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
