/**
 * App-level preferences from Settings, General, kept on this machine.
 *
 *  - Whether the handover briefing opens by itself before the US open. Read
 *    by `briefingAutoOpen()` in dashboard-config, which every automatic
 *    showing goes through; Shift+M and the calendar card still open it.
 *
 * "Open when the computer starts" in the same section is the OS login item, held by the
 * main process (main/system), not a preference here. The app always opens on
 * the Dashboard; the start-screen choice it used to offer ("Dashboard",
 * "Graph", "Last screen") is gone, and `forgetStartScreen` drops what it kept.
 *
 * Safe to import from node-side tests: storage is reached only inside
 * try/catch, and every reader takes the storage it should use.
 */

export const BRIEFING_AUTO_OPEN_KEY = "falcon.ui.briefing.autoOpen";

/** Keys the retired start-screen choice wrote: the choice, and the screen and tab kept at close. */
export const RETIRED_START_KEYS = ["falcon.ui.startView", "falcon.ui.lastScreen"] as const;

type Store = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(storage: Store | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: Store | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    /* not kept; the default stands next launch */
  }
}

export function readBriefingAutoOpenPref(storage: Store | null = defaultStorage()): boolean {
  return read(storage, BRIEFING_AUTO_OPEN_KEY) !== "false";
}

export function writeBriefingAutoOpenPref(on: boolean, storage: Store | null = defaultStorage()): void {
  write(storage, BRIEFING_AUTO_OPEN_KEY, on ? "true" : "false");
}

/** Drops what the retired start-screen choice kept. Nothing reads those keys any more; this only tidies. */
export function forgetStartScreen(
  storage: Pick<Storage, "removeItem"> | null = defaultStorage(),
): void {
  for (const key of RETIRED_START_KEYS) {
    try {
      storage?.removeItem(key);
    } catch {
      /* left behind; harmless, nothing reads it */
    }
  }
}
