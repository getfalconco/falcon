import { useEffect, useState } from "react";
import { getLiveQuote, getStockQuote } from "@/lib/stock-api";

/**
 * One price source for every surface that values the book.
 *
 * Extended-hours aware: outside 09:30–16:00 the last pre/post print is what a
 * position is actually worth, and it is what trades execute at. Anything that
 * prices the same holdings off a different quote invents P&L — a headline and
 * a holdings card disagreeing by the close-to-after-hours gap looks exactly
 * like a broken feed. Fetch here, once, and share it.
 *
 * Polled every 5s so the portfolio value and its chart actually move while the
 * app is open. That is one upstream request per held symbol per tick — the
 * main-process quote cache (1.5s TTL + inflight dedupe) collapses the several
 * surfaces asking for the same symbol, but a large book still means real
 * traffic; a 429 leaves the last good price on screen rather than clearing it.
 *
 * @param symbolsKey comma-joined, sorted symbols — a stable effect dependency.
 */
export function useLivePrices(symbolsKey: string): Record<string, number> {
  const [prices, setPrices] = useState<Record<string, number>>({});

  useEffect(() => {
    const list = symbolsKey ? symbolsKey.split(",").filter(Boolean) : [];
    if (list.length === 0) {
      setPrices({});
      return;
    }
    let cancelled = false;

    const priceOf = async (s: string): Promise<readonly [string, number] | null> => {
      try {
        const live = await getLiveQuote(s);
        if (live.ok && Number.isFinite(live.quote.price) && live.quote.price > 0) {
          return [s, live.quote.price] as const;
        }
      } catch {
        /* fall through to the regular-session quote */
      }
      try {
        const q = await getStockQuote(s);
        return [s, q.price] as const;
      } catch {
        return null;
      }
    };

    const load = () => {
      void Promise.all(list.map(priceOf)).then((entries) => {
        if (cancelled) return;
        setPrices((prev) => {
          // Merge, never replace. Rebuilding the map from scratch dropped any
          // symbol that missed a tick, and every consumer reads a missing
          // symbol as 'value it at cost' — so one failed request turned a
          // position into its purchase price and the portfolio total jumped
          // to a number it had never been worth. Keeping the last good print
          // is what the note above always claimed this did.
          const next: Record<string, number> = {};
          // Held symbols only: a sold position must not keep a stale price.
          for (const symbol of list) {
            if (prev[symbol] != null) next[symbol] = prev[symbol];
          }
          for (const e of entries) {
            if (e && Number.isFinite(e[1]) && e[1] > 0) next[e[0]] = e[1];
          }
          return next;
        });
      });
    };

    load();
    const id = window.setInterval(load, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [symbolsKey]);

  return prices;
}
