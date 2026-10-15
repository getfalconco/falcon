import { useCallback, useEffect, useRef, useState } from "react";
import type { RiskReadStatus } from "../../shared/risk-card";
import type { RiskLatest } from "../../shared/risk-types";
import {
  RISK_PENDING_EVENT,
  RISK_PUSHED_EVENT,
  RISK_SYNC_EVENT,
  readRiskSyncState,
  retryRiskSync,
} from "@/lib/risk-account-bridge";

export type RiskSnapshotState = {
  latest: RiskLatest | null;
  /** A push that will change the snapshot (demo on/off) is in flight. */
  pending: boolean;
  /** Where the read of `risk:latest` stands; `error` only matters while `latest` is null. */
  status: RiskReadStatus;
  /** The account push, or the recompute that follows it, failed (risk-account-bridge). */
  syncFailed: boolean;
  /** Read again and push the account again (the card's Try again). */
  retry: () => void;
};

/** How often to re-read the snapshot once there is one; the engine recomputes on its own triggers. */
const POLL_MS = 60_000;
/** While there is no snapshot yet (first score on its way, or the read failed), look again sooner. */
const POLL_WAITING_MS = 10_000;
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
 *
 * `risk:latest` is answered for the signed-in user only (the engine scopes it
 * by the session token). A failed read keeps whatever was last read; with
 * nothing read yet it reports `error`, and the card says so rather than
 * printing any number.
 */
export function useRiskSnapshot(): RiskSnapshotState {
  const [latest, setLatest] = useState<RiskLatest | null>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<RiskReadStatus>("loading");
  const [syncFailed, setSyncFailed] = useState(() => readRiskSyncState().failed);
  const timeout = useRef<number | null>(null);
  const refreshRef = useRef<() => void>(() => {});

  const clearPending = useCallback(() => {
    if (timeout.current != null) window.clearTimeout(timeout.current);
    timeout.current = null;
    setPending(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const bridge = window.meridian;
    if (!bridge?.getRiskLatest) {
      setStatus("error");
      return;
    }

    let pollTimer: number | null = null;
    let hasSnapshot = false;
    const schedule = () => {
      if (pollTimer != null) window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(refresh, hasSnapshot ? POLL_MS : POLL_WAITING_MS);
    };

    const refresh = () => {
      void bridge
        .getRiskLatest()
        .then((res) => {
          if (cancelled) return;
          if (!res.ok) {
            setStatus("error");
            return;
          }
          hasSnapshot = res.snapshot != null;
          setLatest({ snapshot: res.snapshot, riskCardEnabled: res.riskCardEnabled, demo: res.demo });
          setStatus("ready");
          clearPending();
        })
        .catch(() => {
          if (!cancelled) setStatus("error");
        })
        .finally(() => {
          if (!cancelled) schedule();
        });
    };
    refreshRef.current = refresh;

    refresh();
    const unsubscribe =
      bridge.onRiskSnapshot?.((payload) => {
        hasSnapshot = payload.snapshot != null;
        setLatest(payload);
        setStatus("ready");
        clearPending();
      }) ?? (() => {});

    const onPending = () => {
      setPending(true);
      if (timeout.current != null) window.clearTimeout(timeout.current);
      timeout.current = window.setTimeout(() => clearPending(), PENDING_TIMEOUT_MS);
    };
    const onSync = () => setSyncFailed(readRiskSyncState().failed);
    window.addEventListener(RISK_PENDING_EVENT, onPending);
    window.addEventListener(RISK_PUSHED_EVENT, refresh);
    window.addEventListener(RISK_SYNC_EVENT, onSync);
    onSync();
    return () => {
      cancelled = true;
      if (pollTimer != null) window.clearTimeout(pollTimer);
      unsubscribe();
      window.removeEventListener(RISK_PENDING_EVENT, onPending);
      window.removeEventListener(RISK_PUSHED_EVENT, refresh);
      window.removeEventListener(RISK_SYNC_EVENT, onSync);
      if (timeout.current != null) window.clearTimeout(timeout.current);
      refreshRef.current = () => {};
    };
  }, [clearPending]);

  const retry = useCallback(() => {
    setStatus((s) => (s === "error" ? "loading" : s));
    setSyncFailed(false);
    retryRiskSync();
    refreshRef.current();
  }, []);

  return { latest, pending, status, syncFailed, retry };
}
