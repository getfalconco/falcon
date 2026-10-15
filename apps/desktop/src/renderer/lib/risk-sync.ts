/**
 * Gets the signed-in user's paper account to the Risk Engine and makes sure a
 * snapshot follows it.
 *
 * Pushing is not enough on its own. The engine keeps one host per user
 * (packages/research/src/risk/user-hosts.ts), and a user it has never scored
 * has no snapshot at all: a new account, or anyone whose state sat in the old
 * shared file that was archived when risk went per user. A push only starts
 * the 60s position debounce, and a push that fails (no session token yet, the
 * engine restarting, the network) was simply dropped, so the card could wait
 * for a score that was never coming. Here:
 *
 *   - a failed push is retried on a short backoff, and on demand (the card's
 *     Try again);
 *   - after a push lands, the latest snapshot is read back, and when it does
 *     not describe the account (none at all, or empty while positions are held,
 *     or the reverse) a recompute is asked for at once instead of waiting out
 *     the debounce.
 *
 * `failed` is what the card shows as its error state, and only while it has
 * no real score to show instead.
 *
 * No aliases and no DOM here, so the node test runner can drive it with fakes.
 */

import { riskSnapshotStale } from "../../shared/risk-card";
import type { RiskAccountPush, RiskLatest } from "../../shared/risk-types";

export type RiskSyncState = { failed: boolean };

type Failure = { ok: false; error: string };

export type RiskSyncBridge = {
  updateRiskAccount: (push: RiskAccountPush) => Promise<{ ok: true } | Failure>;
  getRiskLatest: () => Promise<({ ok: true } & RiskLatest) | Failure>;
  recomputeRisk?: () => Promise<({ ok: true } & RiskLatest) | Failure>;
};

export type RiskSyncDeps = {
  bridge: RiskSyncBridge;
  /** The account to push, read fresh each time. */
  build: () => RiskAccountPush;
  /** Fired when the sync state changes. */
  onState?: (state: RiskSyncState) => void;
  /** Fired once a push (or the recompute after it) has landed: the cue to re-read `risk:latest`. */
  onPushed?: () => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Backoff for automatic retries after a failure; once spent, only a manual retry tries again. */
  retryDelaysMs?: number[];
};

export const RISK_SYNC_RETRY_DELAYS_MS = [5_000, 15_000, 60_000];

export type RiskSync = {
  /** Push the current account now (start, every account change). */
  sync: () => Promise<void>;
  /** The card's Try again: clears the error at once and pushes again. */
  retry: () => Promise<void>;
  state: () => RiskSyncState;
  /** Stops any pending retry; later results are ignored. */
  dispose: () => void;
};

export function createRiskSync(deps: RiskSyncDeps): RiskSync {
  const { bridge } = deps;
  const setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const delays = deps.retryDelaysMs ?? RISK_SYNC_RETRY_DELAYS_MS;

  let state: RiskSyncState = { failed: false };
  let generation = 0;
  let attempt = 0;
  let retryHandle: unknown = null;
  let disposed = false;

  const set = (failed: boolean) => {
    if (state.failed === failed) return;
    state = { failed };
    deps.onState?.(state);
  };

  const cancelRetry = () => {
    if (retryHandle != null) clearTimer(retryHandle);
    retryHandle = null;
  };

  const fail = () => {
    set(true);
    cancelRetry();
    if (disposed || attempt >= delays.length) return;
    const delay = delays[attempt++];
    retryHandle = setTimer(() => {
      retryHandle = null;
      void run();
    }, delay);
  };

  const succeed = () => {
    attempt = 0;
    cancelRetry();
    set(false);
  };

  async function settle<T>(call: () => Promise<T>): Promise<T | null> {
    try {
      return await call();
    } catch {
      return null;
    }
  }

  async function run(): Promise<void> {
    if (disposed) return;
    const gen = ++generation;
    const current = () => !disposed && gen === generation;
    let push: RiskAccountPush;
    try {
      push = deps.build();
    } catch {
      return;
    }

    const pushed = await settle(() => bridge.updateRiskAccount(push));
    if (!current()) return;
    if (!pushed?.ok) return fail();
    deps.onPushed?.();
    // A demo push is computed on the spot and never stored: nothing to check.
    if (push.demo) return succeed();

    const latest = await settle(() => bridge.getRiskLatest());
    if (!current()) return;
    if (!latest?.ok) return fail();
    if (!riskSnapshotStale(latest, push.positions.length) || !bridge.recomputeRisk) return succeed();

    const recomputed = await settle(() => bridge.recomputeRisk!());
    if (!current()) return;
    // The host swallows a failed compute and returns no snapshot: a failure all the same.
    if (!recomputed?.ok || !recomputed.snapshot) return fail();
    succeed();
    deps.onPushed?.();
  }

  return {
    sync: () => {
      cancelRetry();
      attempt = 0;
      return run();
    },
    retry: () => {
      cancelRetry();
      attempt = 0;
      set(false);
      return run();
    },
    state: () => state,
    dispose: () => {
      disposed = true;
      cancelRetry();
    },
  };
}
