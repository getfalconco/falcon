import { useEffect, useState } from "react";
import type { ChangeTag, StockChanges, StockEarnings, StockPeers } from "../../../shared/stock-tab-data";

/**
 * The Changes, Earnings and Competitors sections' reads (main/stock-tab-data),
 * one answer per ticker kept for the run's next few minutes so switching
 * between recent stocks does not ask again. The main process keeps its own
 * day caches behind these; this only saves the IPC round trip and the flash.
 *
 * A section shows nothing while loading and nothing on a failure: these are
 * sections that disappear when they have nothing sourced to show.
 */

const KEEP_MS = 10 * 60_000;

type Entry<T> = { at: number; value: T | null };
const caches = new Map<string, Map<string, Entry<unknown>>>();
const pending = new Map<string, Promise<unknown>>();

function cacheFor(kind: string): Map<string, Entry<unknown>> {
  let c = caches.get(kind);
  if (!c) {
    c = new Map();
    caches.set(kind, c);
  }
  return c;
}

function read<T>(kind: string, key: string, load: () => Promise<T | null>): Promise<T | null> {
  const id = `${kind}:${key}`;
  const inFlight = pending.get(id) as Promise<T | null> | undefined;
  if (inFlight) return inFlight;
  const task = load()
    .catch(() => null)
    .then((value) => {
      // A failure is not kept: the next open asks again.
      if (value !== null) cacheFor(kind).set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => pending.delete(id));
  pending.set(id, task);
  return task;
}

function useResource<T>(kind: string, key: string | null, load: (key: string) => Promise<T | null>): T | null {
  const fresh = (): T | null => {
    if (!key) return null;
    const hit = cacheFor(kind).get(key);
    return hit && Date.now() - hit.at < KEEP_MS ? (hit.value as T | null) : null;
  };
  const [value, setValue] = useState<T | null>(fresh);
  useEffect(() => {
    if (!key) {
      setValue(null);
      return;
    }
    const hit = fresh();
    setValue(hit);
    if (hit !== null) return;
    let live = true;
    void read(kind, key, () => load(key)).then((v) => {
      if (live) setValue(v);
    });
    return () => {
      live = false;
    };
    // `load` is a fixed reader per kind; the key is what changes.
  }, [kind, key]);
  return value;
}

function api() {
  return typeof window === "undefined" ? undefined : window.meridian;
}

export function useStockChanges(ticker: string): StockChanges | null {
  return useResource("changes", ticker, async (t) => {
    const r = await api()?.getStockTabChanges?.(t);
    return r && r.ok ? r.changes : null;
  });
}

/**
 * The thesis tags for the ticker's changes, asked for only when there is a
 * thesis and something to tag. Keyed by the thesis text and the items, so an
 * edited thesis asks again (main keeps the answer by the same).
 */
export function useChangeTags(ticker: string, thesis: string | null, changes: StockChanges | null): Map<string, ChangeTag> | null {
  const text = thesis?.trim() || null;
  const key = text && changes && changes.items.length > 0 ? `${ticker}\u0000${changes.itemsHash}\u0000${text}` : null;
  const tags = useResource("tags", key, async () => {
    const r = await api()?.getStockTabChangeTags?.(ticker);
    return r && r.ok ? r.tags : null;
  });
  if (!key || !tags) return null;
  return new Map(tags.map((t) => [t.id, t] as const));
}

export function useStockEarnings(ticker: string): StockEarnings | null {
  return useResource("earnings", ticker, async (t) => {
    const r = await api()?.getStockTabEarnings?.(t);
    return r && r.ok ? r.earnings : null;
  });
}

export function useStockPeers(ticker: string): StockPeers | null {
  return useResource("peers", ticker, async (t) => {
    const r = await api()?.getStockTabPeers?.(t);
    return r && r.ok ? r.peers : null;
  });
}
