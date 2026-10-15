import { useEffect, useState } from "react";
import { getStockOverview, type StockOverviewData } from "@/lib/stock-api";

/**
 * The market data provider's overview of one company (profile, the day's
 * stats, valuation), shared by the Stock tab's header and its Financials
 * section so opening a stock asks for it once. Kept for a few minutes; a
 * failed read is not kept.
 */

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; read: Promise<StockOverviewData> }>();

function readOverview(symbol: string): Promise<StockOverviewData> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.read;
  const read = getStockOverview(symbol, "1D");
  const entry = { at: Date.now(), read };
  cache.set(symbol, entry);
  read.catch(() => {
    if (cache.get(symbol) === entry) cache.delete(symbol);
  });
  return read;
}

export type OverviewState = { data: StockOverviewData | null; loading: boolean; failed: boolean };

export function useStockOverview(ticker: string): OverviewState {
  const symbol = ticker.trim().toUpperCase();
  const [state, setState] = useState<OverviewState>({ data: null, loading: true, failed: false });
  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    setState({ data: null, loading: true, failed: false });
    readOverview(symbol).then(
      (data) => {
        if (!cancelled) setState({ data, loading: false, failed: false });
      },
      () => {
        if (!cancelled) setState({ data: null, loading: false, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [symbol]);
  return state;
}
