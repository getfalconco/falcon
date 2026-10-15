/**
 * The Exposure tab's and card's answer, shared and kept across mounts.
 *
 * The request is built here from what the reader sees elsewhere: the paper
 * account (the demo book while demo mode is on) valued at the same live
 * prints, through the same weight function, as the Positions card; or, on
 * the watchlist view, every watched name at an equal share. Main does the
 * graph work (`exposure:summary`) and keeps answers per request; this side
 * keeps the last few as well, so the tab, the card and a copy of the card
 * draw at once, and a price tick that moves no weight by a tenth of a point
 * asks nothing.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useLiveQuotes } from "@/hooks/useLivePrices";
import { isEtfTicker } from "@/lib/etf-tickers";
import { isDemoMode, subscribeDemoMode } from "@/lib/demo-mode";
import { readPaperAccount, subscribePaperAccount, type PaperAccount } from "@/lib/paper-account";
import { getWatchlist, subscribeWatchlist } from "@/lib/watchlist";
import { useOnHomeTabShown } from "@/lib/home-tab-activity";
import { paperAccountWeights } from "../../shared/portfolio-weights";
import {
  exposureRequestKey,
  type ExposureRequest,
  type ExposureResult,
  type ExposureScope,
  type ExposureSummary,
} from "../../shared/exposure";

/** Error codes the views word: main's own, and "restart" for a bridge without the channel. */
export type ExposureErrorCode = "restart" | "unavailable" | "invalid_request";

const SCOPE_KEY = "falcon.ui.exposure.v1";
const KEEP = 12;
/** A price tick settles before the request goes out. */
const SETTLE_MS = 600;
/** An answer older than this is asked again when the tab comes back to the front. */
const STALE_AFTER_MS = 10 * 60_000;

// This module is imported by node-side tests, where `window` does not exist.
function bridge(): Window["meridian"] {
  return typeof window === "undefined" ? undefined : window.meridian;
}

type Kept = { summary: ExposureSummary; at: number };
const answers = new Map<string, Kept>();
const asks = new Map<string, Promise<ExposureResult | { ok: false; error: "restart" }>>();

function keep(key: string, summary: ExposureSummary): void {
  answers.delete(key);
  answers.set(key, { summary, at: Date.now() });
  while (answers.size > KEEP) answers.delete(answers.keys().next().value!);
}

function ask(key: string, request: ExposureRequest): Promise<ExposureResult | { ok: false; error: "restart" }> {
  const out = asks.get(key);
  if (out) return out;
  const get = bridge()?.getExposureSummary;
  const promise = (get ? get(request) : Promise.resolve({ ok: false as const, error: "restart" as const }))
    .catch((err: unknown) => {
      // A main process older than this renderer has no handler for the channel.
      const text = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: /No handler registered/i.test(text) ? ("restart" as const) : ("unavailable" as const) };
    })
    .then((result) => {
      if (result.ok) keep(key, result.summary);
      return result;
    })
    .finally(() => asks.delete(key));
  asks.set(key, promise);
  return promise;
}

function readScope(): ExposureScope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "watchlist" ? "watchlist" : "account";
  } catch {
    return "account";
  }
}

/** The reader's choice of view, one for every mount: the tab's switch moves the card too. */
let chosenScope: ExposureScope | null = null;
const scopeListeners = new Set<() => void>();
function getScope(): ExposureScope {
  if (chosenScope === null) chosenScope = readScope();
  return chosenScope;
}
function subscribeScope(listener: () => void): () => void {
  scopeListeners.add(listener);
  return () => scopeListeners.delete(listener);
}

/** The account as the screen shows it (demo book while demo mode is on), kept current. */
function useAccount(): PaperAccount {
  const [account, setAccount] = useState<PaperAccount>(readPaperAccount);
  useEffect(() => {
    const update = () => setAccount(readPaperAccount());
    update();
    const offAccount = subscribePaperAccount(update);
    const offDemo = subscribeDemoMode(update);
    return () => {
      offAccount();
      offDemo();
    };
  }, []);
  return account;
}

function useWatchlist(): string[] {
  const read = () => [...new Set(getWatchlist().map((e) => e.ticker.trim().toUpperCase()).filter(Boolean))].sort();
  const [list, setList] = useState<string[]>(read);
  useEffect(() => {
    const update = () => setList((prev) => {
      const next = read();
      return prev.join(",") === next.join(",") ? prev : next;
    });
    update();
    return subscribeWatchlist(update);
  }, []);
  return list;
}

export type ExposureView = {
  /** The view drawn: the reader's choice, or the watchlist when there are no positions to read. */
  scope: ExposureScope;
  setScope: (scope: ExposureScope) => void;
  /** Open positions and watched names. */
  positions: number;
  watched: number;
  summary: ExposureSummary | null;
  error: ExposureErrorCode | null;
  /** A request is out (a value may still be shown). */
  loading: boolean;
  retry: () => void;
  /** Demo mode is on: research is not offered for the demo book. */
  demo: boolean;
};

export function useExposure(): ExposureView {
  const chosen = useSyncExternalStore(subscribeScope, getScope, getScope);
  const account = useAccount();
  const watchlist = useWatchlist();
  const symbols = useMemo(
    () => Object.values(account.positions ?? {}).filter((p) => p && Number.isFinite(p.shares) && p.shares !== 0).map((p) => p.symbol.toUpperCase()),
    [account],
  );
  const positions = symbols.length;
  const scope: ExposureScope = chosen === "account" && positions === 0 && watchlist.length > 0 ? "watchlist" : chosen;
  const quotes = useLiveQuotes(scope === "account" ? [...symbols].sort().join(",") : "");

  const request = useMemo<ExposureRequest>(() => {
    if (scope === "watchlist") {
      const share = watchlist.length > 0 ? 1 / watchlist.length : 0;
      return { scope, holdings: watchlist.map((ticker) => ({ ticker, weight: share, fund: isEtfTicker(ticker) })) };
    }
    const prices: Record<string, number> = {};
    for (const [symbol, q] of Object.entries(quotes)) prices[symbol] = q.price;
    const weights = paperAccountWeights(account, prices);
    return {
      scope,
      holdings: weights.positions
        .filter((r): r is typeof r & { weight: number } => r.weight !== null && Number.isFinite(r.weight))
        .map((r) => ({ ticker: r.ticker, weight: r.weight, fund: isEtfTicker(r.ticker) })),
    };
  }, [scope, watchlist, account, quotes]);
  const key = exposureRequestKey(request);

  const [state, setState] = useState<{ key: string | null; summary: ExposureSummary | null; error: ExposureErrorCode | null; loading: boolean }>(() => {
    const known = answers.get(key);
    return { key: known ? key : null, summary: known?.summary ?? null, error: null, loading: !known };
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const known = answers.get(key);
    if (known && nonce === 0 && Date.now() - known.at < STALE_AFTER_MS) {
      setState({ key, summary: known.summary, error: null, loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    // The first ask goes at once; one that follows a price tick waits for the prints to settle.
    const timer = setTimeout(
      () => {
        void ask(key, request).then((result) => {
          if (!live) return;
          if (result.ok) setState({ key, summary: result.summary, error: null, loading: false });
          else setState((s) => ({ ...s, error: result.error, loading: false }));
        });
      },
      state.summary === null ? 0 : SETTLE_MS,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `request` is identified by `key`; `state.summary` only picks the delay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  // A graph rebuilt while the tab sat behind another one is read when it comes back.
  useOnHomeTabShown(() => {
    const known = answers.get(key);
    if (!known || Date.now() - known.at >= STALE_AFTER_MS) setNonce((n) => n + 1);
  });

  const setScope = useCallback((next: ExposureScope) => {
    chosenScope = next;
    for (const listener of scopeListeners) listener();
    try {
      localStorage.setItem(SCOPE_KEY, next);
    } catch {
      /* the choice holds for this session */
    }
  }, []);

  return {
    scope,
    setScope,
    positions,
    watched: watchlist.length,
    // An answer for the other view is not drawn while this one is asked.
    summary: state.summary?.scope === scope ? state.summary : null,
    error: state.error,
    loading: state.loading,
    retry: () => setNonce((n) => n + 1),
    demo: isDemoMode(),
  };
}

/** Puts the holdings without a graph in the research queue (the real account only). */
export async function researchHoldings(tickers: readonly string[]): Promise<string[]> {
  const sync = bridge()?.syncPortfolioHoldings;
  if (!sync || tickers.length === 0) return [];
  try {
    const result = await sync([...tickers]);
    return result && "queued" in result && Array.isArray(result.queued) ? result.queued : [];
  } catch {
    return [];
  }
}
