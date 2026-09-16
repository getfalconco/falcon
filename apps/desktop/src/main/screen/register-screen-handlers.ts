import { registerIpcHandler } from "../ipc-register";
import { getScreenHost, wireScreenHost } from "./screen-host";

/**
 * Screen IPC surface (spec §7 Shift+S panel). Reads the host; the only write
 * is a manual rescan of the last completed session (idempotent).
 */
export function registerScreenHandlers(): void {
  // First touch of the shared host here — wire the push before it is built.
  wireScreenHost();
  const host = getScreenHost();

  registerIpcHandler("screen:status", () => {
    try {
      return { ok: true as const, status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("screen:findings", () => {
    try {
      return { ok: true as const, ...host.findings() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });


  /** S1: the renderer owns the watchlist, the emit gate needs it in main. */
  registerIpcHandler("screen:set-watchlist", (_event, tickers: string[]) => {
    try {
      host.setWatchlist(Array.isArray(tickers) ? tickers : []);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** S1: what Screen has emitted into the pipeline (panel + debugging). */
  registerIpcHandler("screen:emitted", (_event, options?: { limit?: number; ticker?: string }) => {
    try {
      return { ok: true as const, messages: host.messageStore.read({ limit: options?.limit ?? 200, ticker: options?.ticker }) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("screen:rescan", async () => {
    try {
      const scan = await host.rescanNow();
      return { ok: true as const, scan, ...host.findings() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

export function bootstrapScreen(): void {
  getScreenHost().start();
}
