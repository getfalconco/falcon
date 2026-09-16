import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Which dashboard modules the reader has thrown away.
 *
 * The dashboard is a stack of modules rather than one fixed page, so a reader
 * who does not hold a book has no use for the assets card and one who does not
 * follow the network has no use for Insight. Deletions are per-device and
 * remembered across launches; nothing about it reaches Supabase, because it is
 * a layout preference, not an account fact.
 */

export type ModuleId = "insight" | "holdings";

const KEY = "falcon.dashboard.hiddenModules";

/** Everything that changed since the last read, told to every mounted hook. */
const listeners = new Set<(hidden: ModuleId[]) => void>();
let cache: ModuleId[] | null = null;

function isModuleId(value: unknown): value is ModuleId {
  return value === "insight" || value === "holdings";
}

async function read(): Promise<ModuleId[]> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? parsed.filter(isModuleId) : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function write(next: ModuleId[]): Promise<void> {
  cache = next;
  for (const listener of listeners) listener(next);
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // The screen already reflects it; a failed write only costs the memory of
    // it at the next launch.
  }
}

export function useDashboardModules(): {
  hidden: ModuleId[];
  ready: boolean;
  hide: (id: ModuleId) => void;
  restoreAll: () => void;
} {
  const [hidden, setHidden] = useState<ModuleId[]>(cache ?? []);
  const [ready, setReady] = useState(cache != null);

  useEffect(() => {
    let cancelled = false;
    void read().then((next) => {
      if (cancelled) return;
      setHidden(next);
      setReady(true);
    });
    listeners.add(setHidden);
    return () => {
      cancelled = true;
      listeners.delete(setHidden);
    };
  }, []);

  const hide = useCallback((id: ModuleId) => {
    void read().then((current) =>
      current.includes(id) ? undefined : write([...current, id]),
    );
  }, []);

  const restoreAll = useCallback(() => {
    void write([]);
  }, []);

  return { hidden, ready, hide, restoreAll };
}
