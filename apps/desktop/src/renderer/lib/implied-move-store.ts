/**
 * The options-implied report moves (main/options), shared across the Earnings
 * tab rows, its drawer and the Stock tab, and kept across mounts.
 *
 * Main holds the option snapshots for minutes while the market is open and
 * until the next open otherwise; here an answer is kept five minutes, a
 * failure one. A name is keyed with its report date and hour, so a re-dated
 * report is asked again.
 */

import { useEffect, useState } from "react";
import type { ImpliedMove, ImpliedRequestItem } from "../../shared/implied-move";

const TTL_MS = 5 * 60_000;
const RETRY_MS = 60_000;
/** Names asked per request, so the first rows fill in without waiting on the last. */
const BATCH = 8;

// This module is imported by node-side tests, where `window` does not exist.
function bridge(): Window["meridian"] {
  return typeof window === "undefined" ? undefined : window.meridian;
}

type Kept = { at: number; value: ImpliedMove | null; ok: boolean };
const cache = new Map<string, Kept>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

const keyOf = (r: ImpliedRequestItem) => `${r.ticker}|${r.date}|${r.time}`;

function fresh(k: Kept | undefined, now: number): boolean {
  return !!k && now - k.at < (k.ok ? TTL_MS : RETRY_MS);
}

async function load(items: readonly ImpliedRequestItem[]): Promise<void> {
  const ask = bridge()?.getImpliedMoves;
  const now = Date.now();
  const missing = items.filter((r) => !fresh(cache.get(keyOf(r)), now) && !inFlight.has(keyOf(r)));
  if (missing.length === 0 || typeof ask !== "function") return;
  for (const r of missing) inFlight.add(keyOf(r));
  try {
    const res = await ask(missing);
    const at = Date.now();
    for (const r of missing) {
      const value = res?.ok ? (res.moves[r.ticker] ?? null) : null;
      // "No usable option quotes" is an answer: kept as long as a figure.
      cache.set(keyOf(r), { at, value, ok: !!res?.ok });
    }
  } catch {
    const at = Date.now();
    for (const r of missing) cache.set(keyOf(r), { at, value: cache.get(keyOf(r))?.value ?? null, ok: false });
  } finally {
    for (const r of missing) inFlight.delete(keyOf(r));
    for (const l of listeners) l();
  }
}

/** Batches one after another: main reads each name's option chains, and a burst helps no one. */
async function loadAll(list: readonly ImpliedRequestItem[]): Promise<void> {
  for (let i = 0; i < list.length; i += BATCH) await load(list.slice(i, i + BATCH));
}

/** The implied move per ticker for these upcoming reports; a name not read yet is absent, one without quotes is null. */
export function useImpliedMoves(items: readonly ImpliedRequestItem[]): Record<string, ImpliedMove | null> {
  const key = [...new Set(items.map(keyOf))].sort().join(",");
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    const list: ImpliedRequestItem[] = key
      ? key.split(",").map((k) => {
          const [ticker, date, time] = k.split("|");
          return { ticker: ticker!, date: date!, time: time as ImpliedRequestItem["time"] };
        })
      : [];
    void loadAll(list);
    // A long sitting re-reads once the answers go stale.
    const timer = setInterval(() => void loadAll(list), TTL_MS);
    return () => {
      listeners.delete(listener);
      clearInterval(timer);
    };
  }, [key]);
  const out: Record<string, ImpliedMove | null> = {};
  for (const k of key ? key.split(",") : []) {
    const kept = cache.get(k);
    if (kept) out[k.split("|")[0]!] = kept.value;
  }
  return out;
}
