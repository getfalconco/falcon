import { useSyncExternalStore } from "react";
import { getRecentStockSearches } from "./recent-stock-search";

/**
 * Which stock the Stock tab shows, and the few opened before it.
 *
 * Every "open this stock" in the app (the search bar, a ticker in Positions,
 * Earnings, Calendar, News or Agents, `openStock()`) lands here and brings
 * the Stock tab forward (pages/HomePage.tsx). The recent list is the tab's
 * quick switcher: the last five, newest first, for this run of the app. It
 * starts from the search bar's own recent picks, which the reader can turn
 * off and clear in Settings, Privacy, so it keeps nothing of its own on disk.
 *
 * Kept free of React rendering so the rules can be tested on their own.
 */

export type OpenStock = { symbol: string; companyName: string; exchange?: string };

export type StockTabState = {
  readonly current: OpenStock | null;
  /** Newest first, `current` included, at most RECENT_STOCKS_MAX. */
  readonly recent: readonly OpenStock[];
};

export const RECENT_STOCKS_MAX = 5;

const SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;

/** The entry as kept, or null when the symbol is not one. A missing name is the symbol. */
export function normalizeOpenStock(entry: { symbol?: unknown; companyName?: unknown; exchange?: unknown } | null | undefined): OpenStock | null {
  const symbol = typeof entry?.symbol === "string" ? entry.symbol.trim().toUpperCase() : "";
  if (!SYMBOL.test(symbol)) return null;
  const name = typeof entry?.companyName === "string" ? entry.companyName.trim() : "";
  const exchange = typeof entry?.exchange === "string" && entry.exchange.trim() ? entry.exchange.trim() : undefined;
  return { symbol, companyName: name || symbol, ...(exchange ? { exchange } : {}) };
}

export type StockTabStore = {
  get(): StockTabState;
  subscribe(fn: () => void): () => void;
  /** Shows `entry` in the tab and puts it at the head of the recent list. */
  open(entry: { symbol: string; companyName?: string; exchange?: string }): OpenStock | null;
};

export function createStockTabStore(seed: ReadonlyArray<{ symbol: string; companyName?: string; exchange?: string }> = []): StockTabStore {
  const recent: OpenStock[] = [];
  for (const s of seed) {
    const e = normalizeOpenStock(s);
    if (e && !recent.some((r) => r.symbol === e.symbol)) recent.push(e);
    if (recent.length >= RECENT_STOCKS_MAX) break;
  }
  let state: StockTabState = { current: null, recent };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    open(raw) {
      const entry = normalizeOpenStock(raw);
      if (!entry) return null;
      const known = state.recent.find((r) => r.symbol === entry.symbol);
      // A ticker click knows only the symbol; the name a search gave it earlier stays.
      const merged: OpenStock =
        known && entry.companyName === entry.symbol
          ? { ...known }
          : { ...entry, ...(entry.exchange || !known?.exchange ? {} : { exchange: known.exchange }) };
      const same =
        state.current?.symbol === merged.symbol &&
        state.current.companyName === merged.companyName &&
        state.current.exchange === merged.exchange &&
        state.recent[0]?.symbol === merged.symbol;
      if (same) return state.current;
      state = {
        current: merged,
        recent: [merged, ...state.recent.filter((r) => r.symbol !== merged.symbol)].slice(0, RECENT_STOCKS_MAX),
      };
      for (const fn of listeners) fn();
      return merged;
    },
  };
}

let shared: StockTabStore | null = null;

/** The app's one store, seeded from the search bar's recent picks on first use. */
export function stockTabStore(): StockTabStore {
  if (!shared) {
    let seed: ReturnType<typeof getRecentStockSearches> = [];
    try {
      seed = getRecentStockSearches();
    } catch {
      seed = [];
    }
    shared = createStockTabStore(seed);
  }
  return shared;
}

export function useStockTab(): StockTabState {
  const store = stockTabStore();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
