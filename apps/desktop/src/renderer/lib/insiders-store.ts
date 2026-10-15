/**
 * Insider activity answers, shared and kept across mounts: the dashboard
 * card and any other view asking the same thing share one answer. Main keeps
 * the EDGAR reads on disk and reads a company again at most every three
 * hours; the freshness here only bounds how long a list sits on screen
 * without being checked.
 *
 * Freshness: fifteen minutes. While main is still reading filings for some
 * of the companies (`pending`), the card asks again every twenty seconds so
 * the list fills in. A failure waits a minute before the next try.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createSwrResource, type SwrResource, type SwrState } from "@/lib/swr-resource";
import type { InsiderActivityAnswer, InsiderActivityRequest, InsiderActivityResult } from "../../shared/insider-types";

export const INSIDERS_STALE_AFTER_MS = 15 * 60_000;
export const INSIDERS_RETRY_AFTER_MS = 60_000;
export const INSIDERS_KEEP_WARM_MS = 30 * 60_000;
export const INSIDERS_PENDING_POLL_MS = 20_000;

/** Main's error codes, and "restart" for a bridge or main process without the channel. */
export type InsidersErrorCode = "restart" | "unavailable" | "invalid_request";

function bridge(): Window["meridian"] {
  return typeof window === "undefined" ? undefined : window.meridian;
}

function isMissingHandler(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /No handler registered/i.test(message);
}

/** One ask, with a main process older than this renderer read as "restart". */
export async function loadInsiders(
  ask: ((request?: InsiderActivityRequest) => Promise<InsiderActivityResult>) | undefined,
  request: InsiderActivityRequest,
): Promise<{ ok: true; value: InsiderActivityAnswer } | { ok: false; error: InsidersErrorCode }> {
  if (typeof ask !== "function") return { ok: false, error: "restart" };
  try {
    const res = await ask(request);
    if (res && res.ok === true) return { ok: true, value: { ...res, events: Array.isArray(res.events) ? res.events : [] } };
    return { ok: false, error: res && res.ok === false ? res.error : "unavailable" };
  } catch (err) {
    return { ok: false, error: isMissingHandler(err) ? "restart" : "unavailable" };
  }
}

const resources = new Map<string, SwrResource<InsiderActivityAnswer>>();

function keyOf(request: InsiderActivityRequest): string {
  if (typeof request === "string") return `focus:${request.toUpperCase()}`;
  const held = [...new Set(request.held ?? [])].sort();
  const watch = [...new Set(request.watchlist ?? [])].sort();
  return [request.ticker ?? "", held.join(","), watch.join(",")].join("|");
}

export function insidersResource(request: InsiderActivityRequest): SwrResource<InsiderActivityAnswer> {
  const key = keyOf(request);
  let resource = resources.get(key);
  if (resource) return resource;
  resource = createSwrResource<InsiderActivityAnswer>({
    staleAfterMs: INSIDERS_STALE_AFTER_MS,
    retryAfterMs: INSIDERS_RETRY_AFTER_MS,
    keepWarmMs: INSIDERS_KEEP_WARM_MS,
    load: () => loadInsiders(bridge()?.getInsiderActivity, request),
  });
  resources.set(key, resource);
  return resource;
}

/** For tests and the preview harness. */
export function resetInsidersResources(): void {
  for (const r of resources.values()) r.reset();
  resources.clear();
}

const noopSubscribe = () => () => {};

/**
 * Insider activity for a request: `{ held, watchlist }` for the reader's
 * names and their linked companies, or a ticker for one company. Null asks
 * nothing.
 */
export function useInsiderActivity(request: InsiderActivityRequest | null): SwrState<InsiderActivityAnswer> & { retry: () => void } {
  const key = request === null ? "" : keyOf(request);
  // Keyed on the request's contents, so a new object with the same names is the same resource.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resource = useMemo(() => (request === null ? null : insidersResource(request)), [key]);
  const idle = useMemo(() => ({ value: null, fetchedAt: null, error: null, loading: false, settled: true }) as SwrState<InsiderActivityAnswer>, []);
  const state = useSyncExternalStore(resource ? resource.subscribe : noopSubscribe, resource ? resource.getState : () => idle, resource ? resource.getState : () => idle);
  useEffect(() => (resource ? resource.retain() : undefined), [resource]);
  // Main is still reading: ask again shortly so the list fills in.
  const pending = state.value?.pending ?? 0;
  useEffect(() => {
    if (!resource || pending === 0 || state.loading) return;
    const timer = setTimeout(() => void resource.revalidate(), INSIDERS_PENDING_POLL_MS);
    return () => clearTimeout(timer);
  }, [resource, pending, state.fetchedAt, state.loading]);
  return { ...state, retry: () => void resource?.revalidate() };
}
