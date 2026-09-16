import { registerIpcHandler } from "../ipc-register";
import { getPropagationHost, wirePropagationHost } from "./propagation-host";
import { onRendererSession } from "../session-bridge";

/**
 * Propagation IPC surface (spec §8 Shift+P panel + §11 observability + the
 * Phase A switch). Reads the host; the only writes are the loop switch and a
 * manual cycle. `propagationSurfacingEnabled` (Phase B) is shown, never
 * toggled from here. The legacy `signals:*` channels (old engine's stores)
 * are untouched.
 */
export function registerPropagationRunHandlers(): void {
  // First touch of the shared host in the main process: wire it here, before
  // risk/screen registration can reach for it.
  wirePropagationHost();
  const host = getPropagationHost();

  registerIpcHandler("propagation:status", () => {
    try {
      return { ok: true as const, status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler(
    "propagation:runs",
    (
      _event,
      options?: {
        limit?: number;
        status?: "ok" | "stage1_only" | "failed";
        ticker?: string;
        currentOnly?: boolean;
        openOnly?: boolean;
        /** Fixture runs: excluded by default; "only" for the fixtures section. */
        synthetic?: "exclude" | "only" | "all";
      },
    ) => {
      try {
        return { ok: true as const, runs: host.listRuns({ limit: 200, ...(options ?? {}) }) };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  registerIpcHandler("propagation:absorption", (_event, runId: string, targetKey: string) => {
    try {
      return { ok: true as const, curve: host.absorption(String(runId), String(targetKey)) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("propagation:run", (_event, runId: string) => {
    try {
      const run = host.getRun(String(runId));
      if (!run) return { ok: false as const, error: "run not found" };
      return { ok: true as const, run, chain: host.runsForIncident(run.incident_id) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler(
    "propagation:pair-history",
    (_event, options: { root: string; target: string }) => {
      try {
        const root = String(options?.root ?? "").trim();
        const target = String(options?.target ?? "").trim();
        if (!root || !target) return { ok: false as const, error: "root and target are required" };
        return { ok: true as const, history: host.pairHistory(root, target) };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  registerIpcHandler(
    "propagation:run-cycle",
    async (_event, options?: { limit?: number; dryRun?: boolean; maxRequests?: number; stage2?: boolean }) => {
      try {
        const run = await host.runCycle(options ?? {});
        return { ok: true as const, run, status: host.status() };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  registerIpcHandler("propagation:set-surfacing", (_event, enabled: boolean) => {
    try {
      host.setSurfacingEnabled(Boolean(enabled));
      return { ok: true as const, status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("propagation:set-enabled", (_event, enabled: boolean) => {
    try {
      host.setEnabled(Boolean(enabled));
      return { ok: true as const, status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Start the Phase A loop if the config enables it. */
export function bootstrapPropagation(): void {
  wirePropagationHost();
  const host = getPropagationHost();
  host.start();
  // Independent of the Phase A loop: the fast lane is how a second-order move
  // is caught while it is still open, so it arms even when the timer is off.
  host.watchTracker();
  // The shared runs, regardless of whether this install's engine is on. A
  // sign-in after boot brings the user token, which is what writes need.
  void host.syncRemoteRuns("boot");
  onRendererSession(() => {
    void host.syncRemoteRuns("session");
  });
}
