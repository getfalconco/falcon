"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Columns2, LayoutGrid, LifeBuoy, LineChart, LogOut, Sparkles, Waypoints, X, Zap } from "lucide-react";
import type { TabKind } from "@/lib/workspace/layout";
import type { Icon } from "./shell/ui";
import { useDragDock, type DragPayload } from "./split/dnd";

/**
 * Desktop left rail on the gray page. Icons only by default (56px); hovering
 * or tabbing into it grows it in place to the full sidebar (the main area
 * narrows to make room). Main views and secondary links at the bottom. Each item has a round split button on the rail's edge; the two
 * items on screen in split view keep theirs, marked in violet.
 */

export type NavId = "dashboard" | "sightings" | "graph" | "strategy";

export const TAB_ICON: Record<TabKind, Icon> = {
  dashboard: LayoutGrid,
  graph: Waypoints,
  ticker: LineChart,
  sighting: Zap,
  strategy: Sparkles,
};

export const NAV: { id: NavId; label: string; icon: Icon }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutGrid },
  { id: "sightings", label: "Sightings", icon: Zap },
  { id: "graph", label: "Graph", icon: Waypoints },
  { id: "strategy", label: "Falcon AI", icon: Sparkles },
];

/** Items shown in the rail; the Sightings list opens from See all on the Dashboard. */
const RAIL_IDS: ReadonlySet<NavId> = new Set<NavId>(["dashboard", "graph", "strategy"]);

/** The view a nav item shows; Strategy Lab depends on which strategy, so it has none. */
export function navTarget(id: NavId): string | null {
  return id === "strategy" ? null : id;
}

export type OpenItem = { id: string; kind: TabKind; title: string; ticker?: string };

const ACCENT = "rgb(var(--f-iris))";
const COLLAPSED = 56;
const EXPANDED = 200;

type Tip = { text: string; x: number; y: number; arrow: boolean } | null;

/** One dark tooltip for the whole rail, fixed so the scrolling list never clips it. */
function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const show = useCallback((el: HTMLElement, text: string, arrow = true) => {
    const r = el.getBoundingClientRect();
    setTip({ text, x: r.right + 8, y: r.top + r.height / 2, arrow });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  return { tip, show, hide };
}

function TipBubble({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div role="tooltip" className="pointer-events-none fixed z-[95] -translate-y-1/2" style={{ left: tip.x, top: tip.y }}>
      {tip.arrow ? <span className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 bg-solid" aria-hidden /> : null}
      <span className="relative block whitespace-nowrap rounded-md bg-solid px-2 py-1 text-fs-12 font-medium text-paper">{tip.text}</span>
    </div>
  );
}

/** Labels stay mounted and fade (clipped by the width), so nothing pops in or out while the rail animates. */
const LABEL_FADE = "transition-opacity duration-200 ease-out motion-reduce:transition-none";
const LABEL = `min-w-0 truncate ${LABEL_FADE}`;

const ROW = "flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-fs-14 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line/20";

export function Sidebar({
  current,
  marked,
  primaryTarget,
  onNav,
  onSplit,
  onCloseSplit,
  onHelp,
  onSignOut,
  status,
}: {
  /** The nav item with the active fill (the focused pane's view). */
  current: NavId | null;
  /** Targets on screen while split: their round buttons stay, in violet. */
  marked: ReadonlySet<string>;
  /** The view in the main card when not split; it cannot be split with itself. */
  primaryTarget: string | null;
  onNav: (id: NavId) => void;
  /** Opens a nav item (or any target) next to the current view. */
  onSplit: (item: { nav: NavId } | { target: string }) => void;
  onCloseSplit: (target: string) => void;
  onHelp: () => void;
  onSignOut: (() => void) | null;
  status: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const [suppressed, setSuppressed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // How the person last interacted: only keyboard focus keeps the rail open; a click leaves it to the pointer.
  const keyboard = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) keyboard.current = true;
    };
    const onPointer = () => {
      keyboard.current = false;
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);
  const { tip, show, hide } = useTip();
  const { begin } = useDragDock();
  const expanded = ((hover || focusIn) && !suppressed);
  /** Opacity for what shows only expanded, and for what shows only collapsed. */
  const wide = expanded ? "opacity-100" : "opacity-0";
  const narrow = expanded ? "opacity-0" : "opacity-100";

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (expanded) hide();
  }, [expanded, hide]);

  const later = (fn: () => void, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };

  /** Tooltip with the item's name, only while the rail shows icons. */
  const nameTip = (text: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => !expanded && show(e.currentTarget, text, false),
    onMouseLeave: hide,
    onFocus: (e: React.FocusEvent<HTMLElement>) => !expanded && show(e.currentTarget, text, false),
    onBlur: hide,
  });

  const splitButton = (name: string, target: string | null, onOpen: () => void) => {
    const isMarked = target !== null && marked.has(target);
    const hidden = !isMarked && marked.size === 0 && target !== null && target === primaryTarget;
    if (hidden) return null;
    const label = isMarked ? `Close ${name} split` : `Open ${name} in split view`;
    return (
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          hide();
          if (isMarked && target) onCloseSplit(target);
          else onOpen();
        }}
        onMouseEnter={(e) => show(e.currentTarget, isMarked ? "Close split" : "Split View")}
        onMouseLeave={hide}
        onFocus={(e) => show(e.currentTarget, isMarked ? "Close split" : "Split View")}
        onBlur={hide}
        className={`absolute -right-5 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-line/[0.12] bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.06)] outline-none transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-line/25 ${
          isMarked ? "opacity-100" : "opacity-0 group-has-[:focus-visible]:opacity-100 group-hover:opacity-100"
        }`}
      >
        {isMarked ? (
          <>
            <Columns2 width={13} height={13} strokeWidth={1.9} style={{ color: ACCENT }} className="group-has-[:focus-visible]:hidden group-hover:hidden" aria-hidden />
            <X width={13} height={13} strokeWidth={2} className="hidden text-fore-3 group-has-[:focus-visible]:block group-hover:block" aria-hidden />
          </>
        ) : (
          <Columns2 width={13} height={13} strokeWidth={1.9} className="text-fore-4" aria-hidden />
        )}
      </button>
    );
  };

  const dragStart = (e: React.PointerEvent, payload: DragPayload) => {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    begin(e, payload);
  };

  return (
    // The rail grows in place and the main area narrows to make room (no overlay); charts and the graph re-measure once it settles.
    <div
      className="relative z-30 h-full shrink-0 transition-[width] duration-200 ease-out motion-reduce:transition-none"
      style={{ width: expanded ? EXPANDED : COLLAPSED }}
    >
      <aside
        aria-label="Sidebar"
        className="absolute inset-0 flex flex-col bg-page px-2 pb-3"
        onPointerEnter={() => later(() => setHover(true), 150)}
        onPointerLeave={() => {
          // Focus left inside by a click does not hold the rail open.
          if (!keyboard.current) setFocusIn(false);
          later(() => setHover(false), 250);
          setSuppressed(false);
          hide();
        }}
        onFocusCapture={() => {
          // Keyboard focus opens it (again, after Escape); focus from a click does not.
          if (!keyboard.current) return;
          setFocusIn(true);
          setSuppressed(false);
        }}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setFocusIn(false);
            setSuppressed(false);
          }
        }}
        onPointerDown={() => setFocusIn(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && expanded) {
            e.preventDefault();
            setSuppressed(true);
            hide();
          }
        }}
      >
        <div className="flex h-9 shrink-0 items-center gap-1.5 pl-3">
          <span className={`${LABEL} ${wide} cursor-default select-none text-fs-11 font-medium uppercase tracking-[0.1em] text-quiet-2`} aria-hidden={!expanded || undefined}>
            Workspace
          </span>
        </div>

        {/* Wider than the panel by the round buttons' overhang, so the scroll box never clips them. */}
        <nav aria-label="Workspace" className="-mr-[22px] flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pr-[22px]">
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {NAV.filter((n) => RAIL_IDS.has(n.id)).map(({ id, label, icon: I }) => {
              const on = current === id;
              const target = navTarget(id);
              return (
                <li key={id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onNav(id)}
                    onPointerDown={target ? (e) => dragStart(e, { target, label, from: "rail" }) : undefined}
                    aria-current={on ? "page" : undefined}
                    {...nameTip(label)}
                    className={`${ROW} ${on ? "bg-line/[0.06] font-medium text-fore" : "text-fore-3 hover:bg-line/[0.04]"}`}
                  >
                    <I width={16} height={16} strokeWidth={1.75} className={`shrink-0 ${on ? "text-fore" : "text-quiet"}`} aria-hidden />
                    <span className={`${LABEL} ${wide}`}>{label}</span>
                  </button>
                  <span data-no-drag>{splitButton(label, target, () => onSplit({ nav: id }))}</span>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Nothing here mounts or unmounts with the width: the divider grows with the rail and the labels fade. */}
        <div className="flex shrink-0 flex-col gap-0.5 pt-3">
          <span className="mx-3 mb-1 h-px bg-line/[0.12]" aria-hidden />
          <button type="button" onClick={onHelp} {...nameTip("Help")} className={`${ROW} text-fore-3 hover:bg-line/[0.04]`}>
            <LifeBuoy width={16} height={16} strokeWidth={1.75} className="shrink-0 text-quiet" aria-hidden />
            <span className={`${LABEL} ${wide}`}>Help</span>
          </button>
          {onSignOut ? (
            <button type="button" onClick={onSignOut} {...nameTip("Sign out")} className={`${ROW} text-down hover:bg-down/[0.08]`}>
              <LogOut width={16} height={16} strokeWidth={1.75} className="shrink-0" aria-hidden />
              <span className={`${LABEL} ${wide}`}>Sign out</span>
            </button>
          ) : (
            <a href="/" {...nameTip("Leave preview")} className={`${ROW} text-down hover:bg-down/[0.08]`}>
              <LogOut width={16} height={16} strokeWidth={1.75} className="shrink-0" aria-hidden />
              <span className={`${LABEL} ${wide}`}>Leave preview</span>
            </a>
          )}
          {/* Always laid out at the full width and clipped, so the buttons above never shift when it shows. */}
          <div className="overflow-hidden" aria-hidden={!expanded || undefined}>
            <div
              className={`mt-1.5 w-[184px] px-3 text-fs-11 leading-fs-15 text-faint ${LABEL_FADE} ${wide}`}
              style={{ fontFamily: "var(--font-geist-mono), monospace" }}
            >
              {status}
            </div>
          </div>
        </div>
      </aside>
      <TipBubble tip={tip} />
    </div>
  );
}
