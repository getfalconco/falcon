/**
 * The Earnings tab's and card's answers, shared and kept across mounts.
 *
 * One resource per request (scope, days, and the reader's names, which mark
 * the rows): the tab, the card and a duplicate of the card asking the same
 * thing share one answer, and switching tabs draws at once from what was
 * already read. Main keeps the provider reads on disk for hours besides, so
 * an ask here is cheap; the freshness below only bounds how long a list can
 * sit on screen without being checked.
 *
 * Freshness: fifteen minutes. A failure waits a minute before the next try.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createSwrResource, type SwrResource, type SwrState } from "@/lib/swr-resource";
import { useShownPoll } from "@/lib/use-shown-poll";
import type { EarningsDetail, EarningsReaction, EarningsScope } from "../../shared/earnings-types";
import { calendarSectorsFor } from "../../shared/earnings-foryou";
import { loadEarnings, type EarningsAnswer } from "./earnings-load";
import { supabase } from "@/lib/supabase";
import { readPreferences } from "@/lib/user-preferences";

export const EARNINGS_STALE_AFTER_MS = 15 * 60_000;
export const EARNINGS_RETRY_AFTER_MS = 60_000;
export const EARNINGS_KEEP_WARM_MS = 30 * 60_000;
/** The window the tab and the card ask for; the tab's "2 weeks" is a filter over it. */
export const EARNINGS_DAYS = 28;

export type { EarningsAnswer };

/** Error codes the views word: main's own, and "restart" for a bridge without the channel. */
export type EarningsErrorCode = "restart" | "scope_unavailable" | "unavailable" | "invalid_request";

// This module is imported by node-side tests, where `window` does not exist.
function bridge(): Window["meridian"] {
  return typeof window === "undefined" ? undefined : window.meridian;
}

const resources = new Map<string, SwrResource<EarningsAnswer>>();

export function earningsResource(
  scope: EarningsScope,
  held: readonly string[],
  watchlist: readonly string[],
  sectors: readonly string[] = [],
): SwrResource<EarningsAnswer> {
  const h = [...new Set(held)].sort();
  const w = [...new Set(watchlist)].sort();
  const sec = [...new Set(sectors)].sort();
  const key = [scope, EARNINGS_DAYS, h.join(","), w.join(","), sec.join(",")].join("|");
  let resource = resources.get(key);
  if (resource) return resource;
  resource = createSwrResource<EarningsAnswer>({
    staleAfterMs: EARNINGS_STALE_AFTER_MS,
    retryAfterMs: EARNINGS_RETRY_AFTER_MS,
    keepWarmMs: EARNINGS_KEEP_WARM_MS,
    // earnings-load.ts: a main process older than this renderer still gives a list, or the restart note.
    load: () => loadEarnings(bridge()?.getEarningsUpcoming, { scope, days: EARNINGS_DAYS, held: h, watchlist: w, sectors: sec }),
  });
  resources.set(key, resource);
  return resource;
}

/** The answer for this request, held for as long as the calling component is mounted. */
export function useEarnings(
  scope: EarningsScope,
  held: readonly string[],
  watchlist: readonly string[],
  sectors: readonly string[] = [],
): SwrState<EarningsAnswer> & { retry: () => void } {
  const heldKey = held.join(",");
  const watchKey = watchlist.join(",");
  const sectorKey = sectors.join(",");
  // Keyed on the lists' contents, so a new array with the same names is the same resource.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resource = useMemo(() => earningsResource(scope, held, watchlist, sectors), [scope, heldKey, watchKey, sectorKey]);
  const state = useSyncExternalStore(resource.subscribe, resource.getState, resource.getState);
  useEffect(() => resource.retain(), [resource]);
  return { ...state, retry: () => void resource.revalidate() };
}

/** For tests and the preview harness. */
export function resetEarningsResources(): void {
  for (const r of resources.values()) r.reset();
  resources.clear();
  reactionCache.clear();
  detailCache.clear();
}

// ---------------------------------------------------------------------------
// Reaction figures and the drawer's detail, per name
// ---------------------------------------------------------------------------

/** Main keeps these for the New York day; here they are kept half an hour, failures a minute. */
const REACTION_TTL_MS = 30 * 60_000;
const REACTION_RETRY_MS = 60_000;

type Kept<T> = { at: number; value: T | null; ok: boolean };
const reactionCache = new Map<string, Kept<EarningsReaction>>();
const reactionListeners = new Set<() => void>();
const reactionInFlight = new Set<string>();

function fresh<T>(k: Kept<T> | undefined, now: number): boolean {
  return !!k && now - k.at < (k.ok ? REACTION_TTL_MS : REACTION_RETRY_MS);
}

async function loadReactions(tickers: readonly string[]): Promise<void> {
  const ask = bridge()?.getEarningsReactions;
  const now = Date.now();
  const missing = tickers.filter((t) => !fresh(reactionCache.get(t), now) && !reactionInFlight.has(t));
  if (missing.length === 0 || typeof ask !== "function") return;
  for (const t of missing) reactionInFlight.add(t);
  try {
    const res = await ask(missing);
    const at = Date.now();
    for (const t of missing) {
      const value = res?.ok ? (res.reactions[t] ?? null) : null;
      reactionCache.set(t, { at, value, ok: !!res?.ok && value !== null });
    }
  } catch {
    const at = Date.now();
    for (const t of missing) reactionCache.set(t, { at, value: reactionCache.get(t)?.value ?? null, ok: false });
  } finally {
    for (const t of missing) reactionInFlight.delete(t);
    for (const l of reactionListeners) l();
  }
}

/** Reaction figures for these names, asked for once the list is on screen; a name not read yet is absent. */
export function useEarningsReactions(tickers: readonly string[]): Record<string, EarningsReaction | null> {
  const key = [...new Set(tickers)].sort().join(",");
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    reactionListeners.add(listener);
    return () => {
      reactionListeners.delete(listener);
    };
  }, []);
  // Once the tab is in front (not while it is mounted ahead of time behind another), and again once stale.
  useShownPoll(
    key,
    () => {
      const list = key ? key.split(",") : [];
      // Asked in pieces, one after another, so the first rows fill in without waiting on the last.
      void (async () => {
        for (let i = 0; i < list.length; i += 20) await loadReactions(list.slice(i, i + 20));
      })();
    },
    REACTION_TTL_MS,
  );
  const out: Record<string, EarningsReaction | null> = {};
  for (const t of key ? key.split(",") : []) {
    const k = reactionCache.get(t);
    if (k) out[t] = k.value;
  }
  return out;
}

export type DetailState = { status: "loading" } | { status: "ready"; detail: EarningsDetail } | { status: "failed" };

const detailCache = new Map<string, { at: number; detail: EarningsDetail }>();

/** The drawer's detail for one name; null ticker reads nothing. */
export function useEarningsDetail(ticker: string | null): DetailState {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  useEffect(() => {
    if (!ticker) return;
    const kept = detailCache.get(ticker);
    if (kept && Date.now() - kept.at < REACTION_TTL_MS) {
      setState({ status: "ready", detail: kept.detail });
      return;
    }
    setState({ status: "loading" });
    let cancelled = false;
    const ask = bridge()?.getEarningsDetail;
    if (typeof ask !== "function") {
      setState({ status: "failed" });
      return;
    }
    ask(ticker)
      .then((res) => {
        if (cancelled) return;
        if (res?.ok) {
          detailCache.set(ticker, { at: Date.now(), detail: res.detail });
          if (res.detail.reaction) reactionCache.set(ticker, { at: Date.now(), value: res.detail.reaction, ok: true });
          setState({ status: "ready", detail: res.detail });
        } else setState({ status: "failed" });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);
  return state;
}

// ---------------------------------------------------------------------------
// The sectors the reader follows, for "For you"
// ---------------------------------------------------------------------------

let profileSectors: string[] | null = null;
let profileSectorsTask: Promise<string[]> | null = null;

function loadProfileSectors(): Promise<string[]> {
  if (profileSectors) return Promise.resolve(profileSectors);
  if (!profileSectorsTask) {
    profileSectorsTask = (async () => {
      try {
        const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
        profileSectors = calendarSectorsFor(readPreferences(data.session?.user ?? null).sectors).sort();
      } catch {
        profileSectors = [];
      }
      return profileSectors;
    })();
  }
  return profileSectorsTask;
}

/**
 * The calendar sectors the reader picked at onboarding (the session's user
 * metadata), read once per run. Empty until read and when none were picked.
 */
export function useProfileSectors(): string[] {
  const [sectors, setSectors] = useState<string[]>(profileSectors ?? []);
  useEffect(() => {
    let live = true;
    void loadProfileSectors().then((s) => {
      if (live) setSectors((prev) => (prev.join(",") === s.join(",") ? prev : s));
    });
    return () => {
      live = false;
    };
  }, []);
  return sectors;
}
