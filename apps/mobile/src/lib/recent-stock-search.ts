import AsyncStorage from "@react-native-async-storage/async-storage";
import type { StockCatalogEntry } from "@/lib/stock-catalog";

const STORAGE_KEY = "meridian-recent-stock-search";
const MAX_RECENT = 6;

const listeners = new Set<() => void>();
let memoryRecent: StockCatalogEntry[] | null = null;
let loadPromise: Promise<StockCatalogEntry[]> | null = null;

function isEntry(value: unknown): value is StockCatalogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as StockCatalogEntry;
  return typeof entry.symbol === "string" && typeof entry.companyName === "string";
}

function notify(): void {
  for (const listener of listeners) listener();
}

async function readStored(): Promise<StockCatalogEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

export async function getRecentStockSearches(): Promise<StockCatalogEntry[]> {
  if (memoryRecent) return memoryRecent;
  if (!loadPromise) {
    loadPromise = readStored().then((entries) => {
      memoryRecent = entries;
      loadPromise = null;
      return entries;
    });
  }
  return loadPromise;
}

export async function addRecentStockSearch(entry: StockCatalogEntry): Promise<void> {
  const normalized: StockCatalogEntry = {
    symbol: entry.symbol.toUpperCase(),
    companyName: entry.companyName,
    exchange: entry.exchange,
  };

  const current = await getRecentStockSearches();
  const list = current.filter((item) => item.symbol.toUpperCase() !== normalized.symbol);
  list.unshift(normalized);
  memoryRecent = list.slice(0, MAX_RECENT);

  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(memoryRecent));
  } catch {
    // quota / private mode
  }

  notify();
}

export function subscribeRecentStockSearches(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
