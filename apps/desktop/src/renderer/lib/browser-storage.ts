/**
 * What the app keeps in its browser storage, counted and copied for Settings →
 * Privacy. Pure over a Storage, so it runs against a stand-in in a test.
 */

/**
 * Keys that hold the sign-in session itself: Supabase's `sb-<ref>-auth-token`
 * (access and refresh tokens) and its PKCE verifier. They are counted, never
 * exported — a file of the reader's data must not double as a way into the
 * account.
 */
export function isSessionKey(key: string): boolean {
  return /^sb-.*-(auth-token|code-verifier)/.test(key) || key.includes("auth-token");
}

export type BrowserStorageSummary = {
  /** Keys the app keeps (preferences, paper account, watchlist, layout …). */
  keys: number;
  /** UTF-8 size of those keys and values. */
  bytes: number;
  /** Sign-in session keys, counted apart. */
  sessionKeys: number;
};

type StorageLike = Pick<Storage, "length" | "key" | "getItem">;

function entries(storage: StorageLike): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key === null) continue;
    const value = storage.getItem(key);
    if (value !== null) out.push([key, value]);
  }
  return out;
}

const encoder = new TextEncoder();

export function summarizeBrowserStorage(storage: StorageLike): BrowserStorageSummary {
  const out: BrowserStorageSummary = { keys: 0, bytes: 0, sessionKeys: 0 };
  for (const [key, value] of entries(storage)) {
    if (isSessionKey(key)) {
      out.sessionKeys += 1;
      continue;
    }
    out.keys += 1;
    out.bytes += encoder.encode(key).length + encoder.encode(value).length;
  }
  return out;
}

/** Every stored key and value, session keys left out. */
export function snapshotBrowserStorage(storage: StorageLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of entries(storage)) if (!isSessionKey(key)) out[key] = value;
  return out;
}

/** Bytes for a reader: "0 B", "12 KB", "3.4 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
