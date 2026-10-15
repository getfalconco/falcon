/**
 * The News card's feed, shared and kept across mounts.
 *
 * One request serves every view of the card: Market, each Sector, Positions
 * and any search are filters over the same `news:feed` answer (the engine
 * sends the sectors with the stories), so the cache is keyed on the request
 * (`days` and `limit`), not on the view. Switching views or typing a search
 * never asks again; neither does a duplicate of the card.
 *
 * Freshness: three minutes. The engine polls every minute, but a headline
 * list that is three minutes old reads the same as a current one, and the
 * timer below keeps it within that while the app is open. A failure waits
 * thirty seconds before the next try, so a reader flicking between tabs while
 * the engine is down does not send a request per flick.
 */

import { useEffect, useSyncExternalStore } from "react";
import { createSwrResource, type SwrResource, type SwrState } from "@/lib/swr-resource";
import type { NewsFeedArticle, NewsFeedOptions } from "../../shared/news-feed";

export const NEWS_STALE_AFTER_MS = 3 * 60_000;
export const NEWS_RETRY_AFTER_MS = 30_000;
/** How long the feed keeps itself fresh after the card is gone (another tab, a stock). */
export const NEWS_KEEP_WARM_MS = 30 * 60_000;

/** What the card asks for: three days, up to 300 stories. */
export const NEWS_FEED_REQUEST: Required<NewsFeedOptions> = { days: 3, limit: 300 };

// This module is imported by node-side tests, where `window` does not exist.
function bridge(): Window["meridian"] {
  return typeof window === "undefined" ? undefined : window.meridian;
}

const resources = new Map<string, SwrResource<NewsFeedArticle[]>>();

export function newsFeedResource(request: Required<NewsFeedOptions> = NEWS_FEED_REQUEST): SwrResource<NewsFeedArticle[]> {
  const key = `${request.days}|${request.limit}`;
  let resource = resources.get(key);
  if (resource) return resource;
  resource = createSwrResource<NewsFeedArticle[]>({
    staleAfterMs: NEWS_STALE_AFTER_MS,
    retryAfterMs: NEWS_RETRY_AFTER_MS,
    keepWarmMs: NEWS_KEEP_WARM_MS,
    load: async () => {
      const get = bridge()?.getNewsFeed;
      if (typeof get !== "function") return { ok: false, error: "" };
      const res = await get({ ...request });
      if (res?.ok) return { ok: true, value: res.articles };
      return { ok: false, error: res?.error ?? "" };
    },
    seed: async () => {
      const peek = bridge()?.getCachedNewsFeed;
      if (typeof peek !== "function") return null;
      const res = await peek({ ...request });
      if (!res?.ok || !Array.isArray(res.articles)) return null;
      return { value: res.articles, fetchedAt: res.fetchedAt };
    },
  });
  resources.set(key, resource);
  return resource;
}

/** The feed, held for as long as the calling component is mounted. */
export function useNewsFeed(): SwrState<NewsFeedArticle[]> {
  const resource = newsFeedResource();
  const state = useSyncExternalStore(resource.subscribe, resource.getState, resource.getState);
  useEffect(() => resource.retain(), [resource]);
  return state;
}
