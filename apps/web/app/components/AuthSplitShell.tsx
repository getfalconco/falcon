"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
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

// Tailwind's lg breakpoint: the split layout and its glass start here.
const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribeDesktop(onChange: () => void) {
  const mq = window.matchMedia(DESKTOP_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * Full-viewport auth layout: the form on the left, the homepage's fluted glass
 * on the right as an inset, rounded slab. Below lg there is no glass at all:
 * the form fills the screen and the WebGL canvas is never mounted.
 */
export default function AuthSplitShell({ children, wide = false }: Props) {
  const [narrowed, setNarrowed] = useState(false);
  const isDesktop = useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );

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
          className={`hidden shrink-0 lg:order-2 lg:block lg:h-full lg:min-h-0 lg:p-4 lg:pl-0 lg:motion-safe:[transition:width_750ms_cubic-bezier(0.33,1,0.68,1)] ${
            wide && narrowed ? "lg:w-[32%]" : "lg:w-1/2"
          }`}
        >
          {/* The glass keeps the login slab's size (half the viewport less its
              16px gutter) pinned to the right; only the rounded frame narrows,
              so the shader never resizes or stretches mid-animation. */}
          <GlassPanel
            className="h-full w-full"
            shader={isDesktop}
            glassClassName={wide ? "inset-0 lg:left-auto lg:w-[calc(50vw-16px)]" : "inset-0"}
          />
        </div>
      </div>
    </div>
  );
}
