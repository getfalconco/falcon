/**
 * Analyst estimate revisions (main/estimates), shared across the Earnings tab
 * rows, its drawer and the Stock tab, and kept across mounts.
 *
 * Main holds each name's reading for thirty minutes while the market is open
 * and until the next open otherwise; here an answer is kept ten minutes, a
 * failure one.
 */

import { useEffect, useState } from "react";
import { useShownPoll } from "./use-shown-poll";
import type { EstimateRevisions } from "../../shared/estimate-revisions";

const TTL_MS = 10 * 60_000;
const RETRY_MS = 60_000;
/** Names asked per request, so the first rows fill in without waiting on the last. */
const BATCH = 10;

// This module is imported by node-side tests, where `window` does not exist.
function bridge(): Window["meridian"] {
  return typeof window === "undefined" ? undefined : window.meridian;
}

type Kept = { at: number; value: EstimateRevisions | null; ok: boolean };
const cache = new Map<string, Kept>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function fresh(k: Kept | undefined, now: number): boolean {
  return !!k && now - k.at < (k.ok ? TTL_MS : RETRY_MS);
}

async function load(tickers: readonly string[]): Promise<void> {
  const ask = bridge()?.getEstimateRevisions;
  const now = Date.now();
  const missing = tickers.filter((t) => !fresh(cache.get(t), now) && !inFlight.has(t));
  if (missing.length === 0 || typeof ask !== "function") return;
  for (const t of missing) inFlight.add(t);
  try {
    const res = await ask([...missing]);
    const at = Date.now();
    for (const t of missing) {
      // "No usable estimates" is an answer: kept as long as a figure.
      cache.set(t, { at, value: res?.ok ? (res.estimates[t] ?? null) : (cache.get(t)?.value ?? null), ok: !!res?.ok });
    }
  } catch {
    const at = Date.now();
    for (const t of missing) cache.set(t, { at, value: cache.get(t)?.value ?? null, ok: false });
  } finally {
    for (const t of missing) inFlight.delete(t);
    for (const l of listeners) l();
  }
}

async function loadAll(list: readonly string[]): Promise<void> {
  for (let i = 0; i < list.length; i += BATCH) await load(list.slice(i, i + BATCH));
}

/** The estimate revisions per ticker; a name not read yet is absent, one without usable estimates is null. */
export function useEstimateRevisions(tickers: readonly string[]): Record<string, EstimateRevisions | null> {
  const key = [...new Set(tickers.map((t) => t.toUpperCase()))].sort().join(",");
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  // Read while the tab is in front, again once the answers go stale; nothing from a tab kept hidden.
  useShownPoll(key, () => void loadAll(key ? key.split(",") : []), TTL_MS);
  const out: Record<string, EstimateRevisions | null> = {};
  for (const t of key ? key.split(",") : []) {
    const kept = cache.get(t);
    if (kept) out[t] = kept.value;
  }
  return out;
}
