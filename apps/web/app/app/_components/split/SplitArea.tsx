"use client";

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from "@/lib/workspace/layout";

const MIN_PANE_PX = 380;
const GUTTER = 16;

/**
 * Two panes side by side with a draggable divider in the gap between them.
 * `ratio` is the left pane's share; double-click (or Enter on the focused
 * divider) resets to 50/50, arrow keys nudge it.
 */
export function SplitArea({ ratio, onRatio, left, right }: { ratio: number; onRatio: (ratio: number) => void; left: ReactNode; right: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<number | null>(null);
  const r = live ?? ratio;

  const clamp = (v: number) => {
    const w = (ref.current?.clientWidth ?? 1200) - GUTTER;
    const min = Math.max(MIN_SPLIT_RATIO, Math.min(0.5, MIN_PANE_PX / Math.max(1, w)));
    return Math.min(Math.min(MAX_SPLIT_RATIO, 1 - min), Math.max(min, v));
  };

  const fromX = (x: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return r;
    return clamp((x - rect.left - GUTTER / 2) / Math.max(1, rect.width - GUTTER));
  };

  return (
    <div ref={ref} className="flex min-w-0 flex-1">
      <div className="flex min-w-0" style={{ flex: `${r} 1 0` }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
        aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
        aria-valuenow={Math.round(r * 100)}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
        className="group relative shrink-0 cursor-col-resize touch-none outline-none"
        style={{ width: GUTTER }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setLive(fromX(e.clientX));
        }}
        onPointerMove={(e) => {
          if (live !== null) setLive(fromX(e.clientX));
        }}
        onPointerUp={() => {
          if (live !== null) onRatio(live);
          setLive(null);
        }}
        onPointerCancel={() => setLive(null)}
        onDoubleClick={() => onRatio(0.5)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            onRatio(clamp(r + (e.key === "ArrowLeft" ? -0.02 : 0.02)));
          } else if (e.key === "Enter" || e.key === "Home") {
            e.preventDefault();
            onRatio(0.5);
          }
        }}
      >
        <span
          className={`absolute inset-y-4 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:bg-[#5b4bdb]/60 group-focus-visible:bg-[#5b4bdb] ${live !== null ? "bg-[#5b4bdb]" : "bg-black/[0.10]"}`}
          aria-hidden
        />
      </div>
      <div className="flex min-w-0" style={{ flex: `${1 - r} 1 0` }}>
        {right}
      </div>
    </div>
  );
}
