import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { paperScopeKey } from "@/lib/paper-account";
import { createThesisCache, type ThesisBridge } from "./thesis-cache";

/**
 * The reader's thesis for a stock: why they hold or watch it, in their own
 * words. Every Stock tab section may read it (the "last 7 days" changes are
 * tagged against it, for example). Kept by the main process per account and
 * per ticker (`stock:thesis:get` / `stock:thesis:set`, main/stock-tab); read
 * once per ticker into one renderer-wide cache (thesis-cache.ts), so a save
 * from the Thesis section reaches every other section reading that ticker.
 * Keep the hook's shape stable.
 */
export type ThesisState = {
  /** The saved thesis, or null when the reader has written none. */
  text: string | null;
  /** True until the first read for this ticker has finished. */
  loading: boolean;
  /** Saves (or clears, with an empty string) the thesis for this ticker. Rejects when it was not kept. */
  save: (text: string) => Promise<void>;
};

function bridge(): ThesisBridge | null {
  const api = typeof window === "undefined" ? undefined : window.meridian;
  if (!api?.getStockThesis || !api.setStockThesis) return null;
  return { get: api.getStockThesis, set: api.setStockThesis };
}

/** Whose theses are cached: the signed-in account, as the paper account names it. */
const cache = createThesisCache(bridge, () => paperScopeKey(""));

export function useThesis(ticker: string): ThesisState {
  const symbol = ticker.trim().toUpperCase();
  const snap = useSyncExternalStore(
    cache.subscribe,
    () => cache.snapshot(symbol),
    () => cache.snapshot(symbol),
  );
  // Read on first sight of the ticker (a failed read is asked again on the
  // next visit), and again when the account changed under the cache.
  useEffect(() => {
    if (symbol) void cache.ensure(symbol);
  }, [symbol]);
  const waiting = snap.loading;
  useEffect(() => {
    if (symbol && waiting) void cache.ensure(symbol);
  }, [symbol, waiting]);
  const save = useCallback((text: string) => cache.save(symbol, text), [symbol]);
  return useMemo(() => ({ text: snap.text, loading: snap.loading, save }), [snap, save]);
}
