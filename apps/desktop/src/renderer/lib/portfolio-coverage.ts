/**
 * Keeps the system's coverage in step with the user's holdings: whenever the
 * paper account changes, the held symbols are reported to the main process,
 * which tracks anything new and extracts its relationship graph.
 *
 * Reads the REAL account, never the demo overlay — demo tickers must not
 * trigger backfills or LLM extraction jobs.
 */

import {
  hasRealPaperAccount,
  readRealPaperAccount,
  subscribePaperAccount,
} from "@/lib/paper-account";

const DEBOUNCE_MS = 1_500;

export function heldSymbols(): string[] {
  if (!hasRealPaperAccount()) return [];
  const account = readRealPaperAccount();
  return Object.values(account.positions)
    .filter((p) => p.shares !== 0)
    .map((p) => p.symbol.trim().toUpperCase())
    .filter(Boolean);
}

/** Start syncing; returns a stop function. Safe to call once per mount. */
export function startPortfolioCoverageSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSent = "";

  const push = () => {
    const symbols = heldSymbols();
    if (symbols.length === 0) return;
    const key = [...symbols].sort().join(",");
    if (key === lastSent) return; // unchanged set — nothing to reconcile
    lastSent = key;
    void window.meridian?.syncPortfolioHoldings(symbols);
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(push, DEBOUNCE_MS);
  };

  schedule();
  const unsubscribe = subscribePaperAccount(schedule);
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}
