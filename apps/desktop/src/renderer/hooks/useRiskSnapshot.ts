import { useCallback, useEffect, useRef, useState } from "react";
import type { RiskLatest } from "../../shared/risk-types";
import { RISK_PENDING_EVENT, RISK_PUSHED_EVENT } from "@/lib/risk-account-bridge";

export type RiskSnapshotState = {
  latest: RiskLatest | null;
  /** A push that will change the snapshot (demo on/off) is in flight. */
  pending: boolean;
};

/** How often to re-read the snapshot; the engine recomputes on its own triggers. */
const POLL_MS = 60_000;
/** A pending state never outlives this — a stuck spinner is worse than a stale score. */
const PENDING_TIMEOUT_MS = 15_000;

/**
 * The latest Risk Engine snapshot + the card flag (§8 card contract).
 *
 * Two sources, because the engine can be either process: the main-process
 * broadcast when the chain runs locally, and a poll of `risk:latest` when it
 * runs on the always-on service (which has no window to push to). Refreshes
 * immediately after an account push resolves, so Ctrl+P demo shows its real
 * score as soon as the host has computed it.
 */
export function useRiskSnapshot(): RiskSnapshotState {
  const [latest, setLatest] = useState<RiskLatest | null>(null);
  const [pending, setPending] = useState(false);
  const timeout = useRef<number | null>(null);

  const clearPending = useCallback(() => {
    if (timeout.current != null) window.clearTimeout(timeout.current);
    timeout.current = null;
    setPending(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const bridge = window.meridian;
    if (!bridge?.getRiskLatest) return;

    const refresh = () => {
      void bridge.getRiskLatest().then((res) => {
        if (cancelled || !res.ok) return;
        setLatest({ snapshot: res.snapshot, riskCardEnabled: res.riskCardEnabled, demo: res.demo });
        clearPending();
      });
    };

    refresh();
    const poll = window.setInterval(refresh, POLL_MS);
    const unsubscribe =
      bridge.onRiskSnapshot?.((payload) => {
        setLatest(payload);
        clearPending();
      }) ?? (() => {});

    const onPending = () => {
      setPending(true);
      if (timeout.current != null) window.clearTimeout(timeout.current);
      timeout.current = window.setTimeout(() => clearPending(), PENDING_TIMEOUT_MS);
    };
    window.addEventListener(RISK_PENDING_EVENT, onPending);
    window.addEventListener(RISK_PUSHED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      unsubscribe();
      window.removeEventListener(RISK_PENDING_EVENT, onPending);
      window.removeEventListener(RISK_PUSHED_EVENT, refresh);
      if (timeout.current != null) window.clearTimeout(timeout.current);
    };
  }, [clearPending]);

  return { latest, pending };
}
