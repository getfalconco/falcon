"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

/**
 * Drag to split: the help chat, a sidebar item or a pane header can be
 * dragged over the main area, which shows a left and a right drop zone
 * (like window snapping). Pointer events, so it works the same for the
 * floating window (which moves with the pointer) and for rows (a small
 * label follows the pointer).
 */

export type Side = "left" | "right";
export type DragPayload = {
  /** View target: a tab id, "sightings" or "help". */
  target: string;
  label: string;
  from: "rail" | "float" | "pane";
};
export type DropResult = { payload: DragPayload; zone: Side | null; x: number; y: number };

type BeginOptions = {
  /** Called on every move once the drag started (the floating window follows the pointer). */
  onMove?: (x: number, y: number) => void;
  /** Hide the label that follows the pointer (the floating window is its own ghost). */
  noGhost?: boolean;
};

type DragApi = {
  /** Starts tracking a pointer; the drag begins after a few pixels, so plain clicks still click. */
  begin: (e: React.PointerEvent, payload: DragPayload, opts?: BeginOptions) => void;
  dragging: DragPayload | null;
};

const DragContext = createContext<DragApi | null>(null);

export function useDragDock(): DragApi {
  const api = useContext(DragContext);
  if (!api) throw new Error("useDragDock outside DragDockProvider");
  return api;
}

const THRESHOLD = 5;

export function DragDockProvider({ areaRef, onDrop, children }: { areaRef: RefObject<HTMLElement>; onDrop: (r: DropResult) => void; children: ReactNode }) {
  const [drag, setDrag] = useState<{ payload: DragPayload; x: number; y: number; zone: Side | null; ghost: boolean } | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  const zoneAt = useCallback(
    (x: number, y: number): Side | null => {
      const r = areaRef.current?.getBoundingClientRect();
      if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
      return x < r.left + r.width / 2 ? "left" : "right";
    },
    [areaRef],
  );

  const begin = useCallback(
    (e: React.PointerEvent, payload: DragPayload, opts: BeginOptions = {}) => {
      if (e.button !== 0) return;
      cleanup.current?.();
      const sx = e.clientX;
      const sy = e.clientY;
      let active = false;

      const move = (ev: PointerEvent) => {
        if (!active) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
          active = true;
          document.body.style.userSelect = "none";
        }
        ev.preventDefault();
        opts.onMove?.(ev.clientX, ev.clientY);
        setDrag({ payload, x: ev.clientX, y: ev.clientY, zone: zoneAt(ev.clientX, ev.clientY), ghost: !opts.noGhost });
      };
      const end = (ev: PointerEvent, cancelled: boolean) => {
        const was = active;
        stop();
        if (!was) return;
        // The click that follows a drag must not also open the row.
        const eat = (c: MouseEvent) => {
          c.stopPropagation();
          c.preventDefault();
        };
        window.addEventListener("click", eat, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", eat, { capture: true }), 0);
        if (!cancelled) onDropRef.current({ payload, zone: zoneAt(ev.clientX, ev.clientY), x: ev.clientX, y: ev.clientY });
      };
      const up = (ev: PointerEvent) => end(ev, false);
      const cancel = (ev: PointerEvent) => end(ev, true);
      const key = (ev: KeyboardEvent) => {
        if (ev.key === "Escape" && active) {
          ev.preventDefault();
          active = false;
          stop();
        }
      };
      function stop() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", key, true);
        document.body.style.userSelect = "";
        cleanup.current = null;
        setDrag(null);
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", key, true);
      cleanup.current = stop;
    },
    [zoneAt],
  );

  return (
    <DragContext.Provider value={{ begin, dragging: drag?.payload ?? null }}>
      {children}
      {drag ? <DropOverlay areaRef={areaRef} zone={drag.zone} /> : null}
      {drag?.ghost ? (
        <div
          className="pointer-events-none fixed z-[90] -translate-x-1/2 -translate-y-[130%] whitespace-nowrap rounded-lg border border-line/10 bg-surface px-2.5 py-1 text-fs-12.5 text-fore shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
          style={{ left: drag.x, top: drag.y }}
          aria-hidden
        >
          {drag.payload.label}
        </div>
      ) : null}
    </DragContext.Provider>
  );
}


/** The two halves of the main area, the one under the pointer highlighted. */
function DropOverlay({ areaRef, zone }: { areaRef: RefObject<HTMLElement>; zone: Side | null }) {
  const r = areaRef.current?.getBoundingClientRect();
  if (!r) return null;
  const gap = 8;
  const half = (r.width - gap) / 2;
  return (
    <div className="pointer-events-none fixed z-[80]" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} aria-hidden>
      {(["left", "right"] as const).map((side) => {
        const on = zone === side;
        return (
          <div
            key={side}
            className="absolute inset-y-0 flex items-center justify-center rounded-xl border-2 transition-colors duration-100"
            style={{
              left: side === "left" ? 0 : half + gap,
              width: half,
              borderColor: on ? "rgb(var(--f-iris) / 0.6)" : "rgb(var(--f-line) / 0.08)",
              borderStyle: on ? "solid" : "dashed",
              background: on ? "rgb(var(--f-iris) / 0.1)" : "rgb(var(--f-surface) / 0.35)",
            }}
          >
            <span className="rounded-md bg-surface/90 px-2 py-1 text-fs-12 font-medium shadow-sm" style={{ color: on ? "rgb(var(--f-iris))" : "rgb(var(--f-quiet-2))" }}>
              {side === "left" ? "Open on the left" : "Open on the right"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
