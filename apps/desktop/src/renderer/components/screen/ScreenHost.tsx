import { useEffect, useState } from "react";
import ScreenPanel from "./ScreenPanel";
import { getWatchlist, subscribeWatchlist } from "@/lib/watchlist";

/**
 * Global Shift+S toggle for the Screen panel (spec §7). Mounted once at the
 * root, reachable from any screen and ONLY by this shortcut — like Shift+T
 * (Tracker), Shift+B/A (Base/Analyst), Shift+P (Propagation), Shift+R (Risk)
 * and Shift+F (Gauge), nothing in the product UI links to it. Debug-grade;
 * the Opportunities/dashboard surface is a later design pass (§8).
 */
/** Fire on `window` to open the Screen panel from anywhere. */
export const SCREEN_OPEN_EVENT = "falcon:screen-open";

export function openScreenPanel(): void {
  window.dispatchEvent(new CustomEvent(SCREEN_OPEN_EVENT));
}

export default function ScreenHost() {
  const [open, setOpen] = useState(false);

  // S1: the emit gate runs in main on the close-run poll, but the watchlist
  // lives in the renderer — push it (and every later change) so a scan with
  // no panel open still knows which tickers the user is close to.
  useEffect(() => {
    const push = () => {
      void window.meridian?.pushScreenWatchlist(getWatchlist().map((e) => e.ticker.toUpperCase()));
    };
    push();
    return subscribeWatchlist(push);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const isS = event.code === "KeyS" || event.key.toLowerCase() === "s";
      if (!isS) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      }
      event.preventDefault();
      setOpen((v) => !v);
    };
    // The band card's own button asks for the panel without knowing the key.
    const onOpenRequest = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(SCREEN_OPEN_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(SCREEN_OPEN_EVENT, onOpenRequest);
    };
  }, []);

  if (!open) return null;
  return <ScreenPanel onClose={() => setOpen(false)} />;
}
