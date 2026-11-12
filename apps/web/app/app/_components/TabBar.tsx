"use client";

import { useEffect, useRef, useState } from "react";
import type { ComponentType, SVGProps } from "react";
import { FlaskConical, LayoutGrid, LineChart, PanelLeft, PanelRight, Plus, Waypoints, X, Zap } from "lucide-react";
import type { Tab, TabKind } from "@/lib/workspace/layout";
import { MONO } from "./parts";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string }>;

export const TAB_ICON: Record<TabKind, Icon> = {
  dashboard: LayoutGrid,
  graph: Waypoints,
  ticker: LineChart,
  sighting: Zap,
  strategy: FlaskConical,
};

const NEW_TABS: { kind: "dashboard" | "graph" | "strategy"; label: string }[] = [
  { kind: "dashboard", label: "Dashboard" },
  { kind: "graph", label: "Graph" },
  { kind: "strategy", label: "Strategy" },
];

const ICON_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#767676] outline-none transition-colors hover:bg-[#efefec] hover:text-[#1d1b1b] focus-visible:bg-[#efefec] focus-visible:text-[#1d1b1b]";

/**
 * Obsidian-style tab strip: click to switch, drag to reorder, middle click or
 * the cross to close, + to open a Dashboard, Graph or Strategy tab.
 */
export function TabBar({
  tabs,
  activeId,
  titleFor,
  onSelect,
  onClose,
  onMove,
  onNew,
  sidebarOpen,
  contextOpen,
  onToggleSidebar,
  onToggleContext,
}: {
  tabs: Tab[];
  activeId: string;
  titleFor: (tab: Tab) => string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (id: string, toIndex: number) => void;
  onNew: (kind: "dashboard" | "graph" | "strategy") => void;
  sidebarOpen: boolean;
  contextOpen: boolean;
  onToggleSidebar: () => void;
  onToggleContext: () => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !popRef.current?.contains(target)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Keep the active tab in view when it changes.
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  function onKeyDown(event: React.KeyboardEvent, index: number) {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      if (event.altKey || event.shiftKey) {
        onMove(tabs[index].id, Math.max(0, Math.min(tabs.length - 1, index + delta)));
        return;
      }
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      onSelect(next.id);
      stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(next.id)}"]`)?.focus();
    } else if (event.key === "Delete") {
      event.preventDefault();
      onClose(tabs[index].id);
    }
  }

  return (
    <div className="flex h-10 shrink-0 items-end gap-1 border-b border-black/[0.08] bg-[#f6f6f3] pl-1.5 pr-1.5">
      <div className="flex h-10 items-center">
        <button type="button" onClick={onToggleSidebar} className={ICON_BUTTON} aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"} aria-pressed={sidebarOpen}>
          <PanelLeft width={15} height={15} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      <div
        ref={stripRef}
        role="tablist"
        aria-label="Open tabs"
        className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          // Drop slot from the pointer's position over the tabs.
          const items = Array.from(stripRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? []);
          let slot = items.length;
          for (let i = 0; i < items.length; i++) {
            const r = items[i].getBoundingClientRect();
            if (e.clientX < r.left + r.width / 2) {
              slot = i;
              break;
            }
          }
          setDropIndex(slot);
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId !== null && dropIndex !== null) {
            const from = tabs.findIndex((t) => t.id === dragId);
            const to = dropIndex > from ? dropIndex - 1 : dropIndex;
            if (from !== -1 && to !== from) onMove(dragId, to);
          }
          setDragId(null);
          setDropIndex(null);
        }}
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          const Icon = TAB_ICON[tab.kind];
          const title = titleFor(tab);
          const showDrop = dragId !== null && dropIndex === index && dragId !== tab.id;
          return (
            <div key={tab.id} className="relative flex shrink-0 items-end">
              {showDrop ? <span className="absolute -left-[2px] bottom-1.5 top-1.5 w-[2px] rounded-full bg-[#1d1b1b]/50" aria-hidden /> : null}
              <div
                data-tab-id={tab.id}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                draggable
                onDragStart={(e) => {
                  setDragId(tab.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", tab.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropIndex(null);
                }}
                onClick={() => onSelect(tab.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onClose(tab.id);
                  }
                }}
                onMouseDown={(e) => {
                  // Middle click would otherwise start autoscroll.
                  if (e.button === 1) e.preventDefault();
                }}
                onKeyDown={(e) => onKeyDown(e, index)}
                title={title}
                className={`group relative flex h-[34px] w-[176px] cursor-default items-center gap-2 rounded-t-lg border border-b-0 pl-3 pr-1.5 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-black/30 ${
                  active
                    ? "z-[1] -mb-px h-[35px] border-black/[0.08] bg-[#fdfdfd] text-[#1d1b1b]"
                    : "border-transparent text-[#767676] hover:bg-black/[0.035] hover:text-[#1d1b1b]"
                } ${dragId === tab.id ? "opacity-50" : ""}`}
              >
                <Icon width={13} height={13} strokeWidth={1.75} className="shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[12.5px]" style={tab.kind === "ticker" ? { fontFamily: MONO } : undefined}>
                  {title}
                </span>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Close ${title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#9a9a9a] transition-opacity hover:bg-black/[0.07] hover:text-[#1d1b1b] ${
                    active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  <X width={12} height={12} strokeWidth={2} aria-hidden />
                </button>
              </div>
            </div>
          );
        })}
        {dragId !== null && dropIndex === tabs.length ? <span className="mb-1.5 h-[22px] w-[2px] shrink-0 rounded-full bg-[#1d1b1b]/50" aria-hidden /> : null}

        <div ref={menuRef} className="relative flex h-10 shrink-0 items-center pl-1">
          <button type="button" onClick={() => setMenuOpen((o) => !o)} className={ICON_BUTTON} aria-label="New tab" aria-haspopup="menu" aria-expanded={menuOpen}>
            <Plus width={15} height={15} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      </div>

      {menuOpen ? (
        <NewTabMenu
          anchor={menuRef.current}
          onPick={(kind) => {
            setMenuOpen(false);
            onNew(kind);
          }}
          popRef={popRef}
        />
      ) : null}

      <div className="flex h-10 items-center">
        <button type="button" onClick={onToggleContext} className={ICON_BUTTON} aria-label={contextOpen ? "Hide details" : "Show details"} aria-pressed={contextOpen}>
          <PanelRight width={15} height={15} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** The + menu, placed under its button but outside the scrolling strip so it is never clipped. */
function NewTabMenu({
  anchor,
  onPick,
  popRef,
}: {
  anchor: HTMLElement | null;
  onPick: (kind: "dashboard" | "graph" | "strategy") => void;
  popRef: React.RefObject<HTMLDivElement>;
}) {
  const rect = anchor?.getBoundingClientRect();
  if (!rect) return null;
  return (
    <div
      ref={popRef}
      role="menu"
      className="fixed z-50 w-[180px] rounded-lg border border-black/10 bg-white p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]"
      style={{ left: rect.left + 4, top: rect.bottom - 2 }}
    >
      {NEW_TABS.map(({ kind, label }) => {
        const Icon = TAB_ICON[kind];
        return (
          <button
            key={kind}
            type="button"
            role="menuitem"
            onClick={() => onPick(kind)}
            className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-[#1d1b1b] outline-none transition-colors hover:bg-[#efefec] focus-visible:bg-[#efefec]"
          >
            <Icon width={14} height={14} strokeWidth={1.75} className="text-[#767676]" aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}
