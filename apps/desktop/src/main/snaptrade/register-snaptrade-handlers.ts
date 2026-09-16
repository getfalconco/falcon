import { shell } from "electron";
import { registerIpcHandler } from "../ipc-register";
import {
  getBrokerageNetWorth,
  getConnectionUrl,
  isSnaptradeConfigured,
  listBrokerages,
} from "./snaptrade-service";
import {
  isWorkerConfigured,
  workerBrokerageConnectUrl,
  workerBrokerageNetWorth,
  workerListBrokerages,
} from "../worker-api";

/**
 * Two ways to reach SnapTrade: directly, when this process holds the SnapTrade
 * keys (development, `.env`), or through the research-worker, which holds them
 * on the user's behalf (packaged builds carry no keys). Same IPC surface either
 * way; the renderer can't tell the difference.
 */
function viaWorker(): boolean {
  return !isSnaptradeConfigured() && isWorkerConfigured();
}

export function registerSnaptradeHandlers(): void {
  registerIpcHandler("snaptrade:brokerages", async (_event, accessToken?: string) => {
    if (viaWorker()) {
      try {
        const { configured, brokerages } = await workerListBrokerages(accessToken);
        if (!configured) {
          return { ok: false as const, configured: false as const, error: "SnapTrade is not configured." };
        }
        return { ok: true as const, configured: true as const, brokerages };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[snaptrade] worker listBrokerages error:", message);
        return { ok: false as const, configured: true as const, error: message };
      }
    }
    if (!isSnaptradeConfigured()) {
      return {
        ok: false as const,
        configured: false as const,
        error: "SnapTrade is not configured.",
      };
    }
    try {
      const brokerages = await listBrokerages();
      return { ok: true as const, configured: true as const, brokerages };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[snaptrade] listBrokerages error:", message);
      return { ok: false as const, configured: true as const, error: message };
    }
  });

  registerIpcHandler("snaptrade:networth", async (_event, accessToken?: string) => {
    try {
      const networth = viaWorker()
        ? await workerBrokerageNetWorth(accessToken)
        : await getBrokerageNetWorth(accessToken);
      return { ok: true as const, networth };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[snaptrade] networth error:", message);
      return { ok: false as const, error: message };
    }
  });

  registerIpcHandler(
    "snaptrade:connect",
    async (_event, options?: { broker?: string; accessToken?: string }) => {
      const useWorker = viaWorker();
      if (!useWorker && !isSnaptradeConfigured()) {
        return {
          ok: false as const,
          configured: false as const,
          error: "SnapTrade is not configured.",
        };
      }
      try {
        const url = useWorker
          ? await workerBrokerageConnectUrl(options?.broker, options?.accessToken)
          : await getConnectionUrl(options?.broker, options?.accessToken);
        // SnapTrade portal URLs are always https; never hand anything else to the OS.
        if (!/^https:\/\//i.test(url)) {
          throw new Error("SnapTrade returned an unexpected connection URL.");
        }
        await shell.openExternal(url);
        return { ok: true as const, configured: true as const, url };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[snaptrade] connect error:", message);
        return { ok: false as const, configured: true as const, error: message };
      }
    },
  );
}
