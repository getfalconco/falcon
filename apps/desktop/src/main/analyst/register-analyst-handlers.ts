import { registerIpcHandler } from "../ipc-register";
import { getAnalystHost } from "./analyst-host";

/**
 * Analyst IPC surface (spec §9 panel + §11 observability + the Phase A
 * switch). Everything here reads the host; the only writes are the loop
 * switch and a manual cycle. `analystSurfacingEnabled` (Phase B) is shown
 * but not toggled from here — it flips only after the rubric gate.
 */
export function registerAnalystHandlers(): void {
  const host = getAnalystHost();

  registerIpcHandler("analyst:status", () => {
    try {
      return { ok: true as const, status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler(
    "analyst:outputs",
    (
      _event,
      options?: {
        limit?: number;
        status?: "ok" | "failed";
        kind?: "anomaly_review" | "scheduled_brief";
        cause?: "identified" | "partially_identified" | "unidentified";
        edge_status?: "no_edge" | "potential_edge" | "watch";
        ticker?: string;
        currentOnly?: boolean;
      },
    ) => {
      try {
        return { ok: true as const, outputs: host.listOutputs({ limit: 200, ...(options ?? {}) }) };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  registerIpcHandler("analyst:output-detail", (_event, incidentId: string, requestId: string) => {
    try {
      const detail = host.outputDetail(String(incidentId), String(requestId));
      if (!detail) return { ok: false as const, error: "output not found" };
      return { ok: true as const, detail };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler(
    "analyst:run-cycle",
    async (_event, options?: { limit?: number; dryRun?: boolean; maxRequests?: number }) => {
      try {
        const run = await host.runCycle(options ?? {});
        return { ok: true as const, run, status: host.status() };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  registerIpcHandler("analyst:set-enabled", (_event, enabled: boolean) => {
    try {
      host.setEnabled(Boolean(enabled));
      return { ok: true as const, status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Start the Phase A loop if the config enables it. */
export function bootstrapAnalyst(): void {
  getAnalystHost().start();
}
