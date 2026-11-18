"use client";

import { useEffect, useRef, useState } from "react";
import { fetchSpark } from "../portfolio-client";

/**
 * The Portfolio Overview's "Last 7 Days" lines by quote symbol, from
 * Falcon's own GET /api/portfolio/spark (the server asks Yahoo, so the
 * member's tickers never leave the browser for a third party). Read when the
 * symbol set changes, then every 10 minutes while the tab is visible: less
 * often than the 60 s price poll. In memory only.
 */

const REFRESH_MS = 10 * 60_000;

export function useSparks(symbols: readonly string[]): Record<string, number[]> {
  const [lines, setLines] = useState<Record<string, number[]>>({});
  const key = Array.from(new Set(symbols)).sort().join(",");
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const got = await fetchSpark(key.split(","), ctrl.signal);
      if (!ctrl.signal.aborted && keyRef.current === key) setLines((old) => ({ ...old, ...got }));
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!document.hidden) await load();
        schedule();
      }, REFRESH_MS);
    };
    void load();
    schedule();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [key]);

  return lines;
}
