import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type Ref } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { etClock, type CalendarItemView, type CalendarView } from "../../../shared/calendar-view";
import { HEAD_CLASS, MONO_CLASS } from "./briefing-styles";

/**
 * The day's calendar drawn as a rail: a time column, a hairline with a node
 * per row, the title and what it covers, and one accented line that says
 * where the day stands. Every row can be hovered (or focused from the
 * keyboard) for a card with the rest of what is known about it: the reader's
 * own clock beside New York's, where the date comes from, how heavy the row is.
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
 * and holiday until the day comes. "after" is a day the clock has left
 * behind: one picked on the strip, or a report the store has not managed to
 * replace yet (a request that failed on waking, say).
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
 * A row's hover and focus state. The highlight is a pseudo-element set a little
 * outside the row and behind it, not a background on the row itself: the row
 * has no vertical padding, because padding there would break the rail's
 * hairline into one dash per row. The row is its own stacking context so the
 * highlight stays behind the hairline and the node. A dimmed row lifts while
 * it is pointed at, so what the card says about it is read against it.
 */
const ROW_INTERACTIVE =
  "relative isolate cursor-default outline-none before:absolute before:-inset-x-2 before:-top-1 before:bottom-1.5 before:-z-10 before:rounded-lg before:transition-colors before:duration-150 hover:before:bg-[#1d1b1b]/[0.045] focus-visible:before:bg-[#1d1b1b]/[0.06]";

const PAST_ROW = "opacity-[0.45] transition-opacity duration-150 hover:opacity-80 focus-visible:opacity-80";

const HOVER_CARD_WIDTH = 248;
const EDGE = 8;
const GAP = 10;

/**
 * The rest of what is known about a row, beside it. Rendered into the body
 * and placed against the row's box on screen: the card's list scrolls and
 * clips, and a card inside it would be cut off at the list's edge. It goes to
 * the right of the row, or the left when the card sits against the window's
 * right edge, or under it when neither side has room; and it is measured
 * before it is shown, so it never lands half off screen.
 *
 * The row element is measured, not a box taken when it was first pointed at:
 * the "now" line can move above the row at a minute's turn, and a keyboard
 * focus scrolls the row into view after the card has opened. `placeKey`
 * changes whenever either may have moved it.
 */
function RowHoverCard({ id, item, row, placeKey }: { id: string; item: CalendarItemView; row: HTMLElement; placeKey: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const anchor = row.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if (anchor.right + GAP + w <= vw - EDGE) {
      left = anchor.right + GAP;
      top = anchor.top - 6;
    } else if (anchor.left - GAP - w >= EDGE) {
      left = anchor.left - GAP - w;
      top = anchor.top - 6;
    } else {
      left = Math.min(Math.max(anchor.left, EDGE), vw - EDGE - w);
      top = anchor.bottom + 6 + h <= vh - EDGE ? anchor.bottom + 6 : anchor.top - 6 - h;
    }
    setPlace({ left, top: Math.min(Math.max(top, EDGE), vh - EDGE - h) });
  }, [row, placeKey, item]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      style={{
        position: "fixed",
        left: place?.left ?? -9999,
        top: place?.top ?? 0,
        width: HOVER_CARD_WIDTH,
        visibility: place ? "visible" : "hidden",
        zIndex: 70,
      }}
      className="pointer-events-none rounded-2xl border border-white/60 bg-white/85 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
    >
      <p className={cn("text-[12.5px] leading-[1.4] text-[#1d1b1b]", item.importance === 3 && "font-medium")}>{item.title}</p>
      <p className={cn(MONO_CLASS, "mt-1 text-[11px] text-[#4b5563]")}>{item.timeLine}</p>
      {item.detail ? <p className="mt-1 text-[11.5px] leading-[1.45] text-[#6b7280]">{item.detail}</p> : null}
      <p className={cn(HEAD_CLASS, "mt-1.5")}>{[item.kindLabel, ...item.tickers].join(" · ")}</p>
      <div className="mt-2 space-y-0.5 border-t-[0.5px] border-black/[0.06] pt-2 text-[11px] leading-[1.45] text-[#9CA3AF]">
        <p>{item.importanceLabel}</p>
        {item.sourceLabel ? <p>{item.sourceLabel}</p> : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The rows, all-day ones first, then the timed ones with the "now" line among
 * them: before the first row still ahead, or under the last row once every
 * one is behind. Rows behind the line are dimmed. The caller owns the box the
 * rows scroll in, which is why the marker's ref is passed through: the caller
 * is the one that can scroll the line into view. A null label draws no line:
 * a day picked on the strip that is neither the session nor today has no
 * "now" on it.
 *
 * The caller's scroll box needs eight pixels of room either side of the rows
 * (`-mx-2 px-2`) for the hover highlight, which reaches past them.
 */
export function CalendarRows({
  view,
  markerLabel,
  markerRef,
}: {
  view: CalendarView;
  markerLabel: string | null;
  markerRef?: Ref<HTMLDivElement>;
}) {
  const tooltipId = useId();
  // The row by id and element, never a copy of its item: the card gets a new
  // view every minute (the clock is part of it), and the item is read from
  // that view each render, so a row that is still there keeps its card and a
  // row that has gone takes its card with it.
  const [hover, setHover] = useState<{ id: string; row: HTMLElement } | null>(null);
  const [placeKey, setPlaceKey] = useState(0);
  const hoveredItem = hover ? [...view.allDay, ...view.timed].find((item) => item.id === hover.id) ?? null : null;

  // A scroll or a resize moves the row. The card follows it while the row is
  // still the one in use (pointed at, or holding keyboard focus, which the
  // browser scrolls into view after the card has opened) and is put away
  // otherwise, rather than left pointing at the wrong place.
  useEffect(() => {
    if (!hover) return;
    const follow = () => {
      const { row } = hover;
      if (row.isConnected && (row === document.activeElement || row.matches(":hover"))) setPlaceKey((k) => k + 1);
      else setHover(null);
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [hover]);
  // A new view can move the row (the "now" line passes above it): measure again.
  useEffect(() => {
    if (hover) setPlaceKey((k) => k + 1);
  }, [view]);

  const show = (item: CalendarItemView) => (e: MouseEvent<HTMLDivElement> | FocusEvent<HTMLDivElement>) =>
    setHover({ id: item.id, row: e.currentTarget });
  const hide = () => setHover(null);
  const rowProps = (item: CalendarItemView) => ({
    tabIndex: 0,
    "aria-describedby": hoveredItem?.id === item.id ? tooltipId : undefined,
    onMouseEnter: show(item),
    onMouseLeave: hide,
    // A press starts a drag of the whole card on the canvas; a card left open
    // would stay where the row was while the row travels. The press also
    // focuses the row, and a focus from a pointer (not :focus-visible) opens
    // nothing: otherwise the card would open again beside a row the pointer
    // has left, the next time the window regains focus.
    onPointerDown: hide,
    onFocus: (e: FocusEvent<HTMLDivElement>) => {
      if (e.currentTarget.matches(":focus-visible")) show(item)(e);
    },
    onBlur: hide,
    className: cn(ROW_GRID, ROW_INTERACTIVE, item.past && PAST_ROW),
  });

  const marker = markerLabel === null ? null : <NowMarker label={markerLabel} markerRef={markerRef} />;
  return (
    <>
      {view.allDay.map((item) => (
        <div key={item.id} {...rowProps(item)}>
          <span className={cn(HEAD_CLASS, "pt-[3px]")}>All day</span>
          <Rail importance={item.importance} />
          <ItemText item={item} />
        </div>
      ))}

      {view.timed.map((item, i) => (
        <Fragment key={item.id}>
          {i === view.nowIndex ? marker : null}
          <div {...rowProps(item)}>
            <span className={cn(MONO_CLASS, "pt-px text-[11.5px] text-[#4b5563]")}>{item.timeLabel}</span>
            <Rail importance={item.importance} />
            <ItemText item={item} />
          </div>
        </Fragment>
      ))}
      {view.timed.length > 0 && view.nowIndex >= view.timed.length ? marker : null}

      {hover && hoveredItem ? <RowHoverCard id={tooltipId} item={hoveredItem} row={hover.row} placeKey={placeKey} /> : null}
    </>
  );
}
