"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A working state: a 3×3 pixel grid pulsing in a pattern, a shimmering label
 * and the time elapsed, e.g.  ⣿ Thinking 2.4s.
 *
 *   Drive  a chevron marching right (square pixels): churning, long work
 *   Dots   the same march with round pixels: thinking
 *   Orbit  one pixel circling the edge: searching, lookups
 *
 * Colors are the workspace tokens (app/globals.css: --f-fore, --f-quiet,
 * --f-faint; light by default, dark under html.dark). Under reduced motion
 * (the OS setting, or Settings > Motion via html[data-f-motion]) the grid
 * freezes in its dim state and the label stops shimmering; the timer keeps
 * ticking. The keyframes and that switch live in app/globals.css
 * (.loading-state-*).
 *
 * `startedAt` (ms epoch) anchors the timer to when the step really began, so
 * it survives a re-render, a remount or a resumed reply; without it the timer
 * starts when the component mounts. `announce` makes it a polite status region
 * that says "Thinking", then "Thinking, 10 seconds" every 10 seconds (not
 * every tick); pass false where another live region already speaks for it.
 */

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});
const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

export type LoadingVariant = "Drive" | "Dots" | "Orbit";

const PATTERNS: Record<LoadingVariant, { delays: (number | null)[]; dur: number; round: boolean }> = {
  Drive: { delays: chevron, dur: 650, round: false },
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false },
};

const SIZES = {
  sm: { cols: "grid-cols-[repeat(3,3px)] gap-px", cell: "size-[3px]", label: "text-fs-12.5", time: "text-fs-11.5", gap: "gap-2" },
  md: { cols: "grid-cols-[repeat(3,4px)] gap-[1.5px]", cell: "size-[4px]", label: "text-fs-13", time: "text-fs-12", gap: "gap-2.5" },
} as const;

/** Milliseconds since `startedAt` (or since mount), ticking every 100ms. */
function useElapsedMs(startedAt?: number): number {
  const [mountedAt] = useState(() => Date.now());
  const start = startedAt ?? mountedAt;
  // Starts at 0 so the server and the first client render agree; the effect catches up at once.
  const [now, setNow] = useState(start);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);
  return Math.max(0, now - start);
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 100) / 10;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

/** "Thinking", then "Thinking, 10 seconds", "Thinking, 1 minute 20 seconds": changes every 10 seconds. */
function spoken(label: string, ms: number): string {
  const s = Math.floor(ms / 10_000) * 10;
  if (!s) return label;
  const m = Math.floor(s / 60);
  const r = s % 60;
  const parts = [m ? `${m} minute${m === 1 ? "" : "s"}` : "", r ? `${r} seconds` : ""].filter(Boolean);
  return `${label}, ${parts.join(" ")}`;
}

export default function LoadingState({
  label = "Churning",
  variant = "Drive",
  startedAt,
  size = "md",
  announce = true,
  meta,
  children,
  className,
  labelClassName,
}: {
  label?: string;
  variant?: LoadingVariant | (string & {});
  /** When the step began (ms epoch); the timer counts from here. */
  startedAt?: number;
  size?: keyof typeof SIZES;
  /** A polite status region (role="status") with a spoken label and coarse time. */
  announce?: boolean;
  /** Shown just before the timer, e.g. download progress "34/51". */
  meta?: ReactNode;
  /** Shown after the label, e.g. the command being run. */
  children?: ReactNode;
  className?: string;
  /** e.g. a minimum width so commands line up across rows. */
  labelClassName?: string;
}) {
  const ms = useElapsedMs(startedAt);
  const { delays, dur, round } = PATTERNS[variant as LoadingVariant] ?? PATTERNS.Drive;
  const s = SIZES[size];
  return (
    <div className={cn("flex w-fit min-w-0 items-center", s.gap, className)} {...(announce ? { role: "status", "aria-atomic": true } : {})}>
      <span aria-hidden className={cn("grid shrink-0", s.cols)}>
        {delays.map((d, i) => (
          <span
            key={i}
            className={cn(s.cell, "bg-fore", round ? "rounded-full" : "rounded-[1px]", d === null ? "opacity-[0.07]" : "loading-state-pixel opacity-[0.15]")}
            style={d === null ? undefined : ({ "--ls-dur": `${dur}ms`, "--ls-delay": `${d}ms` } as CSSProperties)}
          />
        ))}
      </span>
      <span aria-hidden className={cn("loading-state-label shrink-0 font-medium", s.label, labelClassName)}>
        {label}
      </span>
      {children}
      <span aria-hidden className={cn("ml-auto shrink-0 font-mono tabular-nums text-faint", s.time)}>
        {meta ? <>{meta} · </> : null}
        {formatElapsed(ms)}
      </span>
      {announce ? <span className="sr-only">{spoken(label, ms)}</span> : null}
    </div>
  );
}
