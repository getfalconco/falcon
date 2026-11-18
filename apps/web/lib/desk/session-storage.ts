/**
 * Falcon AI sessions on disk (pure: no React, no browser globals, so node:test
 * can check it). The client store (app/app/_components/lab/session-store.ts)
 * keeps sessions in localStorage under `falcon.desk.sessions.v2:<scope>` and
 * moves the old per-tab sessionStorage copy (`falcon.lab.v1:<scope>`) there
 * once. Writing fits the list into a character budget by dropping, oldest
 * session first, only what is not needed to re-render the thread: long tool
 * results, image thumbnails, and question-card tokens no longer needed to
 * answer. Charts, ask cards (questions and answers) and run results stay.
 *
 * Several tabs of one browser share the list. Every write is a merge
 * (`writeMerged`): it reads what is stored now and never drops a session
 * another tab added; a session in both keeps the copy updated last (a tie
 * keeps the writer's). A deleted session leaves a tombstone
 * (`falcon.desk.deleted.v1:<scope>`) so the merge does not bring it back.
 * A reply still streaming is stored with the id of the page streaming it
 * (`tab`); another tab shows it as still running while that page is alive
 * (`falcon.desk.live.v1`, a heartbeat per page) and as stopped once it is gone.
 */

export const LOCAL_PREFIX = "falcon.desk.sessions.v2";
export const LEGACY_PREFIX = "falcon.lab.v1";
/** Characters per workspace in localStorage (browsers allow about 5M per site, shared with sign-in and settings). */
export const LOCAL_BUDGET = 2_500_000;
/** A tool result kept on disk is cut to this many characters (the live page keeps more). */
export const RESULT_CHARS = 6_000;
/** Older sessions under budget pressure keep this much of each tool result. */
export const RESULT_CHARS_TIGHT = 600;

type Obj = Record<string, unknown>;
/** The stored shape, loosely: the client's cleanMessage/cleanTools re-check everything on load. */
export type StoredTool = Obj & { result?: string; chart?: unknown };
export type StoredMessage = Obj & {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  images?: (Obj & { thumb: string | null })[];
  tools?: StoredTool[];
  ask?: Obj & { token: string; answers?: unknown; skipped?: boolean };
};
export type StoredSession = Obj & { id: string; title: string; createdAt: number; updatedAt: number; pinned?: boolean; folder?: string | null; messages: StoredMessage[] };

const isSession = (s: unknown): s is StoredSession => {
  const x = s as StoredSession | null;
  return !!x && typeof x === "object" && typeof x.id === "string" && typeof x.title === "string" && Array.isArray(x.messages);
};

/** A stored list read back: anything that is not a session is dropped; null when there is nothing readable. */
export function parseStored(raw: string | null | undefined): StoredSession[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(isSession) : null;
  } catch {
    return null;
  }
}

/**
 * Two lists as one: `primary`'s order, then sessions only in `secondary`
 * (in their order). A session in both keeps the copy updated last; on a tie
 * the primary one.
 */
export function mergeSessions<S extends { id: string; updatedAt: number }>(primary: S[], secondary: S[]): S[] {
  const other = new Map(secondary.map((s) => [s.id, s]));
  const out = primary.map((s) => {
    const o = other.get(s.id);
    return o && (o.updatedAt || 0) > (s.updatedAt || 0) ? o : s;
  });
  const seen = new Set(primary.map((s) => s.id));
  for (const s of secondary) if (!seen.has(s.id)) out.push(s);
  return out;
}

/**
 * The one-time move from sessionStorage: what localStorage holds, plus any
 * session only the old tab copy had (or a newer copy of one). Pinned first.
 */
export function migrateLegacy(localRaw: string | null, legacyRaw: string | null): StoredSession[] {
  const local = parseStored(localRaw) ?? [];
  const legacy = parseStored(legacyRaw) ?? [];
  const merged = mergeSessions(local, legacy);
  return [...merged.filter((s) => s.pinned), ...merged.filter((s) => !s.pinned)];
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (shortened)` : s);

/** Pruning levels, mildest first. 0 is always applied. */
type Level = 0 | 1 | 2 | 3;

function pruneMessage(m: StoredMessage, level: Level, keepToken: boolean): StoredMessage {
  let out = m;
  // A question card's token only matters while the card can still be answered, or for the reply right after it.
  if (m.ask && m.ask.token && !keepToken && (m.ask.answers || m.ask.skipped)) out = { ...out, ask: { ...m.ask, token: "" } };
  if (m.tools?.length) {
    const max = level >= 1 ? RESULT_CHARS_TIGHT : RESULT_CHARS;
    const tools = m.tools.map((t) => {
      if (typeof t.result !== "string") return t;
      if (level >= 3) {
        const { result: _drop, ...rest } = t;
        return rest as StoredTool;
      }
      return t.result.length > max ? { ...t, result: cut(t.result, max) } : t;
    });
    out = { ...out, tools };
  }
  if (level >= 2 && m.images?.some((i) => i.thumb)) out = { ...out, images: m.images.map((i) => ({ ...i, thumb: null })) };
  return out;
}

/** A session pruned to `level`; the last two messages keep their ask tokens (answer or retry still works). */
export function pruneSession(s: StoredSession, level: Level): StoredSession {
  const n = s.messages.length;
  return { ...s, messages: s.messages.map((m, i) => pruneMessage(m, level, i >= n - 2)) };
}

/**
 * The list as it should be written: pruned, oldest session first, until its
 * JSON fits `budget` characters. As a last resort the oldest unpinned sessions
 * are left out (never the newest one). `json` is what to write.
 */
export function pruneForStorage(list: StoredSession[], budget = LOCAL_BUDGET): { list: StoredSession[]; json: string; dropped: number } {
  const items = list.map((s) => {
    const p = pruneSession(s, 0);
    return { s: p, size: JSON.stringify(p).length + 1, level: 0 as Level, gone: false };
  });
  let total = items.reduce((a, b) => a + b.size, 1);
  // Oldest first by last use.
  const order = items.map((_, i) => i).sort((a, b) => (items[a].s.updatedAt || 0) - (items[b].s.updatedAt || 0));
  for (const level of [1, 2, 3] as Level[]) {
    for (const i of order) {
      if (total <= budget) break;
      const it = items[i];
      const p = pruneSession(list[i], level);
      const size = JSON.stringify(p).length + 1;
      total += size - it.size;
      items[i] = { s: p, size, level, gone: false };
    }
  }
  let dropped = 0;
  const newest = order[order.length - 1];
  for (const i of order) {
    if (total <= budget) break;
    if (i === newest || items[i].s.pinned) continue;
    total -= items[i].size;
    items[i].gone = true;
    dropped++;
  }
  const kept = items.filter((it) => !it.gone).map((it) => it.s);
  return { list: kept, json: JSON.stringify(kept), dropped };
}

/* ---------- Several tabs (pure: the browser store passes window.localStorage) ---------- */

/** The part of the Web Storage API the merge needs (a Map-backed fake in tests). */
export type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

export const DELETED_PREFIX = "falcon.desk.deleted.v1";
export const LIVE_KEY = "falcon.desk.live.v1";
/** Tombstones are kept this long (a tab left open longer could bring a deleted session back), at most MAX_TOMBSTONES. */
export const TOMBSTONE_MS = 30 * 86_400_000;
const MAX_TOMBSTONES = 500;
/** A page that has not beaten for this long is gone (it beats every LIVE_BEAT_MS while a reply streams). */
export const LIVE_MS = 20_000;
export const LIVE_BEAT_MS = 5_000;

export const sessionsKey = (scope: string) => `${LOCAL_PREFIX}:${scope}`;
export const deletedKey = (scope: string) => `${DELETED_PREFIX}:${scope}`;

/** Deleted session ids with when they were deleted. */
export type Tombstones = Record<string, number>;

export function parseTombstones(raw: string | null | undefined): Tombstones {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Tombstones = {};
    for (const [id, at] of Object.entries(v)) if (typeof at === "number" && Number.isFinite(at)) out[id] = at;
    return out;
  } catch {
    return {};
  }
}

/** `t` plus `ids` deleted at `now`, without entries older than TOMBSTONE_MS, newest MAX_TOMBSTONES kept. */
export function addTombstones(t: Tombstones, ids: readonly string[], now: number): Tombstones {
  const all = Object.entries({ ...t, ...Object.fromEntries(ids.map((id) => [id, now])) })
    .filter(([, at]) => now - at < TOMBSTONE_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOMBSTONES);
  return Object.fromEntries(all);
}

/**
 * What this tab holds (`mine`) merged with what is stored (`stored`): every session of either (except deleted ones),
 * a session in both as the copy updated last (a tie keeps mine), in mine's order with sessions only stored placed
 * where they stood among the others, pinned first. `adopted` says whether the result has anything mine lacked
 * (a session or a newer copy from another tab), so the tab can show it.
 */
export function mergeForWrite<S extends { id: string; updatedAt: number; pinned?: boolean }>(mine: readonly S[], stored: readonly S[], deleted: Tombstones = {}): { list: S[]; adopted: boolean } {
  const gone = (s: S) => deleted[s.id] !== undefined;
  const byIdStored = new Map(stored.map((s) => [s.id, s]));
  let adopted = false;
  const out: S[] = [];
  for (const s of mine) {
    if (gone(s)) continue;
    const o = byIdStored.get(s.id);
    if (o && (o.updatedAt || 0) > (s.updatedAt || 0)) {
      out.push(o);
      adopted = true;
    } else out.push(s);
  }
  const mineIds = new Set(mine.map((s) => s.id));
  // Sessions only stored (another tab's): before the next stored session this tab has, else at the end.
  for (let i = 0; i < stored.length; i++) {
    const s = stored[i]!;
    if (mineIds.has(s.id) || gone(s)) continue;
    adopted = true;
    let at = out.length;
    for (let j = i + 1; j < stored.length; j++) {
      const k = out.findIndex((x) => x.id === stored[j]!.id);
      if (k >= 0) {
        at = k;
        break;
      }
    }
    out.splice(at, 0, s);
  }
  return { list: [...out.filter((s) => s.pinned), ...out.filter((s) => !s.pinned)], adopted };
}

/**
 * Writes `list` merged with what is stored now (mergeForWrite), pruned to fit; a full disk halves the budget and
 * tries again. Returns what was written (the merged list, and `adopted` when another tab's sessions came in), or null
 * when storage refused it.
 */
export function writeMerged(storage: StorageLike, scope: string, list: StoredSession[]): { list: StoredSession[]; json: string; adopted: boolean } | null {
  try {
    const stored = parseStored(storage.getItem(sessionsKey(scope))) ?? [];
    const deleted = parseTombstones(storage.getItem(deletedKey(scope)));
    const { list: merged, adopted } = mergeForWrite(list, stored, deleted);
    if (!merged.length) {
      storage.removeItem(sessionsKey(scope));
      return { list: [], json: "", adopted };
    }
    for (let budget = LOCAL_BUDGET; budget >= 50_000; budget = Math.floor(budget / 2)) {
      const { json } = pruneForStorage(merged, budget);
      try {
        storage.setItem(sessionsKey(scope), json);
        return { list: merged, json, adopted };
      } catch {
        // Over the browser's quota: try a smaller budget.
      }
    }
  } catch {
    // Blocked storage.
  }
  return null;
}

/** Records sessions deleted in this tab, so no tab's merge brings them back. */
export function markDeleted(storage: StorageLike, scope: string, ids: readonly string[], now = Date.now()): void {
  if (!ids.length) return;
  try {
    storage.setItem(deletedKey(scope), JSON.stringify(addTombstones(parseTombstones(storage.getItem(deletedKey(scope))), ids, now)));
  } catch {
    // Blocked storage.
  }
}

/** A list another tab wrote, as this tab should show it: the stored list (its order and copies), plus sessions only this tab has that were not deleted. */
export function mergeIncoming<S extends { id: string; updatedAt: number; pinned?: boolean }>(here: readonly S[], incoming: readonly S[], deleted: Tombstones): S[] {
  return mergeForWrite(incoming, here, deleted).list;
}

/** Pages alive now, by page id: when each last beat. */
export type LivePages = Record<string, number>;

export function parseLive(raw: string | null | undefined): LivePages {
  return parseTombstones(raw);
}

export function isLive(pages: LivePages, page: string | undefined, now: number): boolean {
  return !!page && typeof pages[page] === "number" && now - pages[page]! < LIVE_MS;
}

/** The heartbeat map with `page` beating at `now` (removed when not `alive`), stale pages dropped. */
export function beat(pages: LivePages, page: string, now: number, alive = true): LivePages {
  const out: LivePages = {};
  for (const [id, at] of Object.entries(pages)) if (id !== page && now - at < LIVE_MS) out[id] = at;
  if (alive) out[page] = now;
  return out;
}
