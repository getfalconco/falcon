"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FUNNEL_TEST_MODE } from "../funnel-test-mode";
import { clearHoldings, createPaperAccount, deletePaperAccount, fetchHoldings, saveHoldings, type HoldingsData } from "../portfolio-client";
import { PAPER_ACCOUNT_ID, type PortfolioAccount, type PortfolioImport } from "../portfolio-holdings";
import { paperAccount, withPaper } from "../paper-account";
import { marketStatus } from "./market-status";
import { newTestSeed } from "./test-portfolio";

/**
 * The stored portfolio with sizes and live prices, for the Workspace
 * (GET /api/portfolio/holdings, lib/portfolio-client.ts). Amounts live in
 * this hook's memory only, never in this browser's storage.
 *
 * Modes:
 *   sizes    the signed-in member's main workspace: the stored rows, saved
 *            imports, Clear portfolio
 *   fixture  development preview with `&sizes=1`: the dev fixture with sizes
 *            (lib/workspace/fixture-positions.ts), nothing saved
 *   quotes   everything else (the preview, other workspaces, funnel test
 *            mode): live prices for the ticker list only, nothing saved
 *
 * Polled about every 60 s while the US market is open and the tab is visible;
 * re-read when the tab comes back, when the ticker list changes and after a save.
 *
 * Development only: `toggleTest` (⌘P / Ctrl+P in the Workspace) lays a random
 * test portfolio (lib/workspace/test-portfolio.ts) over `data`, with live
 * prices from the same route. The real answer stays untouched underneath and
 * comes back on the next toggle; `paper` and `status` stay the real ones, so
 * the setup card's tasks never move. Saving, clearing and paper actions are
 * refused while it is on. Nothing of it is stored anywhere.
 */

export type HoldingsMode = "sizes" | "fixture" | "quotes";

export type HoldingsState = {
  mode: HoldingsMode;
  /** Null until the first answer. */
  data: HoldingsData | null;
  status: "loading" | "ready" | "error";
  /** The paper account (stored, or kept in memory for this page visit), else null. */
  paper: PortfolioAccount | null;
  /** True when the paper account lives in memory only (preview, funnel test mode, table missing). */
  paperInMemory: boolean;
  /** Development only: the ⌘P test portfolio is shown in `data` instead of the real one. */
  test: boolean;
  /** Development only: the ⌘P portfolio's seed (its in-memory history on the server), else null. */
  seed: number | null;
};

export const TEST_PORTFOLIO_ON = process.env.NODE_ENV === "development";

const POLL_MS = 60_000;

export function holdingsMode({ main, preview, signedIn }: { main: boolean; preview: boolean; signedIn: boolean }): HoldingsMode {
  if (main && signedIn && !preview && !FUNNEL_TEST_MODE) return "sizes";
  if (main && preview && process.env.NODE_ENV === "development" && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("sizes") === "1") {
    return "fixture";
  }
  return "quotes";
}

export function useHoldings(
  { mode, tickers, enabled }: { mode: HoldingsMode; tickers: readonly string[]; enabled: boolean },
  getToken: () => Promise<string | null>,
) {
  const [state, setState] = useState<Omit<HoldingsState, "paper" | "paperInMemory" | "test" | "seed">>({ mode, data: null, status: "loading" });
  // A paper account that could not be stored: this page visit's memory only.
  const [localPaper, setLocalPaper] = useState<PortfolioAccount | null>(null);
  const key = tickers.join(",");
  const keyRef = useRef(key);
  keyRef.current = key;
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  // The ⌘P test portfolio: its seed and its last answer, in memory only.
  const [test, setTest] = useState<{ seed: number; data: HoldingsData | null } | null>(null);
  const testRef = useRef(test);
  testRef.current = test;

  const loadTest = useCallback(async (seed: number) => {
    try {
      // No token: the route serves the test portfolio under `next dev` only, and nothing of the member's is read.
      const data = await fetchHoldings({}, { fixture: seed });
      setTest((t) => (t && t.seed === seed ? { seed, data } : t));
    } catch {
      // Keeps the last answer; the next poll tries again.
    }
  }, []);

  const load = useCallback(async () => {
    const t = testRef.current;
    if (t) return loadTest(t.seed);
    const token = await getToken();
    const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
    // Without a token outside the preview the route answers 401; nothing to show then.
    if (!token && mode === "sizes") return;
    try {
      const data = await fetchHoldings(headers, {
        tickers: keyRef.current ? keyRef.current.split(",") : [],
        sizes: mode === "sizes",
        fixture: mode === "fixture",
      });
      setState({ mode, data, status: "ready" });
    } catch {
      setState((s) => ({ ...s, mode, status: s.data ? "ready" : "error" }));
    }
  }, [getToken, loadTest, mode]);
  loadRef.current = load;

  /** Development only: on with a new random set, off back to the real state (then refreshed). */
  const toggleTest = useCallback(() => {
    if (!TEST_PORTFOLIO_ON) return;
    const next = testRef.current ? null : { seed: newTestSeed(), data: null };
    testRef.current = next;
    setTest(next);
    void loadRef.current();
  }, []);

  // First load, and again whenever the ticker list changes.
  useEffect(() => {
    if (!enabled) return;
    void loadRef.current();
  }, [enabled, key, mode]);

  // Polling while the market is open and the tab is visible.
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      const status = marketStatus(Date.now());
      const wait = status.state === "open" ? POLL_MS : Math.max(POLL_MS, Math.min(status.nextChangeMs - Date.now() + 5_000, 30 * 60_000));
      timer = setTimeout(async () => {
        if (marketStatus(Date.now()).state === "open") await loadRef.current();
        schedule();
      }, wait);
    };
    const onVisible = () => {
      if (document.hidden) clearTimeout(timer);
      else {
        void loadRef.current();
        schedule();
      }
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);

  /** Saves an import (sizes mode only); `stored` false when sizes cannot be stored here or yet. Throws with a message on failure. */
  const saveImport = useCallback(
    async (imp: PortfolioImport): Promise<{ stored: boolean }> => {
      if (mode !== "sizes" || testRef.current) return { stored: false };
      const token = await getToken();
      if (!token) return { stored: false };
      const saved = await saveHoldings({ Authorization: `Bearer ${token}` }, imp);
      await loadRef.current();
      return { stored: saved.available };
    },
    [getToken, mode],
  );

  /** "Clear portfolio": the stored rows go (sizes mode); the shown sizes go everywhere. Never throws. */
  const clear = useCallback(async () => {
    if (testRef.current) return;
    setLocalPaper(null);
    setState((s) => (s.data ? { ...s, data: { ...s.data, accounts: [], positions: [], totals: [], weightCurrency: null, benchmark: null } } : s));
    if (mode !== "sizes") return;
    const token = await getToken();
    if (!token) return;
    await clearHoldings({ Authorization: `Bearer ${token}` }).catch(() => undefined);
  }, [getToken, mode]);

  const refresh = useCallback(() => void loadRef.current(), []);

  /** Creates the paper account (stored for the signed-in main workspace, else in memory). Throws with a message the form shows. */
  const createPaper = useCallback(
    async (balance: number, name: string | null): Promise<PortfolioAccount> => {
      if (testRef.current) throw new Error("A paper account can't be created right now.");
      const local = paperAccount(balance, name);
      if (!local) throw new Error("The starting balance is between $1,000 and $10,000,000.");
      const token = mode === "sizes" ? await getToken() : null;
      if (token) {
        const made = await createPaperAccount({ Authorization: `Bearer ${token}` }, balance, name);
        if (made.available && made.account) {
          setLocalPaper(null);
          await loadRef.current();
          return made.account;
        }
      }
      setLocalPaper(local);
      return local;
    },
    [getToken, mode],
  );

  /** "Clear paper portfolio": the paper account goes, here and on the account. Never throws. */
  const clearPaper = useCallback(async () => {
    if (testRef.current) return;
    setLocalPaper(null);
    setState((s) => (s.data ? { ...s, data: { ...s.data, accounts: withPaper(s.data.accounts, null) } } : s));
    if (mode !== "sizes") return;
    const token = await getToken();
    if (token) await deletePaperAccount({ Authorization: `Bearer ${token}` }).catch(() => undefined);
  }, [getToken, mode]);

  const holdings: HoldingsState = useMemo(() => {
    const storedPaper = state.data?.accounts.find((a) => a.id === PAPER_ACCOUNT_ID) ?? null;
    const data = state.data && localPaper ? { ...state.data, accounts: withPaper(state.data.accounts, localPaper) } : state.data;
    const paper = localPaper ?? storedPaper;
    if (test) return { ...state, mode: "fixture", data: test.data, paper, paperInMemory: localPaper !== null, test: true, seed: test.seed };
    return { ...state, data, paper, paperInMemory: localPaper !== null, test: false, seed: null };
  }, [localPaper, state, test]);

  return { holdings, saveImport, clearHoldings: clear, refreshHoldings: refresh, createPaper, clearPaper, toggleTest };
}
