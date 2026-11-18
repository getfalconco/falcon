"use client";

import { useEffect, useState } from "react";
import { fetchOptionsAll, type OptionsAll } from "../options-api";
import type { GraphAll, GraphNeighborhood } from "./graph";

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

/** The whole filing graph from GET /api/graph?all=1, fetched once per page load. */
let allGraph: Promise<GraphAll | null> | null = null;

function loadAll(): Promise<GraphAll | null> {
  allGraph ??= fetch("/api/graph?all=1")
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as Partial<GraphAll>;
      return Array.isArray(body.n) && Array.isArray(body.e) ? (body as GraphAll) : null;
    })
    .catch(() => null)
    .then((value) => {
      // A failure is retried the next time the Graph tab opens.
      if (!value) allGraph = null;
      return value;
    });
  return allGraph;
}

/** Every company and link (undefined while loading, null when unavailable). */
export function useWholeGraph(): GraphAll | null | undefined {
  const [data, setData] = useState<GraphAll | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadAll().then((value) => {
      if (live) setData(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return data;
}

/** The universe's options data from GET /api/options?all=1 (~150 KB), fetched once per page load. */
let allOptions: Promise<OptionsAll | null> | null = null;

function loadOptions(): Promise<OptionsAll | null> {
  allOptions ??= fetchOptionsAll().then((value) => {
    // Empty (no data yet, an error, or a viewer the server gives none): asked again the next time the Graph tab opens.
    if (!value.count) {
      allOptions = null;
      return null;
    }
    return value;
  });
  return allOptions;
}

/** Every ticker's compact options numbers; null while loading or when there are none. */
export function useOptionsAll(): OptionsAll | null {
  const [data, setData] = useState<OptionsAll | null>(null);
  useEffect(() => {
    let live = true;
    loadOptions().then((value) => {
      if (live) setData(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return data;
}
