/**
 * Filing changes, shared and kept across mounts: the dashboard card and the
 * Stock tab section each read one answer per request. Main reads EDGAR at
 * most once a New York day per company and keeps what it read on disk; the
 * freshness here only bounds how long a list sits on screen unchecked.
 *
 * Freshness: thirty minutes for one company, fifteen for the overview. While
 * the overview says names are still being read, it asks again every twenty
 * seconds until they are done.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createSwrResource, type SwrResource, type SwrState } from "@/lib/swr-resource";
import { useShownPoll } from "@/lib/use-shown-poll";
import type { FilingChanges, FilingChangesResult, FilingOverviewRequest, FilingOverviewResult } from "../../shared/filing-changes";

export const FILINGS_STALE_AFTER_MS = 30 * 60_000;
export const FILINGS_OVERVIEW_STALE_AFTER_MS = 15 * 60_000;
export const FILINGS_RETRY_AFTER_MS = 60_000;
export const FILINGS_KEEP_WARM_MS = 30 * 60_000;
export const FILINGS_PENDING_POLL_MS = 20_000;

export type FilingOverview = Extract<FilingOverviewResult, { ok: true }>;
/** Main's error codes, and "restart" for a bridge or main process without the channel. */
export type FilingsErrorCode = "restart" | "unavailable" | "invalid_request";

// Imported by node-side tests, where `window` does not exist.
function bridge(): Window["meridian"] {
  return typeof window === "undefined" ? undefined : window.meridian;
}

function isMissingHandler(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /No handler registered/i.test(message);
}

/** One ask for one company, with a main process older than this renderer read as "restart". */
export async function loadFilingChanges(
  ask: ((ticker: string) => Promise<FilingChangesResult>) | undefined,
  ticker: string,
): Promise<{ ok: true; value: FilingChanges } | { ok: false; error: FilingsErrorCode }> {
  if (typeof ask !== "function") return { ok: false, error: "restart" };
  try {
    const res = await ask(ticker);
    if (res && res.ok === true && res.changes && Array.isArray(res.changes.items)) return { ok: true, value: res.changes };
    return { ok: false, error: res && res.ok === false ? res.error : "unavailable" };
  } catch (err) {
    return { ok: false, error: isMissingHandler(err) ? "restart" : "unavailable" };
  }
}

/** One ask for the overview. */
export async function loadFilingOverview(
  ask: ((request: FilingOverviewRequest) => Promise<FilingOverviewResult>) | undefined,
  request: FilingOverviewRequest,
): Promise<{ ok: true; value: FilingOverview } | { ok: false; error: FilingsErrorCode }> {
  if (typeof ask !== "function") return { ok: false, error: "restart" };
  try {
    const res = await ask(request);
    if (res && res.ok === true) return { ok: true, value: { ...res, rows: Array.isArray(res.rows) ? res.rows : [], pending: res.pending ?? [] } };
    return { ok: false, error: res && res.ok === false ? res.error : "unavailable" };
  } catch (err) {
    return { ok: false, error: isMissingHandler(err) ? "restart" : "unavailable" };
  }
}

const changeResources = new Map<string, SwrResource<FilingChanges>>();
const overviewResources = new Map<string, SwrResource<FilingOverview>>();

export function filingChangesResource(ticker: string): SwrResource<FilingChanges> {
  const key = ticker.toUpperCase();
  let resource = changeResources.get(key);
  if (resource) return resource;
  resource = createSwrResource<FilingChanges>({
    staleAfterMs: FILINGS_STALE_AFTER_MS,
    retryAfterMs: FILINGS_RETRY_AFTER_MS,
    keepWarmMs: FILINGS_KEEP_WARM_MS,
    load: () => loadFilingChanges(bridge()?.getFilingChanges, key),
  });
  changeResources.set(key, resource);
  return resource;
}

function overviewKey(request: FilingOverviewRequest): string {
  return `${[...request.held].sort().join(",")}|${[...request.watchlist].sort().join(",")}`;
}

export function filingOverviewResource(request: FilingOverviewRequest): SwrResource<FilingOverview> {
  const key = overviewKey(request);
  let resource = overviewResources.get(key);
  if (resource) return resource;
  resource = createSwrResource<FilingOverview>({
    staleAfterMs: FILINGS_OVERVIEW_STALE_AFTER_MS,
    retryAfterMs: FILINGS_RETRY_AFTER_MS,
    keepWarmMs: FILINGS_KEEP_WARM_MS,
    load: () => loadFilingOverview(bridge()?.getFilingOverview, request),
  });
  overviewResources.set(key, resource);
  return resource;
}

/** For tests and the preview harness. */
export function resetFilingResources(): void {
  for (const r of changeResources.values()) r.reset();
  for (const r of overviewResources.values()) r.reset();
  changeResources.clear();
  overviewResources.clear();
}

const noopSubscribe = () => () => {};

function useResource<V>(resource: SwrResource<V> | null): SwrState<V> & { retry: () => void } {
  const idle = useMemo(() => ({ value: null, fetchedAt: null, error: null, loading: false, settled: true }) as SwrState<V>, []);
  const state = useSyncExternalStore(resource ? resource.subscribe : noopSubscribe, resource ? resource.getState : () => idle, resource ? resource.getState : () => idle);
  useEffect(() => (resource ? resource.retain() : undefined), [resource]);
  return { ...state, retry: () => void resource?.revalidate() };
}

/** One company's filing changes (the Stock tab). */
export function useFilingChanges(ticker: string | null) {
  const key = ticker ? ticker.toUpperCase() : "";
  const resource = useMemo(() => (key ? filingChangesResource(key) : null), [key]);
  return useResource(resource);
}

/** The notable changes across the reader's names (the dashboard card). */
export function useFilingOverview(held: readonly string[], watchlist: readonly string[]) {
  const request = held.length === 0 && watchlist.length === 0 ? null : { held: [...held], watchlist: [...watchlist] };
  const key = request ? overviewKey(request) : "";
  // Keyed on the request's contents, so a new array with the same names is the same resource.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resource = useMemo(() => (request ? filingOverviewResource(request) : null), [key]);
  const state = useResource(resource);
  const pending = state.value?.pending.length ?? 0;
  // Names still being read in main: ask again shortly, until none are left; not while the card is out of sight.
  useShownPoll(resource && pending > 0 ? key : "", () => void resource?.revalidate(), FILINGS_PENDING_POLL_MS, { immediate: false });
  return state;
}

// ---------------------------------------------------------------------------
// "Open the filing changes": the dashboard card asks the Stock tab's section to come into view
// ---------------------------------------------------------------------------

const viewListeners = new Set<(ticker: string) => boolean>();
let pendingView: string | null = null;

/**
 * Asks the Stock tab's Filing changes section for `ticker` to scroll into
 * view: now when it is on screen, else when it mounts. The tab may still show
 * another stock when this is called, so the request names its ticker.
 */
export function requestFilingChangesView(ticker: string): void {
  const t = ticker.toUpperCase();
  pendingView = t;
  for (const l of viewListeners) if (l(t)) pendingView = null;
}

/** The section's side: `listener` answers true when the request was for its ticker. */
export function onFilingChangesViewRequest(listener: (ticker: string) => boolean): () => void {
  viewListeners.add(listener);
  if (pendingView && listener(pendingView)) pendingView = null;
  return () => {
    viewListeners.delete(listener);
  };
}
