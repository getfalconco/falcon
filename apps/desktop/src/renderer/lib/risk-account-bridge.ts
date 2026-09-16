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
 */

import { isDemoMode } from "@/lib/demo-mode";
import { readPaperAccount, subscribePaperAccount, type PaperAccount } from "@/lib/paper-account";
import type { RiskAccountPush } from "../../shared/risk-types";

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

let lastDemo: boolean | null = null;

function push(): void {
  const bridge = window.meridian;
  if (!bridge?.updateRiskAccount) return;
  const demo = isDemoMode();
  const demoToggled = lastDemo !== null && lastDemo !== demo;
  lastDemo = demo;
  try {
    // Demo on/off resolves immediately on the host → worth a loading state.
    // Real-account edits are debounced 60s; the old score stays visible.
    if (demoToggled) window.dispatchEvent(new CustomEvent(RISK_PENDING_EVENT));
    void bridge.updateRiskAccount(buildRiskAccountPush(readPaperAccount(), demo)).then(() => {
      window.dispatchEvent(new CustomEvent(RISK_PUSHED_EVENT));
    });
  } catch {
    /* best-effort — the host keeps the last pushed account */
  }
}

/** Starts the bridge; returns an unsubscribe function. */
export function startRiskAccountBridge(): () => void {
  push();
  return subscribePaperAccount(push);
}
