"use client";

import { FUNNEL_TEST_MODE } from "@/lib/funnel-test-mode";
import { MAX_STOCKS, TICKER_PATTERN, type PickedStock } from "@/lib/onboarding";

/**
 * The member's portfolio: the tickers their holdings imports (broker through
 * SnapTrade, a screenshot, the welcome flow's connect step) and the demo
 * portfolio put in. Tickers only, no shares or values. People do not edit it
 * by hand; Settings can clear it.
 *
 * Storage keeps its original names, so saved lists keep working: this module,
 * the `falcon.focus.v1` keys and the account's `watchlist` column through
 * /api/onboarding are where the portfolio lives ("focus list" was its old
 * name). The Workspace reads it through `usePortfolio` (Workspace.tsx).
 *
 * Where it comes from, first match wins:
 *   1. this page visit's memory (the welcome flow hands its picks over here,
 *      which is the only copy in funnel test mode)
 *   2. this browser, per user id (not in funnel test mode)
 *   3. the server: GET /api/onboarding -> { watchlist }
 *
 * `userId` here is a storage scope (lib/workspace/workspaces.ts): the user id
 * for the main workspace, `<userId>:<workspaceId>` for the others. Only the
 * main workspace's list comes from or goes to the server; the Workspace
 * decides that, these functions only read and write this browser.
 */

export type FocusItem = { ticker: string; name: string };
/** One portfolio ticker (the storage type keeps its old name). */
export type PortfolioItem = FocusItem;

/**
 * The list held for this page visit, with the scope it belongs to; null scope
 * is the welcome flow's hand-over, which is for the main workspace.
 */
let memory: { scope: string | null; items: FocusItem[] } | null = null;
let finishedThisVisit = false;

export const FOCUS_KEY_PREFIX = "falcon.focus.v1";
const KEY_PREFIX = FOCUS_KEY_PREFIX;

/** The main workspace's scope is the bare user id; other workspaces add `:<workspaceId>`. */
function isMainScope(scope: string): boolean {
  return !scope.includes(":");
}

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
  memory = { scope: null, items: clean(stocks) };
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
  if (memory && (memory.scope === userId || (memory.scope === null && isMainScope(userId)))) return memory.items;
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
  const list = clean(items);
  memory = { scope: userId, items: list };
  if (FUNNEL_TEST_MODE || typeof window === "undefined") return;
  try {
    localStorage.setItem(key(userId), JSON.stringify(list));
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

/** Saves the portfolio to the account (its `watchlist` column). Never throws; skipped in funnel test mode. */
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
    // The local copy stays; the next change tries again.
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

export { clean as cleanFocus };
