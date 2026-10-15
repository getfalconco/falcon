/**
 * Which home tab is in front, and which tabs are kept alive behind it.
 *
 * A tab that has been opened once stays mounted and is only hidden when
 * another one comes to the front, so going back to it costs a style pass and
 * not a fresh mount (every card refetching, the calendar rebuilding its
 * month). The front tab lives here rather than in HomePage's state so a
 * switch re-renders the strip, the heading and the panels, and not the page
 * with every dashboard card on it.
 *
 * Kept free of React so the rules can be tested on their own; the panels
 * that read it are components/dashboard/HomeTabPanels.tsx.
 */
import { HOME_TAB_IDS, type HomeTabId } from "./home-tabs";

export type HomeTabState = {
  /** The tab in front. */
  readonly tab: HomeTabId;
  /**
   * Tabs that are mounted, in HOME_TAB_IDS order. Includes `tab`, except
   * after `evict(tab)` while a stock or the graph is up; the panels mount it
   * again when the tabs come back.
   */
  readonly mounted: readonly HomeTabId[];
};

export type HomeTabStore = {
  get(): HomeTabState;
  subscribe(fn: () => void): () => void;
  /**
   * Bring `id` to the front, mounting it if it is not yet. `evict` drops a
   * tab from the kept set, so it unmounts as every tab used to on a switch.
   */
  open(id: HomeTabId, evict?: HomeTabId): void;
  /** Mount a tab behind the front one (an idle prefetch). */
  mount(id: HomeTabId): void;
  /** Unmount a tab, the front one included (a stock opened from one of its dialogs). */
  evict(id: HomeTabId): void;
};

const ordered = (ids: Iterable<HomeTabId>): HomeTabId[] => {
  const set = new Set(ids);
  return HOME_TAB_IDS.filter((id) => set.has(id));
};

export function createHomeTabStore(initial: HomeTabId): HomeTabStore {
  let state: HomeTabState = { tab: initial, mounted: [initial] };
  const listeners = new Set<() => void>();
  const commit = (next: HomeTabState) => {
    if (next.tab === state.tab && next.mounted === state.mounted) return;
    state = next;
    for (const fn of listeners) fn();
  };
  const withMounted = (ids: HomeTabId[]): readonly HomeTabId[] =>
    ids.length === state.mounted.length && ids.every((id, i) => id === state.mounted[i]) ? state.mounted : ids;
  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    open(id, evict) {
      const keep = state.mounted.filter((m) => m !== evict || m === id);
      commit({ tab: id, mounted: withMounted(ordered([...keep, id])) });
    },
    mount(id) {
      if (state.mounted.includes(id)) return;
      commit({ tab: state.tab, mounted: ordered([...state.mounted, id]) });
    },
    evict(id) {
      if (!state.mounted.includes(id)) return;
      commit({ tab: state.tab, mounted: state.mounted.filter((m) => m !== id) });
    },
  };
}

type OverlayRoot = Pick<Document, "querySelectorAll">;

/**
 * Whether a dialog is showing. A tab switch with one open can only be a
 * programmatic one (a notification, an "Open AAPL" inside a modal): the
 * dialogs cover the strip. The tab that owned the dialog is then unmounted
 * rather than hidden, so the dialog goes with it, as it did when every
 * switch unmounted the tab, and no hidden `aria-modal` is left behind for
 * the key handlers and the briefing that look for one.
 */
export function overlayShowing(root: OverlayRoot | null | undefined = typeof document === "undefined" ? null : document): boolean {
  if (!root) return false;
  const els = root.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"]');
  for (const el of Array.from(els)) {
    const shown = typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0;
    if (shown) return true;
  }
  return false;
}
