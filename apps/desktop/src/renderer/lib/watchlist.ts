export type WatchlistEntry = {
  ticker: string;
  companyName: string;
};

const STORAGE_KEY = "meridian-watchlist";
const CHANGE_EVENT = "meridian-watchlist-change";

export function getWatchlist(): WatchlistEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is WatchlistEntry =>
        Boolean(entry) &&
        typeof (entry as WatchlistEntry).ticker === "string" &&
        typeof (entry as WatchlistEntry).companyName === "string",
    );
  } catch {
    return [];
  }
}

function save(entries: WatchlistEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // private mode / quota
  }
}

export function isFollowed(ticker: string): boolean {
  const upper = ticker.toUpperCase();
  return getWatchlist().some((entry) => entry.ticker.toUpperCase() === upper);
}

/** Adds or removes a stock from the watchlist. Returns the new follow state. */
export function toggleFollow(entry: WatchlistEntry): boolean {
  const upper = entry.ticker.toUpperCase();
  const list = getWatchlist();
  const index = list.findIndex((item) => item.ticker.toUpperCase() === upper);

  if (index >= 0) {
    list.splice(index, 1);
    save(list);
    return false;
  }

  list.unshift({ ticker: upper, companyName: entry.companyName });
  save(list);
  return true;
}

/** Subscribe to watchlist changes (same tab and cross-tab). */
export function subscribeWatchlist(callback: () => void): () => void {
  const handler = () => callback();
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}
