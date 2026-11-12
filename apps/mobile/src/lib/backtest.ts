import { useCallback, useEffect, useState } from "react";
import type { BacktestResult, Strategy } from "@falcon/backtest";
import { API_BASE } from "./env";

/**
 * "Backtest this" on a Sighting: the website's POST /api/backtest/run with
 * rules built from the card (@falcon/backtest/sighting). The route sends CORS
 * headers, so the browser preview calls the local app host directly.
 * Results stay in memory for the session, one per card.
 */

const TIMEOUT_MS = 25_000;

export type BacktestState =
  | { status: "idle" }
  | { status: "running"; retrying: boolean }
  | { status: "done"; result: BacktestResult }
  | { status: "error"; message: string };

const cache = new Map<string, BacktestState>();

async function post(strategy: Strategy): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/backtest/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function message(status: number, body: Record<string, unknown> | null): string {
  if (status === 429) return "Too many runs in a short time. Try again in a minute.";
  if (status === 504) return "The price data took too long to load. Try again; it is faster the second time.";
  if (typeof body?.error === "string") return body.error;
  return "The backtest could not run right now.";
}

async function run(strategy: Strategy, onRetry: () => void): Promise<BacktestState> {
  try {
    let r = await post(strategy);
    if (r.status === 504) {
      // What loaded before the deadline is cached on the server: one more try.
      onRetry();
      r = await post(strategy);
    }
    if (r.status === 200 && r.body && Array.isArray(r.body.equity)) {
      return { status: "done", result: r.body as unknown as BacktestResult };
    }
    return { status: "error", message: message(r.status, r.body) };
  } catch {
    return { status: "error", message: "The backtest service could not be reached." };
  }
}

const listeners = new Set<() => void>();

function put(cardId: string, s: BacktestState) {
  cache.set(cardId, s);
  listeners.forEach((l) => l());
}

/** The run for one card's rules; `start` runs it (again after an error). Survives leaving the screen. */
export function useBacktest(cardId: string | undefined, strategy: Strategy | null) {
  const read = useCallback((): BacktestState => (cardId && cache.get(cardId)) || { status: "idle" }, [cardId]);
  const [state, setState] = useState<BacktestState>(read);

  useEffect(() => {
    setState(read());
    const l = () => setState(read());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [read]);

  const start = useCallback(() => {
    if (!cardId || !strategy || cache.get(cardId)?.status === "running") return;
    put(cardId, { status: "running", retrying: false });
    void run(strategy, () => put(cardId, { status: "running", retrying: true })).then((s) => put(cardId, s));
  }, [cardId, strategy]);

  return { state, start };
}
