import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { FUNNEL_TEST_MODE } from "./env";
import type { PickedStock, SectorId } from "./onboarding";

/**
 * The member's portfolio as the app knows it: the holdings connected or added
 * in the welcome funnel, plus the sectors they follow (Opportunities lean on
 * them). Kept on the device; in funnel test mode only in memory, so a restart
 * starts clean like the rest of the test run.
 */

export type Holdings = {
  stocks: PickedStock[];
  sectors: SectorId[];
  /** ISO time the funnel handed them over. */
  savedAt: string;
  /** The Supabase user they belong to, when one was signed in. */
  userId?: string;
};

const STORAGE_KEY = "falcon.holdings.v1";

/** undefined until the saved copy has been read, null when there is none. */
let current: Holdings | null | undefined = FUNNEL_TEST_MODE ? null : undefined;
let loading: Promise<Holdings | null> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function isHoldings(value: unknown): value is Holdings {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<Holdings>;
  return Array.isArray(v.stocks) && Array.isArray(v.sectors);
}

/** Reads the saved holdings once (null when there are none). */
export function loadHoldings(): Promise<Holdings | null> {
  if (current !== undefined) return Promise.resolve(current);
  if (!loading) {
    loading = AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        return isHoldings(parsed) ? parsed : null;
      })
      .catch(() => null)
      .then((saved) => {
        // A save that landed while this read was in flight wins.
        if (current === undefined) current = saved;
        emit();
        return current ?? null;
      });
  }
  return loading;
}

export function saveHoldings(stocks: PickedStock[], sectors: SectorId[], userId?: string | null): void {
  current = {
    stocks: stocks.map(({ ticker, name }) => ({ ticker: ticker.toUpperCase(), name })),
    sectors: [...sectors],
    savedAt: new Date().toISOString(),
    ...(userId ? { userId } : {}),
  };
  emit();
  if (!FUNNEL_TEST_MODE) void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(current)).catch(() => {});
}

export function clearHoldings(): void {
  current = null;
  emit();
  if (!FUNNEL_TEST_MODE) void AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The holdings; undefined while the saved copy is still being read. */
export function useHoldings(): Holdings | null | undefined {
  if (current === undefined) void loadHoldings();
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}

/** Upper-case tickers the member holds. */
export function heldTickers(holdings: Holdings | null | undefined): Set<string> {
  return new Set((holdings?.stocks ?? []).map((s) => s.ticker.toUpperCase()));
}
