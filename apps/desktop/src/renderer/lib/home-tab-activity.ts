import { createContext, startTransition, useContext, useEffect, useRef } from "react";

/**
 * Whether the home tab something is drawn in is the one in front. The home
 * page keeps every opened tab mounted and hides the ones behind
 * (components/dashboard/HomeTabPanels.tsx); a hidden tab keeps its window
 * listeners and timers, so what must not run unseen asks here.
 *
 * Read at the moment, not as render state: a switch then redraws nothing in
 * the tabs themselves. Outside the home page (a preview harness, a modal
 * drawn elsewhere) everything is in front.
 */
export type HomeTabActivity = {
  isActive(): boolean;
  /** Told on every change, with the new value. */
  onChange(fn: (active: boolean) => void): () => void;
};

const ALWAYS: HomeTabActivity = { isActive: () => true, onChange: () => () => {} };

export const HomeTabActivityContext = createContext<HomeTabActivity>(ALWAYS);

export function useHomeTabActivity(): HomeTabActivity {
  return useContext(HomeTabActivityContext);
}

/** The tab's `isActive`, for a key handler: a hidden tab's keys must not act on a screen the reader cannot see. */
export function useHomeTabIsActive(): () => boolean {
  return useHomeTabActivity().isActive;
}

/**
 * Calls `fn` each time the tab comes back to the front, for a timer that
 * skipped its ticks while hidden to catch up. In a transition: the tab is
 * painted as it was left first, and the catch-up redraw follows.
 */
export function useOnHomeTabShown(fn: () => void): void {
  const activity = useHomeTabActivity();
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(
    () =>
      activity.onChange((active) => {
        if (active) startTransition(() => latest.current());
      }),
    [activity],
  );
}
