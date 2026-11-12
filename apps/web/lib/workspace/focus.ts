"use client";

import { FUNNEL_TEST_MODE } from "@/lib/funnel-test-mode";
import { MAX_STOCKS, TICKER_PATTERN, type PickedStock } from "@/lib/onboarding";

/**
 * The member's focus list: the tickers picked in the welcome flow, edited
 * later from the Workspace sidebar.
 *
 * Where it comes from, first match wins:
 *   1. this page visit's memory (the welcome flow hands its picks over here,
 *      which is the only copy in funnel test mode)
 *   2. this browser, per user id (not in funnel test mode)
 *   3. the server: GET /api/onboarding -> { watchlist }
 */

export type FocusItem = { ticker: string; name: string };

let memory: FocusItem[] | null = null;
let finishedThisVisit = false;

const KEY_PREFIX = "falcon.focus.v1";

function clean(items: readonly { ticker: string; name?: string }[]): FocusItem[] {
  const seen = new Set<string>();
  const out: FocusItem[] = [];
  for (const item of items) {
    const ticker = item.ticker.trim().toUpperCase();
    if (!TICKER_PATTERN.test(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({ ticker, name: typeof item.name === "string" ? item.name : "" });
  }
  return out.slice(0, MAX_STOCKS);
}

/** Called by the welcome flow as it hands over to the Workspace. */
export function handOverFromWelcome(stocks: readonly PickedStock[]): void {
  memory = clean(stocks);
  finishedThisVisit = true;
}

/** True once the welcome flow finished in this page visit (funnel test mode has no other record). */
export function welcomeFinishedThisVisit(): boolean {
  return finishedThisVisit;
}

function key(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

export function readLocalFocus(userId: string): FocusItem[] | null {
  if (memory) return memory;
  if (FUNNEL_TEST_MODE || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? clean(parsed.filter((x): x is FocusItem => !!x && typeof x === "object" && typeof (x as FocusItem).ticker === "string"))
      : null;
  } catch {
    return null;
  }
}

export function writeLocalFocus(userId: string, items: readonly FocusItem[]): void {
  memory = clean(items);
  if (FUNNEL_TEST_MODE || typeof window === "undefined") return;
  try {
    localStorage.setItem(key(userId), JSON.stringify(memory));
  } catch {
    // Storage unavailable: the server copy still has it.
  }
}

export async function fetchServerFocus(token: string): Promise<string[] | null> {
  try {
    const res = await fetch("/api/onboarding", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { watchlist?: unknown };
    return Array.isArray(body.watchlist) ? body.watchlist.filter((t): t is string => typeof t === "string") : null;
  } catch {
    return null;
  }
}

/** Saves the list as the member's watchlist. Never throws; skipped in funnel test mode. */
export async function saveServerFocus(token: string, items: readonly FocusItem[]): Promise<void> {
  if (FUNNEL_TEST_MODE) return;
  try {
    await fetch("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ stocks: items.map(({ ticker, name }) => ({ ticker, name })) }),
      cache: "no-store",
    });
  } catch {
    // The local copy stays; the next edit tries again.
  }
}

/** Company names for tickers, from the SEC list behind /api/tickers. */
export async function fetchNames(tickers: readonly string[]): Promise<Record<string, string>> {
  if (tickers.length === 0) return {};
  try {
    const res = await fetch(`/api/tickers?symbols=${encodeURIComponent(tickers.join(","))}`);
    if (!res.ok) return {};
    const body = (await res.json()) as { names?: Record<string, string> };
    return body.names ?? {};
  } catch {
    return {};
  }
}

export type TickerResult = { ticker: string; name: string };

export async function searchTickers(q: string, signal?: AbortSignal): Promise<TickerResult[]> {
  try {
    const res = await fetch(`/api/tickers?q=${encodeURIComponent(q)}`, { signal });
    if (!res.ok) return [];
    const body = (await res.json()) as { results?: TickerResult[] };
    return Array.isArray(body.results) ? body.results : [];
  } catch {
    return [];
  }
}

export { clean as cleanFocus };
