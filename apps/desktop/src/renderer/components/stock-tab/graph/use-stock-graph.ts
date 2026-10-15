import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHeldTickers, useWatchlistTickers } from "@/components/calendar/use-calendar-data";
import { getAccessToken } from "@/lib/research-jobs";
import type { StockGraph } from "../../../../shared/stock-graph";

/**
 * The Stock tab's filing graph for one ticker (`stock:graph`), shared by the
 * Graph and the Chain news sections: both ask for the same ticker with the
 * same holdings, so one answer serves both, kept for five minutes.
 */

export type StockGraphState =
  | { status: "loading" }
  | { status: "ready"; graph: StockGraph }
  /** The bridge is missing or the read failed: the sections render nothing. */
  | { status: "unavailable" };

const FRESH_MS = 5 * 60_000;
const cache = new Map<string, { at: number; promise: Promise<StockGraph | null> }>();

function load(ticker: string, related: string[], force = false): Promise<StockGraph | null> {
  const key = `${ticker}|${related.join(",")}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < FRESH_MS) return hit.promise;
  const get = typeof window === "undefined" ? undefined : window.meridian?.getStockGraph;
  const promise =
    typeof get === "function"
      ? get(ticker, { related }).then(
          (res) => (res?.ok ? res.graph : null),
          () => null,
        )
      : Promise.resolve(null);
  cache.set(key, { at: Date.now(), promise });
  void promise.then((graph) => {
    if (graph === null) cache.delete(key);
  });
  return promise;
}

/** The reader's holdings and watchlist, deduplicated and sorted (the cache key depends on the order). */
export function useReaderTickers(): { held: string[]; watching: string[]; related: string[] } {
  const held = useHeldTickers();
  const watching = useWatchlistTickers();
  const related = useMemo(() => [...new Set([...held, ...watching])].sort(), [held, watching]);
  return { held, watching, related };
}

export function useStockGraph(ticker: string): StockGraphState & { reload: () => void } {
  const symbol = ticker.trim().toUpperCase();
  const { related } = useReaderTickers();
  const [state, setState] = useState<StockGraphState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const forceNext = useRef(false);

  useEffect(() => {
    let live = true;
    const force = forceNext.current;
    forceNext.current = false;
    setState((prev) => (prev.status === "ready" && prev.graph.ticker === symbol ? prev : { status: "loading" }));
    void load(symbol, related, force).then((graph) => {
      if (live) setState(graph ? { status: "ready", graph } : { status: "unavailable" });
    });
    return () => {
      live = false;
    };
  }, [symbol, related, nonce]);

  const reload = useCallback(() => {
    forceNext.current = true;
    setNonce((n) => n + 1);
  }, []);

  return { ...state, reload };
}

export type ResearchState = "idle" | "running" | "failed";

/**
 * "Research this company": starts the filing read (step1) for the ticker the
 * way the stock view does, waits for it, then calls `onDone` so the graph is
 * read again. Polls every three seconds, gives up after fifteen minutes.
 */
export function useResearchCompany(ticker: string, onDone: () => void): { state: ResearchState; start: () => void } {
  const [state, setState] = useState<ResearchState>("idle");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    setState("idle");
    return () => {
      alive.current = false;
    };
  }, [ticker]);

  const start = useCallback(() => {
    const api = window.meridian;
    if (!api?.startStep1Research || !api.getStep1ResearchStatus) {
      setState("failed");
      return;
    }
    setState("running");
    void (async () => {
      const token = await getAccessToken().catch(() => undefined);
      try {
        const started = await api.startStep1Research(ticker, { accessToken: token });
        if (!alive.current) return;
        if (!started.ok) return setState("failed");
        if (started.fromCache) {
          setState("idle");
          return onDone();
        }
        const deadline = Date.now() + 15 * 60_000;
        let misses = 0;
        while (alive.current && Date.now() < deadline) {
          await new Promise((r) => window.setTimeout(r, 3000));
          if (!alive.current) return;
          const status = await api.getStep1ResearchStatus(started.jobId, token);
          if (!status.ok) {
            if (++misses > 2) return setState("failed");
            continue;
          }
          misses = 0;
          if (status.error) return setState("failed");
          if (status.done) {
            // The graph file is rebuilt right after the job finishes; give it a moment.
            await new Promise((r) => window.setTimeout(r, 1500));
            if (!alive.current) return;
            setState("idle");
            return onDone();
          }
        }
        if (alive.current) setState("failed");
      } catch {
        if (alive.current) setState("failed");
      }
    })();
  }, [ticker, onDone]);

  return { state, start };
}
