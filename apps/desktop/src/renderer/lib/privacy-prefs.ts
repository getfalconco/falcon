/**
 * The two switches under Settings, Privacy, Preferences, kept on this machine.
 *
 *  - Remember recent searches: whether ⌘K keeps the last stocks opened from
 *    it (lib/recent-stock-search). Off, nothing new is kept; the pane clears
 *    what was already there when it is turned off.
 *  - Falcon's read on news: whether the news panel asks main for its own read
 *    of a story the server has not ruled on (NewsArticleModal). Off, the
 *    article text is never sent to the model for it.
 *
 * Both are on unless turned off. Safe to import from node-side tests: storage
 * is reached only inside try/catch, and every reader takes the storage it
 * should use.
 */

export const REMEMBER_SEARCHES_KEY = "falcon.privacy.rememberSearches";
export const NEWS_READ_KEY = "falcon.privacy.newsRead";

type Store = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readOn(storage: Store | null, key: string): boolean {
  try {
    return storage?.getItem(key) !== "0";
  } catch {
    return true;
  }
}

function writeOn(storage: Store | null, key: string, on: boolean): void {
  try {
    storage?.setItem(key, on ? "1" : "0");
  } catch {
    /* not kept; the default stands next launch */
  }
}

export function readRememberSearches(storage: Store | null = defaultStorage()): boolean {
  return readOn(storage, REMEMBER_SEARCHES_KEY);
}

export function writeRememberSearches(on: boolean, storage: Store | null = defaultStorage()): void {
  writeOn(storage, REMEMBER_SEARCHES_KEY, on);
}

export function readNewsRead(storage: Store | null = defaultStorage()): boolean {
  return readOn(storage, NEWS_READ_KEY);
}

export function writeNewsRead(on: boolean, storage: Store | null = defaultStorage()): void {
  writeOn(storage, NEWS_READ_KEY, on);
}
