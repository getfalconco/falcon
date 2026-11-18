"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { AppAction, AppContext, GraphFilterToken } from "@/lib/desk/app-actions";

/**
 * Between Falcon AI (the Desk chat) and the rest of the workspace, without
 * threading props: the Workspace registers how to run an app action and how to
 * describe what is on screen (useAppBridge); lab/sessions.ts runs each new
 * action once and sends the snapshot with every request; the Graph tab picks up
 * the filters Falcon AI set; "Ask Falcon AI" buttons leave a
 * prompt for the Desk to pick up (askFalconAI / usePendingAsk).
 */

type Bridge = { run: (a: AppAction) => void; snapshot: () => AppContext | null; openDesk: () => void };
let bridge: Bridge | null = null;

export function useAppBridge(b: Bridge): void {
  useEffect(() => {
    bridge = b;
    return () => {
      if (bridge === b) bridge = null;
    };
  }, [b]);
}

/** Runs an app action in the workspace; false when no workspace is mounted. */
export function runAppAction(a: AppAction): boolean {
  if (!bridge) return false;
  try {
    bridge.run(a);
    return true;
  } catch {
    return false;
  }
}

/** What the member is looking at, for the Desk request's `app` field. */
export function appSnapshot(): AppContext | null {
  try {
    return bridge?.snapshot() ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ small stores */

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => {
      value = v;
      listeners.forEach((l) => l());
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** Matches app/app/_components/graph-filters.tsx (sessionStorage per workspace scope). */
const FILTERS_KEY = "falcon.graph-filters.v1";
export const GRAPH_FILTERS_EVENT = "falcon:graph-filters";

/** Sets the Graph's filters for a workspace: kept for a Graph mounted later, and sent to one on screen. */
export function pushGraphFilters(scope: string, filters: GraphFilterToken[]): void {
  try {
    const key = `${FILTERS_KEY}:${scope}`;
    if (filters.length) window.sessionStorage.setItem(key, JSON.stringify(filters));
    else window.sessionStorage.removeItem(key);
  } catch {
    // blocked storage: the event still reaches a mounted Graph
  }
  window.dispatchEvent(new CustomEvent(GRAPH_FILTERS_EVENT, { detail: { scope, filters } }));
}

export function readGraphFilters(scope: string): GraphFilterToken[] {
  try {
    const raw = window.sessionStorage.getItem(`${FILTERS_KEY}:${scope}`);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as GraphFilterToken[]).filter((f) => f && typeof f.field === "string" && Array.isArray(f.values)) : [];
  } catch {
    return [];
  }
}

/** A prompt an "Ask Falcon AI" button left for the Desk (a new session opens with it in the composer). */
const pending = store<string | null>(null);
export function askFalconAI(prompt: string): void {
  pending.set(prompt.slice(0, 2000));
  bridge?.openDesk();
}
export function usePendingAsk(): string | null {
  return useSyncExternalStore(pending.subscribe, pending.get, () => null);
}
export const clearPendingAsk = () => pending.set(null);
