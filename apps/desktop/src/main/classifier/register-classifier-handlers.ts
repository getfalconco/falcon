import { registerIpcHandler } from "../ipc-register";
import { getClassifierHost } from "./classifier-host";

/**
 * Classifier IPC surface (spec §12 observability + Phase A/B controls).
 * Everything here reads the host; the only writes are the two switches
 * (loop enabled, re-score enabled), a manual cycle, and a metadata refresh.
 */
export function registerClassifierHandlers(): void {
  const host = getClassifierHost();

  registerIpcHandler("classifier:status", () => {
    try {
      return { ok: true as const, status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("classifier:verdicts", (_event, options?: { limit?: number }) => {
    try {
      return { ok: true as const, verdicts: host.listVerdicts(options?.limit ?? 200) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler(
    "classifier:run-cycle",
    async (_event, options?: { limit?: number; dryRun?: boolean; maxRequests?: number }) => {
      try {
        const run = await host.runCycle(options ?? {});
        return { ok: true as const, run, status: host.status() };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  registerIpcHandler("classifier:set-enabled", (_event, enabled: boolean) => {
    try {
      host.setEnabled(Boolean(enabled));
      return { ok: true as const, status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("classifier:set-rescore", (_event, enabled: boolean) => {
    try {
      host.setRescoreEnabled(Boolean(enabled));
      return { ok: true as const, status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("classifier:refresh-metadata", async (_event, force?: boolean) => {
    try {
      const result = await host.refreshMetadata(Boolean(force));
      return { ok: true as const, ...result, status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("classifier:eval", async (_event, file: string) => {
    try {
      const report = await host.runEval(file);
      return { ok: true as const, report };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Start the Phase A loop if the config enables it. */
export function bootstrapClassifier(): void {
  getClassifierHost().start();
}
