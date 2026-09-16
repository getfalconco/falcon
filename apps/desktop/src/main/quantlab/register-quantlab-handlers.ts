import { registerIpcHandler } from "../ipc-register";
import { getQuantLabHost } from "./quantlab-host";

/**
 * Quant Lab IPC surface (§10, the Shift+Q panel).
 *
 * Reads plus three deliberate writes: running a backtest, toggling live
 * evaluation, and sweeping the ledger. Nothing here places an order, sizes a
 * position, or reaches the product UI.
 */
export function registerQuantLabHandlers(): void {
  const host = getQuantLabHost();

  const guard = <T>(fn: () => T) => {
    try {
      return { ok: true as const, ...(fn() as object) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  };

  registerIpcHandler("quantlab:status", () => guard(() => ({ status: host.status() })));

  registerIpcHandler("quantlab:strategies", () => guard(() => ({ strategies: host.strategies() })));

  registerIpcHandler("quantlab:reports", (_event, strategyId?: string) =>
    guard(() => ({ reports: host.reports(strategyId) })),
  );

  registerIpcHandler("quantlab:report", (_event, reportId: string) =>
    guard(() => ({ report: host.report(reportId) })),
  );

  registerIpcHandler("quantlab:backtest", (_event, options: { strategyId: string; from?: string; to?: string }) =>
    guard(() => ({ report: host.backtest(options.strategyId, { from: options.from, to: options.to }) })),
  );

  registerIpcHandler(
    "quantlab:set-live",
    (_event, options: { strategyId: string; version: number; enabled: boolean }) =>
      guard(() => {
        host.setLiveEnabled(options.strategyId, options.version, options.enabled);
        return { strategies: host.strategies() };
      }),
  );

  registerIpcHandler("quantlab:ledger", (_event, strategyId?: string) =>
    guard(() => ({ signals: host.ledger(strategyId) })),
  );

  registerIpcHandler("quantlab:sweep", () => guard(() => host.sweepLive()));

  registerIpcHandler("quantlab:reload", () =>
    guard(() => {
      host.reload();
      return { status: host.status() };
    }),
  );
}

export function bootstrapQuantLab(): void {
  getQuantLabHost().start();
}
