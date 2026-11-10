"use client";

import { useEffect, useState } from "react";
import GlassPanel from "./GlassPanel";

type Props = {
  children: React.ReactNode;
  /**
   * The welcome funnel: the form side takes about two thirds and the glass
   * stays as a strip. It opens at the login's 50/50 split and widens from
   * there, so login into the funnel reads as one move (desktop only).
   */
  wide?: boolean;
};

/**
 * Full-viewport auth layout: the form on the left, the homepage's fluted glass
 * on the right as an inset, rounded slab. Below lg the glass shrinks to a short
 * band above the form.
 */
export default function AuthSplitShell({ children, wide = false }: Props) {
  const [narrowed, setNarrowed] = useState(false);

  useEffect(() => {
    if (!wide) return;
    // Wait two frames so the half split has painted: the narrowing then plays
    // in full even when the mount itself kept the main thread busy. The timer
    // covers pages that get no frames (a hidden preview).
    const narrow = () => setNarrowed(true);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(narrow);
    });
    const timer = window.setTimeout(narrow, 400);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [wide]);

  return (
    <div className="absolute inset-0 overflow-hidden bg-background font-sans">
      <div className="flex h-full w-full flex-col lg:flex-row">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background lg:order-1">
          {children}
        </div>
        <div
          className={`order-first shrink-0 p-3 lg:order-2 lg:h-full lg:min-h-0 lg:p-4 lg:pl-0 lg:motion-safe:[transition:width_750ms_cubic-bezier(0.33,1,0.68,1)] ${
            wide && narrowed ? "lg:w-[32%]" : "lg:w-1/2"
          }`}
        >
          <GlassPanel className="h-24 w-full lg:h-full" />
        </div>
      </div>
    </div>
  );
}
