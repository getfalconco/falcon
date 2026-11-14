"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BookOpen, Columns2, FlaskConical, LayoutGrid, LifeBuoy, LineChart, LogOut, PanelLeft, Target, Waypoints, X, Zap } from "lucide-react";
import type { TabKind } from "@/lib/workspace/layout";
import type { Icon } from "./shell/ui";
import { useDragDock, type DragPayload } from "./split/dnd";

/**
 * Desktop left rail on the gray page. Icons only by default (56px); hovering
 * or tabbing into it grows it in place to the full sidebar (the main area
 * narrows to make room), and the pin keeps it open. Main views,
 * the open tickers, sightings and strategies, and secondary links at the
 * bottom. Each item has a round split button on the rail's edge; the two
 * items on screen in split view keep theirs, marked in violet.
 */

export type NavId = "dashboard" | "focus" | "sightings" | "graph" | "strategy";

export const TAB_ICON: Record<TabKind, Icon> = {
  dashboard: LayoutGrid,
  graph: Waypoints,
  ticker: LineChart,
  sighting: Zap,
  strategy: FlaskConical,
};

export const NAV: { id: NavId; label: string; icon: Icon }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutGrid },
  { id: "focus", label: "Focus list", icon: Target },
  { id: "sightings", label: "Sightings", icon: Zap },
  { id: "graph", label: "Graph", icon: Waypoints },
  { id: "strategy", label: "Strategy Lab", icon: FlaskConical },
];

/** The view a nav item shows; Strategy Lab depends on which strategy, so it has none. */
export function navTarget(id: NavId): string | null {
  return id === "strategy" ? null : id;
}

export type OpenItem = { id: string; kind: TabKind; title: string; ticker?: string };

const ACCENT = "#5b4bdb";
const COLLAPSED = 56;
const EXPANDED = 200;
const PIN_KEY = "falcon.rail.v1";

export function readRailPinned(userId: string): boolean {
  try {
    return localStorage.getItem(`${PIN_KEY}:${userId}`) === "pinned";
  } catch {
    return false;
  }
}

export function writeRailPinned(userId: string, pinned: boolean): void {
  try {
    localStorage.setItem(`${PIN_KEY}:${userId}`, pinned ? "pinned" : "rail");
  } catch {
    // Storage blocked: the choice lasts for this visit.
  }
}

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
      {tip.arrow ? <span className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 bg-[#1c1917]" aria-hidden /> : null}
      <span className="relative block whitespace-nowrap rounded-md bg-[#1c1917] px-2 py-1 text-[12px] font-medium text-white">{tip.text}</span>
    </div>
  );
}

const ROW = "flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[14px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-black/20";

export function Sidebar({
  pinned,
  onTogglePin,
  current,
  activeTarget,
  marked,
  primaryTarget,
  openItems,
  onNav,
  onSelectTab,
  onCloseTab,
  onMoveTab,
  onSplit,
  onCloseSplit,
  onGuide,
  onHelp,
  onSignOut,
  status,
}: {
  pinned: boolean;
  onTogglePin: () => void;
  /** The nav item with the active fill (the focused pane's view). */
  current: NavId | null;
  /** The focused pane's target, for the open items' active fill. */
  activeTarget: string | null;
  /** Targets on screen while split: their round buttons stay, in violet. */
  marked: ReadonlySet<string>;
  /** The view in the main card when not split; it cannot be split with itself. */
  primaryTarget: string | null;
  openItems: OpenItem[];
  onNav: (id: NavId) => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Moves an open item up (-1) or down (+1) among the open items. */
  onMoveTab: (id: string, delta: -1 | 1) => void;
  /** Opens a nav item or an open item (by target) next to the current view. */
  onSplit: (item: { nav: NavId } | { target: string }) => void;
  onCloseSplit: (target: string) => void;
  onGuide: () => void;
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
  const expanded = pinned || ((hover || focusIn) && !suppressed);

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
        className={`absolute -right-5 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-black/[0.12] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06)] outline-none transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-black/25 ${
          isMarked ? "opacity-100" : "opacity-0 group-has-[:focus-visible]:opacity-100 group-hover:opacity-100"
        }`}
      >
        {isMarked ? (
          <>
            <Columns2 width={13} height={13} strokeWidth={1.9} style={{ color: ACCENT }} className="group-has-[:focus-visible]:hidden group-hover:hidden" aria-hidden />
            <X width={13} height={13} strokeWidth={2} className="hidden text-[#3d3b3a] group-has-[:focus-visible]:block group-hover:block" aria-hidden />
          </>
        ) : (
          <Columns2 width={13} height={13} strokeWidth={1.9} className="text-[#4b4b48]" aria-hidden />
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
        className="absolute inset-0 flex flex-col bg-[#f4f4f2] px-2 pb-3"
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
          if (e.key === "Escape" && expanded && !pinned) {
            e.preventDefault();
            setSuppressed(true);
            hide();
          }
        }}
      >
        <div className="flex h-9 shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onTogglePin}
            aria-pressed={pinned}
            aria-label={pinned ? "Unpin the sidebar" : "Pin the sidebar open"}
            {...nameTip(pinned ? "Unpin sidebar" : "Pin sidebar open")}
            className={`flex h-8 w-10 shrink-0 items-center justify-center rounded-lg outline-none transition-colors hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-black/20 ${
              pinned ? "text-[#1d1b1b]" : "text-[#767676]"
            }`}
          >
            <PanelLeft width={16} height={16} strokeWidth={1.75} aria-hidden />
          </button>
          {expanded ? <span className="truncate text-[11px] font-medium uppercase tracking-[0.1em] text-[#8a8a85]">Workspace</span> : null}
        </div>

        {/* Wider than the panel by the round buttons' overhang, so the scroll box never clips them. */}
        <nav aria-label="Workspace" className="-mr-[22px] flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pr-[22px]">
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {NAV.map(({ id, label, icon: I }) => {
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
                    className={`${ROW} ${on ? "bg-black/[0.06] font-medium text-[#1d1b1b]" : "text-[#3d3b3a] hover:bg-black/[0.04]"}`}
                  >
                    <I width={16} height={16} strokeWidth={1.75} className={`shrink-0 ${on ? "text-[#1d1b1b]" : "text-[#767676]"}`} aria-hidden />
                    <span className={expanded ? "truncate" : "sr-only"}>{label}</span>
                  </button>
                  <span data-no-drag>{splitButton(label, target, () => onSplit({ nav: id }))}</span>
                </li>
              );
            })}
          </ul>

          {openItems.length ? (
            <>
              <div className="mt-4 flex h-7 items-center px-3">
                {expanded ? (
                  <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#8a8a85]">Open</span>
                ) : (
                  <span className="h-px w-4 bg-black/[0.12]" aria-hidden />
                )}
              </div>
              <ul className="flex flex-col gap-0.5" aria-label="Open items">
                {openItems.map((item) => {
                  const on = item.id === activeTarget;
                  const I = TAB_ICON[item.kind];
                  return (
                    <li key={item.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => onSelectTab(item.id)}
                        onPointerDown={(e) => dragStart(e, { target: item.id, label: item.title, from: "rail" })}
                        onAuxClick={(e) => {
                          if (e.button === 1) {
                            e.preventDefault();
                            onCloseTab(item.id);
                          }
                        }}
                        onMouseDown={(e) => {
                          // Middle click would otherwise start autoscroll.
                          if (e.button === 1) e.preventDefault();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Delete" || e.key === "Backspace") {
                            e.preventDefault();
                            onCloseTab(item.id);
                          } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                            e.preventDefault();
                            onMoveTab(item.id, e.key === "ArrowUp" ? -1 : 1);
                          }
                        }}
                        aria-current={on ? "page" : undefined}
                        title={expanded ? item.title : undefined}
                        {...nameTip(item.title)}
                        className={`${ROW} ${expanded ? "pr-8" : ""} ${on ? "bg-black/[0.06] font-medium text-[#1d1b1b]" : "text-[#3d3b3a] hover:bg-black/[0.04]"}`}
                      >
                        {!expanded && item.ticker ? (
                          <span className="-mx-1.5 w-7 shrink-0 truncate text-center text-[10.5px] font-medium" style={{ fontFamily: "var(--font-geist-mono), monospace" }} aria-hidden>
                            {item.ticker}
                          </span>
                        ) : (
                          <I width={16} height={16} strokeWidth={1.75} className={`shrink-0 ${on ? "text-[#1d1b1b]" : "text-[#767676]"}`} aria-hidden />
                        )}
                        <span
                          className={expanded ? "min-w-0 flex-1 truncate" : "sr-only"}
                          style={item.kind === "ticker" ? { fontFamily: "var(--font-geist-mono), monospace", fontSize: 13 } : undefined}
                        >
                          {item.title}
                        </span>
                      </button>
                      {expanded ? (
                        <button
                          type="button"
                          onClick={() => onCloseTab(item.id)}
                          aria-label={`Close ${item.title}`}
                          title="Close"
                          data-no-drag
                          className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-[#9a9a9a] opacity-0 outline-none transition-opacity hover:bg-black/[0.07] hover:text-[#1d1b1b] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-black/20 group-focus-within:opacity-100 group-hover:opacity-100"
                        >
                          <X width={13} height={13} strokeWidth={2} aria-hidden />
                        </button>
                      ) : null}
                      <span data-no-drag>{splitButton(item.title, item.id, () => onSplit({ target: item.id }))}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </nav>

        <div className="flex shrink-0 flex-col gap-0.5 pt-3">
          {!expanded ? <span className="mx-auto mb-1 h-px w-4 bg-black/[0.12]" aria-hidden /> : null}
          <button type="button" onClick={onGuide} {...nameTip("How to read")} className={`${ROW} text-[#3d3b3a] hover:bg-black/[0.04]`}>
            <BookOpen width={16} height={16} strokeWidth={1.75} className="shrink-0 text-[#767676]" aria-hidden />
            <span className={expanded ? "truncate" : "sr-only"}>How to read</span>
          </button>
          <button type="button" onClick={onHelp} {...nameTip("Help")} className={`${ROW} text-[#3d3b3a] hover:bg-black/[0.04]`}>
            <LifeBuoy width={16} height={16} strokeWidth={1.75} className="shrink-0 text-[#767676]" aria-hidden />
            <span className={expanded ? "truncate" : "sr-only"}>Help</span>
          </button>
          {onSignOut ? (
            <button type="button" onClick={onSignOut} {...nameTip("Sign out")} className={`${ROW} text-[#3d3b3a] hover:bg-black/[0.04]`}>
              <LogOut width={16} height={16} strokeWidth={1.75} className="shrink-0 text-[#767676]" aria-hidden />
              <span className={expanded ? "truncate" : "sr-only"}>Sign out</span>
            </button>
          ) : (
            <a href="/" {...nameTip("Leave preview")} className={`${ROW} text-[#3d3b3a] hover:bg-black/[0.04]`}>
              <LogOut width={16} height={16} strokeWidth={1.75} className="shrink-0 text-[#767676]" aria-hidden />
              <span className={expanded ? "truncate" : "sr-only"}>Leave preview</span>
            </a>
          )}
          {expanded ? (
            <div className="mt-1.5 px-3 text-[11px] leading-[15px] text-[#9a9a9a]" style={{ fontFamily: "var(--font-geist-mono), monospace" }}>
              {status}
            </div>
          ) : null}
        </div>
      </aside>
      <TipBubble tip={tip} />
    </div>
  );
}
