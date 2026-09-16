import { useEffect, useRef, useState } from "react";
import { getLiveQuote } from "@/lib/stock-api";
import type { LiveQuote } from "../../shared/stock-types";

export type LiveQuoteState = {
  quote: LiveQuote | null;
  /** Direction of the most recent price change — drives the tick flash. */
  tick: "up" | "down" | null;
  error: string | null;
  loading: boolean;
};

const DEFAULT_INTERVAL_MS = 2_000;
/** Outside trading hours the price is frozen — poll just often enough to notice the open. */
const CLOSED_INTERVAL_MS = 30_000;
/** Consecutive-failure backoff so a flaky upstream isn't hammered. */
const MAX_INTERVAL_MS = 60_000;

/**
 * Polls the latest traded price for `symbol`. Polling pauses while the window
 * is hidden and resumes with an immediate refresh, so a backgrounded app
 * doesn't keep hitting the market-data provider. Pass `enabled: false` to stop
 * polling while the price isn't on screen.
 */
export function useLiveQuote(
  symbol: string,
  options: { intervalMs?: number; enabled?: boolean } = {},
): LiveQuoteState {
  const { intervalMs = DEFAULT_INTERVAL_MS, enabled = true } = options;
  const [state, setState] = useState<LiveQuoteState>({
    quote: null,
    tick: null,
    error: null,
    loading: true,
  });
  const lastPrice = useRef<number | null>(null);

  // A new ticker starts from scratch — never show the previous symbol's price.
  useEffect(() => {
    lastPrice.current = null;
    setState({ quote: null, tick: null, error: null, loading: true });
  }, [symbol]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: number | null = null;
    let failures = 0;
    let marketClosed = false;

    const clear = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = () => {
      clear();
      if (cancelled || document.hidden) return;
      // Nothing ticks outside trading hours — back off to a slow heartbeat.
      const base = marketClosed ? Math.max(intervalMs, CLOSED_INTERVAL_MS) : intervalMs;
      timer = window.setTimeout(() => void poll(), Math.min(base * 2 ** failures, MAX_INTERVAL_MS));
    };

    const poll = async () => {
      if (cancelled) return;
      const res = await getLiveQuote(symbol);
      if (cancelled) return;

      if (res.ok) {
        failures = 0;
        marketClosed = res.quote.session === "closed";
        const previous = lastPrice.current;
        const tick =
          previous == null || previous === res.quote.price
            ? null
            : res.quote.price > previous
              ? ("up" as const)
              : ("down" as const);
        lastPrice.current = res.quote.price;
        setState({ quote: res.quote, tick, error: null, loading: false });
      } else {
        failures += 1;
        // Keep the last good price visible; surface the error only if we never
        // got one.
        setState((prev) => ({
          quote: prev.quote,
          tick: null,
          error: prev.quote ? null : res.error,
          loading: false,
        }));
      }

      schedule();
    };

    const onVisibility = () => {
      if (document.hidden) {
        clear();
      } else {
        void poll();
      }
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [symbol, intervalMs, enabled]);

  return state;
}
