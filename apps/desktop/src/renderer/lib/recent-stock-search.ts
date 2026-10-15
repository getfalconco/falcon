import type { StockCatalogEntry } from "../../shared/stock-catalog";
import { readRememberSearches } from "./privacy-prefs";

const STORAGE_KEY = "meridian-recent-stock-search";
const CHANGE_EVENT = "meridian-recent-stock-search-change";
const MAX_RECENT = 6;

export function getRecentStockSearches(): StockCatalogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StockCatalogEntry =>
        Boolean(entry) &&
        typeof (entry as StockCatalogEntry).symbol === "string" &&
        typeof (entry as StockCatalogEntry).companyName === "string",
    );
  } catch {
    return [];
  }
}

/** Keeps a pick, unless Settings, Privacy, "Remember recent searches" is off. */
export function addRecentStockSearch(entry: StockCatalogEntry): void {
  if (!readRememberSearches()) return;
  const normalized: StockCatalogEntry = {
    symbol: entry.symbol.toUpperCase(),
    companyName: entry.companyName,
    exchange: entry.exchange,
  };

  const list = getRecentStockSearches().filter(
    (item) => item.symbol.toUpperCase() !== normalized.symbol,
  );
  list.unshift(normalized);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // private mode / quota
  }
}

/** Forgets every recent search (Settings, Privacy: "Local history", or turning "Remember recent searches" off). */
export function clearRecentStockSearches(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // private mode / quota
  }
}

export function subscribeRecentStockSearches(callback: () => void): () => void {
  const handler = () => callback();
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}
