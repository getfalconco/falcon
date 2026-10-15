/**
 * Which Positions row the reader is pointing at (or has focused), so the Risk
 * Score card can show that name's own risk while it is.
 *
 * A module-level store read through `useSyncExternalStore`: the two cards sit
 * in different corners of the dashboard and share nothing else. Leaving a row
 * does not clear at once: moving from one row to the next passes through the
 * gap between them, and clearing there would flash the portfolio view for a
 * frame. The clear waits a beat, and entering any row in that beat cancels it.
 *
 * No aliases and no DOM here, so the node test runner can drive it with fakes.
 */

import { useSyncExternalStore } from "react";

/** How long a leave waits before the card goes back to the portfolio. */
export const POSITION_HOVER_CLEAR_MS = 140;

export type PositionHoverStore = {
  /** The hovered ticker (upper case), or null. */
  get: () => string | null;
  /** A row was entered or focused: show it now, and cancel a pending clear. */
  enter: (ticker: string) => void;
  /** A row was left or blurred: clear after the delay, unless another is entered first. */
  leave: (ticker?: string) => void;
  /** Clear at once (unmount). */
  reset: () => void;
  subscribe: (listener: () => void) => () => void;
};

export type PositionHoverDeps = {
  delayMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

export function createPositionHoverStore(deps: PositionHoverDeps = {}): PositionHoverStore {
  const delay = deps.delayMs ?? POSITION_HOVER_CLEAR_MS;
  const setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const listeners = new Set<() => void>();
  let current: string | null = null;
  let pending: unknown = null;

  const cancel = () => {
    if (pending != null) clearTimer(pending);
    pending = null;
  };
  const set = (next: string | null) => {
    if (next === current) return;
    current = next;
    for (const l of [...listeners]) l();
  };

  return {
    get: () => current,
    enter: (ticker) => {
      const t = ticker.trim().toUpperCase();
      if (!t) return;
      cancel();
      set(t);
    },
    leave: (ticker) => {
      // A late leave from a row that is no longer the hovered one (focus
      // moved, then the mouse left the old row) must not clear the new one.
      if (ticker != null && current != null && ticker.trim().toUpperCase() !== current) return;
      cancel();
      pending = setTimer(() => {
        pending = null;
        set(null);
      }, delay);
    },
    reset: () => {
      cancel();
      set(null);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The dashboard's one store: the Positions card writes it, the Risk Score card reads it. */
export const positionHover = createPositionHoverStore();

export function useHoveredPosition(): string | null {
  return useSyncExternalStore(positionHover.subscribe, positionHover.get, () => null);
}
