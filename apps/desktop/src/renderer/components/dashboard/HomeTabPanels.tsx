import {
  forwardRef,
  memo,
  startTransition,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { HOME_TAB_IDS, type HomeTabId } from "@/lib/home-tabs";
import type { HomeTabState, HomeTabStore } from "@/lib/home-tab-store";
import { HomeTabActivityContext, type HomeTabActivity } from "@/lib/home-tab-activity";

/**
 * The home tabs' bodies, kept alive. Every tab that has been opened (or
 * prefetched while the app was idle) stays mounted; the ones behind are
 * skipped with `content-visibility: hidden`, which keeps their layout, their
 * scroll positions and their state, and costs no style, layout or paint
 * while hidden. A switch toggles two panels instead of unmounting one tab
 * and mounting the other.
 *
 * The panels share one grid cell, so a hidden tab measures where it would
 * stand when shown (the Agents tab sizes itself to the window from its own
 * top). A tab opened for the first time mounts in a transition: the strip
 * and the heading turn at once, and the tab before stays up until the new
 * one is ready.
 */

export function useHomeTab(store: HomeTabStore): HomeTabId {
  return useSyncExternalStore(store.subscribe, () => store.get().tab);
}

/** Draws `children(tab)` and redraws only it when the front tab changes. */
export function OnHomeTab({ store, children }: { store: HomeTabStore; children: (tab: HomeTabId) => ReactNode }) {
  return <>{children(useHomeTab(store))}</>;
}

/**
 * The page's scroll area, named after the front tab. Its children are the
 * page's own elements, so a tab change relabels it without redrawing them.
 */
export const HomeTabMain = forwardRef<
  HTMLElement,
  Omit<HTMLAttributes<HTMLElement>, "aria-label"> & { store: HomeTabStore; label: (tab: HomeTabId) => string }
>(function HomeTabMain({ store, label, children, ...rest }, ref) {
  const tab = useHomeTab(store);
  return (
    <main ref={ref} aria-label={label(tab)} {...rest}>
      {children}
    </main>
  );
});

const SHOWN: CSSProperties = { gridArea: "1 / 1", minWidth: 0 };
/** A kept tab: skipped, zero high, at the top of the shared cell. Also how the page hides the tabs under a stock. */
export const KEPT: CSSProperties = { gridArea: "1 / 1", minWidth: 0, alignSelf: "start", contentVisibility: "hidden" };

const Panel = memo(function Panel({ id, active, children }: { id: HomeTabId; active: boolean; children: ReactNode }) {
  // One object for the panel's life, so the tab never redraws for it; the
  // value is read at the moment and changes are told to whoever asked.
  const activeRef = useRef(active);
  activeRef.current = active;
  const listeners = useRef(new Set<(active: boolean) => void>());
  const activity = useMemo<HomeTabActivity>(
    () => ({
      isActive: () => activeRef.current,
      onChange: (fn) => {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
    }),
    [],
  );
  const told = useRef(active);
  useEffect(() => {
    if (told.current === active) return;
    told.current = active;
    for (const fn of listeners.current) fn(active);
  }, [active]);
  return (
    <HomeTabActivityContext.Provider value={activity}>
      <div data-home-tab-panel={id} aria-hidden={active ? undefined : true} style={active ? SHOWN : KEPT}>
        {children}
      </div>
    </HomeTabActivityContext.Provider>
  );
});

/** How long after the first paint the idle prefetch of the other tabs starts. */
const PREFETCH_AFTER_MS = 2500;

type Idle = (cb: () => void) => () => void;
const onIdle: Idle = (cb) => {
  if (typeof window.requestIdleCallback === "function") {
    const h = window.requestIdleCallback(cb, { timeout: 4000 });
    return () => window.cancelIdleCallback(h);
  }
  const h = window.setTimeout(cb, 200);
  return () => window.clearTimeout(h);
};

export default function HomeTabPanels({
  store,
  panels,
  hidden = false,
  scrollRoot,
}: {
  store: HomeTabStore;
  /** What each tab draws. Keep the elements stable across renders, or the kept tabs redraw. */
  panels: Readonly<Record<HomeTabId, ReactNode>>;
  /** A stock or the graph is in their place (the page hides the whole block): all are kept, none is in front. */
  hidden?: boolean;
  /** The scroll area the tabs share; each tab's place in it is kept and given back. */
  scrollRoot: RefObject<HTMLElement | null>;
}) {
  const state: HomeTabState = useSyncExternalStore(store.subscribe, store.get);
  // A tab mounting for the first time renders in a transition; until it is
  // ready the tab that was in front stays shown (`deferred.tab`).
  const deferred = useDeferredValue(state);
  const shown = deferred.mounted.includes(state.tab) ? state.tab : deferred.tab;
  const mounted = deferred.mounted;

  // Each tab's scroll in the shared scroll area, given back when it returns.
  const scroll = useRef<Partial<Record<HomeTabId, number>>>({});
  const live = useRef({ shown, hidden });
  live.current = { shown, hidden };
  useEffect(() => {
    const el = scrollRoot.current;
    if (!el) return;
    const onScroll = () => {
      if (!live.current.hidden) scroll.current[live.current.shown] = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRoot]);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = scrollRoot.current;
    if (el && !hidden) el.scrollTop = scroll.current[shown] ?? 0;
  }, [shown, hidden, scrollRoot]);

  // The front tab was unmounted under a stock (see HomePage's tabWithDialog):
  // mount it again as the tabs come back. Only then: the eviction can land a
  // render before the page hides the tabs, and must not be undone there.
  const wasHidden = useRef(hidden);
  useLayoutEffect(() => {
    const back = wasHidden.current && !hidden;
    wasHidden.current = hidden;
    if (back && !state.mounted.includes(state.tab)) store.mount(state.tab);
  }, [hidden, state, store]);

  // Once the first screen has settled, mount the other tabs one per idle
  // slot, so the first visit to each is a switch and not a mount.
  useEffect(() => {
    let cancel: (() => void) | null = null;
    let stopped = false;
    const next = () => {
      if (stopped) return;
      const id = HOME_TAB_IDS.find((t) => !store.get().mounted.includes(t));
      if (!id) return;
      cancel = onIdle(() => {
        startTransition(() => store.mount(id));
        const h = window.setTimeout(next, 400);
        cancel = () => window.clearTimeout(h);
      });
    };
    const h = window.setTimeout(next, PREFETCH_AFTER_MS);
    return () => {
      stopped = true;
      window.clearTimeout(h);
      cancel?.();
    };
  }, [store]);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)]">
      {mounted.map((id) => (
        <Panel key={id} id={id} active={!hidden && id === shown}>
          {panels[id]}
        </Panel>
      ))}
    </div>
  );
}
