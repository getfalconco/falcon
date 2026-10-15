/**
 * The home screen's top-level tabs — Dashboard, Calendar, and whatever comes
 * after them — as data: which ones exist, the order the reader dragged them
 * into, and which one a launch opens on.
 *
 * Kept free of React so the rules can be tested on their own; the strip that
 * draws them is components/dashboard/HomeTabStrip.tsx, and what each tab
 * shows is decided by HomePage's registry.
 */

/** Every tab this build knows. A new tab is a new id here and an entry in HomePage's registry. */
export const HOME_TAB_IDS = ["dashboard", "calendar", "agents", "earnings", "stock", "exposure"] as const;
export type HomeTabId = (typeof HOME_TAB_IDS)[number];

/** The tab every launch opens on. */
export const DEFAULT_HOME_TAB: HomeTabId = "dashboard";

export const HOME_TAB_ORDER_KEY = "falcon.ui.homeTabOrder.v1";

type Store = Pick<Storage, "getItem" | "setItem">;

export function isHomeTabId(value: unknown): value is HomeTabId {
  return typeof value === "string" && (HOME_TAB_IDS as readonly string[]).includes(value);
}

/**
 * The order to draw. Ids this build does not know are dropped, and so are
 * repeats; a tab the saved order has never seen — one a later build added —
 * goes on the end, so it reaches everyone without moving the tabs they placed.
 * Storage that is missing, blocked or holds junk gives the default order.
 */
export function readHomeTabOrder(store: Store | null | undefined): HomeTabId[] {
  let saved: unknown = null;
  try {
    saved = JSON.parse(store?.getItem(HOME_TAB_ORDER_KEY) ?? "null");
  } catch {
    saved = null;
  }
  const out: HomeTabId[] = [];
  if (Array.isArray(saved)) {
    for (const id of saved) if (isHomeTabId(id) && !out.includes(id)) out.push(id);
  }
  for (const id of HOME_TAB_IDS) if (!out.includes(id)) out.push(id);
  return out;
}

/** Non-fatal: a store that refuses the write leaves the order for this session only. */
export function writeHomeTabOrder(store: Store | null | undefined, order: readonly HomeTabId[]): void {
  try {
    store?.setItem(HOME_TAB_ORDER_KEY, JSON.stringify(order));
  } catch {
    /* non-fatal */
  }
}
