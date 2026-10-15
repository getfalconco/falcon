/**
 * The renderer's own preferences: every key under `falcon.ui.` in
 * localStorage — theme, card layout and sizes, columns, shortcuts, start
 * view and the like. The prefix is the line between a choice about how the
 * app looks and what the reader has put into it: the paper portfolio
 * (`falcon.paper…`), the watchlist and recent searches (`meridian-…`) and the
 * Supabase session live under other names and are never touched here.
 *
 * Nothing here imports React, so it can be tested under plain Node.
 */

export const UI_PREFS_PREFIX = "falcon.ui.";

export type PrefsStore = Pick<Storage, "length" | "key" | "removeItem">;

/** Keys a reset would remove, in storage order. */
export function listLocalPreferenceKeys(store: PrefsStore | null): string[] {
  if (!store) return [];
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key && key.startsWith(UI_PREFS_PREFIX)) keys.push(key);
  }
  return keys;
}

/**
 * Removes every UI preference and returns the keys it removed. Keys are
 * collected first: removing while walking by index would skip the neighbour
 * of each removed key.
 */
export function resetLocalPreferences(store: PrefsStore | null): string[] {
  const keys = listLocalPreferenceKeys(store);
  for (const key of keys) store?.removeItem(key);
  return keys;
}

/** localStorage, or null where it is missing or refuses access. */
export function browserPrefsStore(): PrefsStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
