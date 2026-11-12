"use client";

import { useEffect, useState } from "react";
import type { GraphNeighborhood } from "./graph";

/**
 * The engine's seed graph around `tickers`, from GET /api/graph. Null while
 * loading, when the route or its data is not there (404), or on any error:
 * the Workspace then draws from the Sightings feed alone.
 */
export function useGraphNeighborhood(tickers: readonly string[], depth = 2): GraphNeighborhood | null {
  const [data, setData] = useState<GraphNeighborhood | null>(null);
  const key = [...tickers].sort().join(",");

  useEffect(() => {
    if (!key) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/graph?tickers=${encodeURIComponent(key)}&depth=${depth}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return null;
        const body = (await res.json()) as Partial<GraphNeighborhood>;
        return Array.isArray(body.nodes) && Array.isArray(body.edges) ? (body as GraphNeighborhood) : null;
      })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setData(null);
      });
    return () => controller.abort();
  }, [key, depth]);

  return data;
}
