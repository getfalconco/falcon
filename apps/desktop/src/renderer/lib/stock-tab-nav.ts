import { STOCK_OPEN_EVENT, type StockOpenDetail } from "./stock-open";
import type { StockTabStore } from "./stock-tab-store";

/**
 * The one door to the Stock tab: every `openStock()` in the app (a ticker in
 * Positions, Earnings, Calendar, News, Agents, the Insight rail) and every
 * pick in the search bar puts the stock in the tab's store and brings the
 * tab forward. HomePage wires it to its own `openTab`.
 */
export function showStock(
  store: StockTabStore,
  openTab: (id: "stock") => void,
  entry: { symbol: string; companyName?: string; exchange?: string },
): boolean {
  if (!store.open(entry)) return false;
  openTab("stock");
  return true;
}

/** Listens for `openStock()` on `target` (the window) until the returned function is called. */
export function listenForStockOpens(target: EventTarget, store: StockTabStore, openTab: (id: "stock") => void): () => void {
  const onOpen = (event: Event) => {
    const detail = (event as CustomEvent<StockOpenDetail>).detail;
    if (!detail || typeof detail.ticker !== "string") return;
    showStock(store, openTab, { symbol: detail.ticker, companyName: detail.companyName });
  };
  target.addEventListener(STOCK_OPEN_EVENT, onOpen);
  return () => target.removeEventListener(STOCK_OPEN_EVENT, onOpen);
}
