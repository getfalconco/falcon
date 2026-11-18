"use client";

import { authHeaders } from "@/lib/workspace/api-auth";
import {
  LEGACY_PREFIX,
  LIVE_BEAT_MS,
  LIVE_KEY,
  beat,
  deletedKey,
  isLive,
  markDeleted,
  mergeSessions,
  migrateLegacy,
  parseLive,
  parseStored,
  parseTombstones,
  pruneForStorage,
  sessionsKey,
  writeMerged,
  type StoredSession,
  type Tombstones,
} from "@/lib/desk/session-storage";

/**
 * Where Falcon AI sessions are kept (lab/sessions.ts holds them in memory):
 *
 * - This browser: localStorage `falcon.desk.sessions.v2:<scope>`, so sessions
 *   survive closing the browser. The old per-tab sessionStorage copy is moved
 *   over once. Writes are pruned to a budget (lib/desk/session-storage.ts).
 *   Several tabs share it: every write merges with what is stored now, so a
 *   tab never drops another tab's sessions (deletions leave a tombstone), and
 *   other tabs follow through the storage event (watchStoredSessions).
 * - The account, when /api/desk/sessions says its table exists
 *   (supabase/migrations/20261120_desk_sessions.sql): loaded once per page
 *   visit and merged (newest copy of each session wins), then changes are
 *   saved in the background, debounced. Without the table, or in the preview,
 *   the API answers `available: false` and only this browser keeps them.
 */

/** This page's id (new on every load): a reply it streams is stored with it, so other tabs can tell it is still running. */
export const PAGE_ID = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const storage = () => (typeof window === "undefined" ? null : window.localStorage);

/** The JSON this tab last wrote, so its own write is not read back as another tab's. */
const lastWritten = new Map<string, string>();
const watchers = new Map<string, (list: StoredSession[], deleted: Tombstones) => void>();
let listening = false;

/** The stored sessions (raw; the caller re-checks them), moving the old sessionStorage copy over first. */
export function readStoredSessions(scope: string): StoredSession[] {
  let local: string | null = null;
  let legacy: string | null = null;
  try {
    local = window.localStorage.getItem(sessionsKey(scope));
  } catch {
    // Blocked storage.
  }
  try {
    legacy = window.sessionStorage.getItem(`${LEGACY_PREFIX}:${scope}`);
  } catch {
    // Blocked storage.
  }
  if (legacy === null) return parseStored(local) ?? [];
  const merged = migrateLegacy(local, legacy);
  if (writeStoredSessions(scope, merged)) {
    try {
      window.sessionStorage.removeItem(`${LEGACY_PREFIX}:${scope}`);
    } catch {
      // Kept; merged again next time, which changes nothing.
    }
  }
  return merged;
}

/**
 * Writes the list merged with what is stored now (another tab's sessions are kept; lib/desk/session-storage.ts
 * writeMerged). Returns the merged list, with `adopted` when it has sessions or newer copies this tab lacked, or null
 * when nothing could be written.
 */
export function writeStoredSessions(scope: string, list: StoredSession[]): { list: StoredSession[]; adopted: boolean } | null {
  const st = storage();
  if (!st) return null;
  const r = writeMerged(st, scope, list);
  if (!r) return null;
  lastWritten.set(scope, r.json);
  return { list: r.list, adopted: r.adopted };
}

/** Sessions deleted in this tab: tombstoned first, so no tab's next merge brings them back. */
export function forgetStoredSessions(scope: string, ids: string[]): void {
  const st = storage();
  if (st) markDeleted(st, scope, ids);
}

/** Session ids deleted in any tab of this browser (recently). */
export function deletedSessions(scope: string): Tombstones {
  try {
    return parseTombstones(storage()?.getItem(deletedKey(scope)));
  } catch {
    return {};
  }
}

/** Calls `onChange` with the stored list and the tombstones when another tab of this browser writes this workspace's sessions. */
export function watchStoredSessions(scope: string, onChange: (list: StoredSession[], deleted: Tombstones) => void): void {
  watchers.set(scope, onChange);
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("storage", (e) => {
    if (!e.key?.startsWith(`${sessionsKey("")}`)) return;
    const scope = e.key.slice(sessionsKey("").length);
    const fn = watchers.get(scope);
    if (!fn || (e.newValue ?? "") === lastWritten.get(scope)) return;
    lastWritten.set(scope, e.newValue ?? "");
    fn(parseStored(e.newValue) ?? [], deletedSessions(scope));
  });
}

/* ---------- Which pages are streaming (a reply stored as streaming shows as running in other tabs while its page lives) ---------- */

let liveRead: { at: number; pages: ReturnType<typeof parseLive> } | null = null;

/** Whether a reply stored as streaming by page `tab` is still running there (another live page; never this one). */
export function streamingElsewhere(tab: unknown): boolean {
  if (typeof tab !== "string" || tab === PAGE_ID) return false;
  const now = Date.now();
  if (!liveRead || now - liveRead.at > 1_000) {
    let raw: string | null = null;
    try {
      raw = storage()?.getItem(LIVE_KEY) ?? null;
    } catch {
      // Blocked storage.
    }
    liveRead = { at: now, pages: parseLive(raw) };
  }
  return isLive(liveRead.pages, tab, now);
}

let beating: ReturnType<typeof setInterval> | null = null;

function writeBeat(alive: boolean) {
  try {
    const st = storage();
    if (!st) return;
    st.setItem(LIVE_KEY, JSON.stringify(beat(parseLive(st.getItem(LIVE_KEY)), PAGE_ID, Date.now(), alive)));
  } catch {
    // Blocked storage: other tabs show this page's replies as stopped.
  }
}

/** While this page streams a reply it beats every few seconds; when it stops (or the page goes away) other tabs see its replies as stopped. */
export function setStreaming(active: boolean): void {
  if (typeof window === "undefined") return;
  if (active && !beating) {
    writeBeat(true);
    beating = setInterval(() => writeBeat(true), LIVE_BEAT_MS);
    window.addEventListener("pagehide", onPageHide);
  } else if (!active && beating) {
    clearInterval(beating);
    beating = null;
    writeBeat(false);
    window.removeEventListener("pagehide", onPageHide);
  }
}

function onPageHide() {
  writeBeat(false);
}

/* ---------- Account sync (works once the desk_sessions table exists) ---------- */

const API = "/api/desk/sessions";
const SAVE_DELAY_MS = 1_500;
/** Per session sent to the server (the route caps the body). */
const SERVER_SESSION_BUDGET = 1_500_000;

type Sync = {
  /** null while the first load is out; false when the API has no table (or no account). */
  available: boolean | null;
  /** JSON of each session as last saved (or loaded), by id. */
  saved: Map<string, string>;
  order: string;
  timer: ReturnType<typeof setTimeout> | null;
  latest: StoredSession[] | null;
  busy: boolean;
};
const syncs = new Map<string, Sync>();

type Row = { id: string; title: string; pinned: boolean; sort_order: number; folder: string | null; created_at: string; updated_at: string; messages?: unknown };

const toSession = (r: Row): StoredSession => ({
  id: r.id,
  title: r.title,
  createdAt: Date.parse(r.created_at) || 0,
  updatedAt: Date.parse(r.updated_at) || 0,
  ...(r.pinned ? { pinned: true } : {}),
  ...(r.folder ? { folder: r.folder } : {}),
  messages: Array.isArray(r.messages) ? (r.messages as StoredSession["messages"]) : [],
});

async function call(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(await authHeaders()), ...(init?.headers ?? {}) } });
  } catch {
    return null;
  }
}

const settled = (s: StoredSession) => !s.messages.some((m) => (m as { status?: string }).status === "streaming");

/**
 * Starts account sync for a workspace once per page visit: loads the server's
 * sessions and hands the merged list to `apply` (which saves it locally and
 * calls scheduleServerSave again). Does nothing more when there is no table.
 */
export function startServerSync(scope: string, local: () => StoredSession[], apply: (list: StoredSession[]) => void): void {
  if (syncs.has(scope) || typeof window === "undefined") return;
  const st: Sync = { available: null, saved: new Map(), order: "", timer: null, latest: null, busy: false };
  syncs.set(scope, st);
  void (async () => {
    const res = await call(API);
    const body = res?.ok ? ((await res.json().catch(() => null)) as { available?: boolean; sessions?: Row[] } | null) : null;
    if (!body?.available || !Array.isArray(body.sessions)) {
      st.available = false;
      return;
    }
    const mine = local();
    const byId = new Map(mine.map((s) => [s.id, s]));
    // Full copies only of sessions this browser lacks or has older.
    const need = body.sessions.filter((r) => (Date.parse(r.updated_at) || 0) > (byId.get(r.id)?.updatedAt ?? -1));
    const loaded = await Promise.all(
      need.slice(0, 50).map(async (r) => {
        const one = await call(`${API}/${encodeURIComponent(r.id)}`);
        const b = one?.ok ? ((await one.json().catch(() => null)) as { session?: Row } | null) : null;
        return b?.session ? toSession(b.session) : null;
      }),
    );
    const remote = body.sessions
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((r) => loaded.find((s) => s?.id === r.id) ?? byId.get(r.id) ?? null)
      .filter((s): s is StoredSession => !!s);
    for (const s of remote) st.saved.set(s.id, JSON.stringify(s));
    st.order = remote.map((s) => s.id).join(",");
    st.available = true;
    // Server order first (another device may have reordered); sessions only here follow and get uploaded.
    const merged = mergeSessions(remote, local());
    apply([...merged.filter((s) => s.pinned), ...merged.filter((s) => !s.pinned)]);
  })();
}

/** Saves changes to the account after a short pause (no-op without the table). */
export function scheduleServerSave(scope: string, list: StoredSession[]): void {
  const st = syncs.get(scope);
  if (!st || st.available === false) return;
  st.latest = list;
  if (st.available === null) return;
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => void flush(scope), SAVE_DELAY_MS);
}

async function flush(scope: string) {
  const st = syncs.get(scope);
  if (!st?.available || !st.latest) return;
  if (st.busy) {
    st.timer = setTimeout(() => void flush(scope), SAVE_DELAY_MS);
    return;
  }
  st.busy = true;
  st.timer = null;
  const list = st.latest;
  try {
    const ids = new Set(list.map((s) => s.id));
    for (const id of Array.from(st.saved.keys())) {
      if (ids.has(id)) continue;
      const res = await call(`${API}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res?.ok) st.saved.delete(id);
    }
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!settled(s)) continue;
      const json = JSON.stringify(s);
      if (st.saved.get(s.id) === json) continue;
      const one = pruneForStorage([s], SERVER_SESSION_BUDGET).list[0] ?? s;
      const res = await call(API, { method: "PUT", body: JSON.stringify({ sessions: [{ ...one, sortOrder: i }] }) });
      if (res?.ok) st.saved.set(s.id, json);
    }
    const order = list.map((s) => s.id).join(",");
    if (order !== st.order) {
      const res = await call(`${API}/reorder`, { method: "POST", body: JSON.stringify({ ids: list.map((s) => s.id) }) });
      if (res?.ok) st.order = order;
    }
  } finally {
    st.busy = false;
  }
}
