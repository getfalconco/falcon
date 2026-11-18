"use client";

import { useCallback, useSyncExternalStore } from "react";
import { applyMemoryEvents, cleanMemory, memoryEventsFromStream, type MemoryItem } from "@/lib/desk/memory";

/**
 * Falcon AI memory in this browser (localStorage `falcon.desk.memory.v1:<scope>`,
 * lib/desk/memory.ts), shared by every session of the workspace: sent with each
 * chat request, changed by the remember/forget tools (applied from the reply
 * stream) and by the Memory view. Other tabs follow through the storage event.
 */

const PREFIX = "falcon.desk.memory.v1";
const EMPTY: MemoryItem[] = [];
const cache = new Map<string, MemoryItem[]>();
const listeners = new Map<string, Set<() => void>>();
/** Tool calls already applied (a reply stream is re-read on every chunk and on resume). */
const applied = new Set<string>();
let watching = false;

const key = (scope: string) => `${PREFIX}:${scope}`;

function read(scope: string): MemoryItem[] {
  try {
    const raw = window.localStorage.getItem(key(scope));
    return raw ? cleanMemory(JSON.parse(raw)) : EMPTY;
  } catch {
    return EMPTY;
  }
}

function watch() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener("storage", (e) => {
    if (!e.key?.startsWith(`${PREFIX}:`)) return;
    const scope = e.key.slice(PREFIX.length + 1);
    if (!cache.has(scope)) return;
    cache.set(scope, read(scope));
    listeners.get(scope)?.forEach((l) => l());
  });
}

function get(scope: string): MemoryItem[] {
  let list = cache.get(scope);
  if (!list) {
    list = typeof window === "undefined" ? EMPTY : read(scope);
    cache.set(scope, list);
    watch();
  }
  return list;
}

function put(scope: string, list: MemoryItem[]) {
  cache.set(scope, list);
  try {
    if (list.length) window.localStorage.setItem(key(scope), JSON.stringify(list));
    else window.localStorage.removeItem(key(scope));
  } catch {
    // Blocked storage: the list lasts for this page visit.
  }
  listeners.get(scope)?.forEach((l) => l());
}

/** What goes with a chat request: `[{ id, text }]`. */
export function memoryForRequest(scope: string): { id: string; text: string }[] {
  return get(scope).map(({ id, text }) => ({ id, text }));
}

/** Applies the remember/forget changes in a reply stream (each tool call once). */
export function applyMemoryFromStream(scope: string, raw: string): void {
  const fresh = memoryEventsFromStream(raw).filter((e) => !applied.has(e.toolId));
  if (!fresh.length) return;
  fresh.forEach((e) => applied.add(e.toolId));
  put(scope, applyMemoryEvents(get(scope), fresh.map((e) => e.event)));
}

export function forgetMemory(scope: string, id: string): void {
  put(
    scope,
    get(scope).filter((m) => m.id !== id),
  );
}

export function clearMemory(scope: string): void {
  put(scope, []);
}

export function useDeskMemory(scope: string): MemoryItem[] {
  const subscribe = useCallback(
    (l: () => void) => {
      let set = listeners.get(scope);
      if (!set) listeners.set(scope, (set = new Set()));
      set.add(l);
      return () => {
        set.delete(l);
      };
    },
    [scope],
  );
  return useSyncExternalStore(
    subscribe,
    () => get(scope),
    () => EMPTY,
  );
}
