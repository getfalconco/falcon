/**
 * The read-through radar's answers, shared and kept across mounts: the
 * dashboard card, the Earnings tab's section and a focused read (the Stock
 * tab) asking the same thing share one answer. Main keeps the provider reads
 * for the New York day and whole answers ten minutes; the freshness here
 * only bounds how long a list can sit on screen without being checked.
 *
 * Freshness: fifteen minutes. A failure waits a minute before the next try.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createSwrResource, type SwrResource, type SwrState } from "@/lib/swr-resource";
import { subscribeDemoMode } from "@/lib/demo-mode";
import { readPaperAccount, subscribePaperAccount } from "@/lib/paper-account";
import type { ReadthroughHolding, ReadthroughRequest, ReadthroughResult } from "../../shared/readthrough-types";

export const READTHROUGH_STALE_AFTER_MS = 15 * 60_000;
export const READTHROUGH_RETRY_AFTER_MS = 60_000;
export const READTHROUGH_KEEP_WARM_MS = 30 * 60_000;

export type ReadthroughAnswer = Extract<ReadthroughResult, { ok: true }>;
/** Main's error codes, and "restart" for a bridge or main process without the channel. */
export type ReadthroughErrorCode = "restart" | "unavailable" | "invalid_request";

// Imported by node-side tests, where `window` does not exist.
function bridge(): Window["meridian"] {
  return typeof window === "undefined" ? undefined : window.meridian;
}

function isMissingHandler(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /No handler registered/i.test(message);
}

/** One ask, with a main process older than this renderer read as "restart". */
export async function loadReadthrough(
  ask: ((request: ReadthroughRequest) => Promise<ReadthroughResult>) | undefined,
  request: ReadthroughRequest,
): Promise<{ ok: true; value: ReadthroughAnswer } | { ok: false; error: ReadthroughErrorCode }> {
  if (typeof ask !== "function") return { ok: false, error: "restart" };
  try {
    const res = await ask(request);
    if (res && res.ok === true) return { ok: true, value: { ...res, rows: Array.isArray(res.rows) ? res.rows : [], degraded: res.degraded ?? [] } };
    return { ok: false, error: res && res.ok === false ? res.error : "unavailable" };
  } catch (err) {
    return { ok: false, error: isMissingHandler(err) ? "restart" : "unavailable" };
  }
}

const resources = new Map<string, SwrResource<ReadthroughAnswer>>();

function keyOf(request: ReadthroughRequest): string {
  const held = (request.held ?? []).map((h) => (typeof h === "string" ? h : `${h.ticker}:${h.shares ?? ""}`)).sort();
  const watch = [...new Set(request.watchlist ?? [])].sort();
  return [request.focus ?? "", held.join(","), watch.join(",")].join("|");
}

export function readthroughResource(request: ReadthroughRequest): SwrResource<ReadthroughAnswer> {
  const key = keyOf(request);
  let resource = resources.get(key);
  if (resource) return resource;
  resource = createSwrResource<ReadthroughAnswer>({
    staleAfterMs: READTHROUGH_STALE_AFTER_MS,
    retryAfterMs: READTHROUGH_RETRY_AFTER_MS,
    keepWarmMs: READTHROUGH_KEEP_WARM_MS,
    load: () => loadReadthrough(bridge()?.getReadthroughRadar, request),
  });
  resources.set(key, resource);
  return resource;
}

/** For tests and the preview harness. */
export function resetReadthroughResources(): void {
  for (const r of resources.values()) r.reset();
  resources.clear();
}

function useResource(request: ReadthroughRequest | null): SwrState<ReadthroughAnswer> & { retry: () => void } {
  const key = request ? keyOf(request) : "";
  // Keyed on the request's contents, so a new object with the same names is the same resource.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resource = useMemo(() => (request ? readthroughResource(request) : null), [key]);
  const idle = useMemo(() => ({ value: null, fetchedAt: null, error: null, loading: false, settled: true }) as SwrState<ReadthroughAnswer>, []);
  const state = useSyncExternalStore(resource ? resource.subscribe : noopSubscribe, resource ? resource.getState : () => idle, resource ? resource.getState : () => idle);
  useEffect(() => (resource ? resource.retain() : undefined), [resource]);
  return { ...state, retry: () => void resource?.revalidate() };
}

const noopSubscribe = () => () => {};

function readHeld(): ReadthroughHolding[] {
  return Object.values(readPaperAccount().positions)
    .filter((p) => p && Number.isFinite(p.shares) && p.shares !== 0)
    .map((p) => ({ ticker: p.symbol.toUpperCase(), shares: Math.abs(p.shares) }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

function sameHeld(a: readonly ReadthroughHolding[], b: readonly ReadthroughHolding[]): boolean {
  return a.length === b.length && a.every((x, i) => x.ticker === b[i]!.ticker && x.shares === b[i]!.shares);
}

/** The open positions with their share counts (the demo book while demo mode is on). */
export function useHeldPositions(): ReadthroughHolding[] {
  const [held, setHeld] = useState<ReadthroughHolding[]>(readHeld);
  useEffect(() => {
    const update = () => setHeld((prev) => {
      const next = readHeld();
      return sameHeld(prev, next) ? prev : next;
    });
    update();
    const offAccount = subscribePaperAccount(update);
    const offDemo = subscribeDemoMode(update);
    return () => {
      offAccount();
      offDemo();
    };
  }, []);
  return held;
}

/** The radar for the reader's positions and watchlist. */
export function useReadthroughRadar(held: readonly ReadthroughHolding[], watchlist: readonly string[]) {
  const request = held.length === 0 && watchlist.length === 0 ? null : { held: [...held], watchlist: [...watchlist] };
  return useResource(request);
}

/**
 * Every filing link of one name, measured, whatever the report dates. For
 * the Stock tab: `useReadthroughFocus("NVDA", held, watchlist)`; the rows
 * carry the same figures as the radar's (shared/readthrough-types.ts).
 */
export function useReadthroughFocus(ticker: string | null, held: readonly ReadthroughHolding[] = [], watchlist: readonly string[] = []) {
  const request = ticker ? { focus: ticker, held: [...held], watchlist: [...watchlist] } : null;
  return useResource(request);
}

// ---------------------------------------------------------------------------
// "Open the radar": the dashboard card's arrow asks the Earnings tab's section to come into view
// ---------------------------------------------------------------------------

const viewListeners = new Set<() => void>();
let pendingView = false;

/** Asks the Earnings tab's Read-through section to open and scroll into view (now, or when it mounts). */
export function requestReadthroughView(): void {
  if (viewListeners.size === 0) {
    pendingView = true;
    return;
  }
  for (const l of viewListeners) l();
}

/** The section's side: called on each request, and once at once for a request made before it mounted. */
export function onReadthroughViewRequest(listener: () => void): () => void {
  viewListeners.add(listener);
  if (pendingView) {
    pendingView = false;
    listener();
  }
  return () => {
    viewListeners.delete(listener);
  };
}
