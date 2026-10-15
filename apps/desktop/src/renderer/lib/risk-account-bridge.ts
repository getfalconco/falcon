/**
 * Pushes the paper account to the main process so the Risk Engine can read
 * positions/cash (§2). The renderer is the only place the account lives
 * (localStorage), exactly as B8's `held` context reaches Base from BasePanel.
 * Push on start and on every account change; main debounces (§5, 60s).
 *
 * Demo mode (Ctrl+P): the overlay account is pushed with `demo: true` — the
 * host computes it immediately and in memory only (nothing persisted, nothing
 * in the history), so the card shows a real score for the demo book. Leaving
 * demo pushes the real account again and the host re-broadcasts the real
 * snapshot. Read-only on the account — never writes back.
 *
 * Every push goes through `risk-sync`: a failed push is retried, and a push
 * that leaves the engine without a score for this account (a user it has
 * never scored, or one whose state was archived when risk went per user) is
 * followed by a recompute at once, so the card gets a real score instead of
 * waiting on one that is not coming.
 */

import { isDemoMode } from "@/lib/demo-mode";
import { readPaperAccount, subscribePaperAccount, type PaperAccount } from "@/lib/paper-account";
import type { RiskAccountPush } from "../../shared/risk-types";
import { createRiskSync, type RiskSync, type RiskSyncState } from "@/lib/risk-sync";

/** Fired (window) the moment a push goes out that will change the snapshot — the card shows loading until the next broadcast. */
export const RISK_PENDING_EVENT = "falcon:risk-pending";
/**
 * Fired once a push has been accepted. The host may have recomputed already
 * (a demo push is immediate), and when the engine runs on the service there is
 * no broadcast to wait for — so this is the cue to re-read `risk:latest`.
 */
export const RISK_PUSHED_EVENT = "falcon:risk-pushed";

export function buildRiskAccountPush(account: PaperAccount = readPaperAccount(), demo: boolean = isDemoMode(), now: Date = new Date()): RiskAccountPush {
  return {
    account: "paper",
    cash: Number.isFinite(account.cash) ? account.cash : 0,
    positions: Object.values(account.positions ?? {})
      .filter((p) => p && typeof p.symbol === "string" && Number.isFinite(p.shares) && Math.abs(p.shares) > 1e-9)
      .map((p) => ({ ticker: p.symbol.toUpperCase(), shares: p.shares, cost_usd: p.costUsd, market_value: null })),
    as_of: now.toISOString(),
    demo,
  };
}

/**
 * Fired (window) when the sync state changes: a push or the recompute after it
 * failed, or recovered. Read the state with `readRiskSyncState`.
 */
export const RISK_SYNC_EVENT = "falcon:risk-sync";

let lastDemo: boolean | null = null;
let active: RiskSync | null = null;
const IDLE: RiskSyncState = { failed: false };

/** Whether the last push (or the recompute it asked for) failed. */
export function readRiskSyncState(): RiskSyncState {
  return active?.state() ?? IDLE;
}

/** The card's Try again: push the account again and ask for a score. */
export function retryRiskSync(): void {
  void active?.retry();
}

function push(): void {
  if (!active) return;
  const demo = isDemoMode();
  const demoToggled = lastDemo !== null && lastDemo !== demo;
  lastDemo = demo;
  // Demo on/off resolves immediately on the host → worth a loading state.
  // Real-account edits are debounced 60s; the old score stays visible.
  if (demoToggled) window.dispatchEvent(new CustomEvent(RISK_PENDING_EVENT));
  void active.sync();
}

/** Starts the bridge; returns an unsubscribe function. */
export function startRiskAccountBridge(): () => void {
  const bridge = window.meridian;
  if (!bridge?.updateRiskAccount || !bridge.getRiskLatest) return () => {};
  const sync = createRiskSync({
    bridge,
    build: () => buildRiskAccountPush(readPaperAccount(), isDemoMode()),
    onState: () => window.dispatchEvent(new CustomEvent(RISK_SYNC_EVENT)),
    onPushed: () => window.dispatchEvent(new CustomEvent(RISK_PUSHED_EVENT)),
  });
  active = sync;
  lastDemo = null;
  push();
  const unsubscribe = subscribePaperAccount(push);
  return () => {
    unsubscribe();
    sync.dispose();
    if (active === sync) active = null;
    window.dispatchEvent(new CustomEvent(RISK_SYNC_EVENT));
  };
}
