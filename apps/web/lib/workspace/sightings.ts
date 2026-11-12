"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SightingsFeed } from "@falcon/ripple";
import { parseFeed } from "./feed";

export type FeedStatus = "loading" | "ready" | "unavailable" | "error";

export type FeedState = {
  status: FeedStatus;
  feed: SightingsFeed | null;
  /** True when the feed shown is the development sample, not the API. */
  sample: boolean;
  /** When the feed was last loaded (ms). */
  loadedAt: number | null;
};

const REFRESH_MS = 5 * 60_000;

/**
 * In development the sample feed (lib/workspace/fixture.ts) stands in while
 * the API is missing or failing; `?sample=1` forces it and `?sample=0` turns
 * it off to see the real empty states. Never in production: the import sits
 * behind the NODE_ENV check and is dropped from the build.
 */
async function devSample(apiOk: boolean): Promise<SightingsFeed | null> {
  // Inline NODE_ENV (not a variable) so the production build drops the import.
  if (process.env.NODE_ENV === "development") {
    const flag = new URLSearchParams(window.location.search).get("sample");
    if (flag === "0" || (apiOk && flag !== "1")) return null;
    const { sampleFeed } = await import("./fixture");
    return sampleFeed();
  }
  return null;
}

/** GET /api/sightings?tickers=..., refreshed every few minutes and on focus. */
export function useSightings(
  tickers: readonly string[],
  opts: { getToken?: () => Promise<string | null>; enabled?: boolean } = {},
): FeedState & { refresh: () => void } {
  const { getToken, enabled = true } = opts;
  const [state, setState] = useState<FeedState>({ status: "loading", feed: null, sample: false, loadedAt: null });
  const key = [...tickers].sort().join(",");
  const seq = useRef(0);
  const lastLoad = useRef(0);
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;

  const load = useCallback(async () => {
    const run = ++seq.current;
    lastLoad.current = Date.now();
    const url = key ? `/api/sightings?tickers=${encodeURIComponent(key)}` : "/api/sightings";
    let next: FeedState;
    try {
      const token = (await tokenRef.current?.()) ?? null;
      const res = await fetch(url, {
        cache: "no-store",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (res.status === 404) {
        next = { status: "unavailable", feed: null, sample: false, loadedAt: Date.now() };
      } else if (!res.ok) {
        next = { status: "error", feed: null, sample: false, loadedAt: Date.now() };
      } else {
        const feed = parseFeed(await res.json().catch(() => null));
        next = feed
          ? { status: "ready", feed, sample: false, loadedAt: Date.now() }
          : { status: "error", feed: null, sample: false, loadedAt: Date.now() };
      }
    } catch {
      next = { status: "error", feed: null, sample: false, loadedAt: Date.now() };
    }
    const sample = await devSample(next.status === "ready").catch(() => null);
    if (sample) next = { status: "ready", feed: sample, sample: true, loadedAt: Date.now() };
    if (run === seq.current) setState(next);
  }, [key]);

  useEffect(() => {
    // Waits for the focus list, so the first request already carries it.
    if (!enabled) return;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    const onFocus = () => {
      if (document.visibilityState === "visible" && Date.now() - lastLoad.current > 60_000) void load();
    };
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, load]);

  return { ...state, refresh: () => void load() };
}
