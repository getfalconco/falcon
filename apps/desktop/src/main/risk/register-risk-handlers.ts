import { registerIpcHandler } from "../ipc-register";
import type { RiskAccountPush } from "../../shared/risk-types";
import { getRiskHost, wireRiskHost } from "./risk-host";

/**
 * Risk Engine IPC surface (spec §7 Shift+R panel + §8 card contract). Reads
 * the host; the only writes are the renderer's paper-account push (§5), a
 * manual recompute, and the card flag (config-only, flipped after the §9
 * calibration week).
 */
export function registerRiskHandlers(): void {
  // First touch of the shared host in this process — wire the snapshot push
  // before anything can build it.
  wireRiskHost();
  const host = getRiskHost();

  registerIpcHandler("risk:status", () => {
    try {
      return { ok: true as const, status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("risk:latest", () => {
    try {
      return { ok: true as const, ...host.latest() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("risk:history", (_event, options?: { limit?: number }) => {
    try {
      return { ok: true as const, history: host.history(options?.limit ?? 200) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("risk:recompute", async () => {
    try {
      await host.recomputeNow();
      return { ok: true as const, ...host.latest(), status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("risk:account-update", (_event, push: RiskAccountPush) => {
    try {
      if (!push || push.account !== "paper" || !Array.isArray(push.positions)) {
        return { ok: false as const, error: "invalid account payload" };
      }
      host.setAccount(push);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("risk:set-card-enabled", (_event, enabled: boolean) => {
    try {
      host.setCardEnabled(Boolean(enabled));
      return { ok: true as const, status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

export function bootstrapRisk(): void {
  getRiskHost().start();
}
