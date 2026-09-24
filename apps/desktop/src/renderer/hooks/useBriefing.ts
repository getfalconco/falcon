import { useEffect, useSyncExternalStore } from "react";
import {
  getBriefingState,
  refreshBriefing,
  retainBriefing,
  subscribeBriefing,
  type BriefingState,
} from "@/lib/briefing-store";

export type UseBriefing = BriefingState & {
  /** The manual refresh: skips the main-process cache, throttled by the store. */
  refresh: () => void;
};

function refresh(): void {
  void refreshBriefing({ force: true });
}

/**
 * The shared handover report, for anything that draws it.
 *
 * Mounting this hook is what tells the store someone is looking: the store
 * fetches and polls only while at least one holder exists, so a component that
 * uses the hook while it is off screen keeps a provider round going every few
 * minutes for nobody. The host that only needs to WATCH for a report (to decide
 * whether the panel opens by itself) passes `retain: false` and takes its hold
 * on the store for just as long as that decision is open.
 */
export function useBriefing(options: { retain?: boolean } = {}): UseBriefing {
  const retain = options.retain !== false;
  const state = useSyncExternalStore(subscribeBriefing, getBriefingState);
  useEffect(() => (retain ? retainBriefing() : undefined), [retain]);
  return { ...state, refresh };
}
