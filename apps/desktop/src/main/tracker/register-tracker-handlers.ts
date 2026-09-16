import { BrowserWindow } from "electron";
import { getTrackerEngine } from "@meridian/research/tracker";
import type { TrackerMessage } from "@meridian/research/tracker";
import { registerIpcHandler } from "../ipc-register";
import { deactivateRemoteTicker, loadRemoteUniverse, pushRemoteUniverse } from "./universe-sync";


export function registerTrackerHandlers(): void {
  const engine = getTrackerEngine();

  registerIpcHandler("tracker:status", () => {
    return { ok: true as const, status: engine.getStatus() };
  });

  registerIpcHandler(
    "tracker:messages",
    (_event, options?: { limit?: number; ticker?: string }) => {
      try {
        return { ok: true as const, messages: engine.listMessages(options) };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  registerIpcHandler("tracker:config", () => {
    return { ok: true as const, config: engine.getConfig() };
  });

  // Full raw state — every series the engine holds, nothing summarized away.
  registerIpcHandler("tracker:ticker-state", (_event, ticker: string) => {
    const state = engine.getTickerState(ticker);
    if (!state) return { ok: false as const, error: `${ticker} is not tracked` };
    return { ok: true as const, state, dataDir: engine.getDataDir() };
  });

  registerIpcHandler("tracker:benchmark-bars", () => {
    return { ok: true as const, benchmark: engine.getBenchmarkBars() };
  });

  registerIpcHandler("tracker:quant", async (_event, ticker: string) => {
    try {
      const quant = await engine.getQuantContext(ticker);
      if (!quant) return { ok: false as const, error: `${ticker} is not tracked` };
      return { ok: true as const, quant };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("tracker:add-ticker", async (_event, ticker: string) => {
    try {
      await engine.addTicker(ticker);
      return { ok: true as const, status: engine.getStatus() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("tracker:remove-ticker", (_event, ticker: string) => {
    engine.removeTicker(ticker);
    return { ok: true as const, status: engine.getStatus() };
  });

  registerIpcHandler("tracker:recompute", async () => {
    try {
      const result = await engine.recomputeCloseState();
      return { ok: true as const, ...result, status: engine.getStatus() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("tracker:run-cycle", async () => {
    try {
      await engine.runCycle();
      return { ok: true as const, status: engine.getStatus() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Start the engine and forward every emitted message to the renderer. */
export function bootstrapTracker(): void {
  const engine = getTrackerEngine();

  engine.onMessage((message: TrackerMessage) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send("tracker:event", message);
    }
  });

  // Mirror local universe changes to the server so every install converges.
  // Writes are queued until the renderer has handed over the user's token.
  engine.onUniverseChange((event) => {
    if (event.type === "add") pushRemoteUniverse([event.ticker], "desktop");
    else deactivateRemoteTicker(event.ticker);
  });

  void (async () => {
    // Pull the server universe first so start() merges it with local discovery;
    // a fresh install then tracks the shared list, not just its own holdings.
    // Reads need only the anon key; it may arrive from the renderer slightly
    // after boot, so retry once when the first attempt had no endpoint yet.
    let remote = await loadRemoteUniverse();
    if (!remote) {
      await new Promise((r) => setTimeout(r, 4_000));
      remote = await loadRemoteUniverse();
    }
    engine.setRemoteUniverse(remote);
    await engine.start();
    // State is in memory from here. In a packaged build this line is reached
    // seconds after the window opened — the universe pull above waits on the
    // renderer handing over its Supabase key — and the dashboard has already
    // asked once and been told the universe is empty. Say it is loaded now,
    // so anything that asked too early asks again.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("tracker:ready");
    }
    // Publish the merged local universe back, so the server is the superset
    // (first install with a populated cache seeds it for everyone else).
    if (remote) {
      const local = engine.getUniverse();
      const missing = local.filter((t) => !remote.active.includes(t) && !remote.inactive.includes(t));
      if (missing.length > 0) {
        pushRemoteUniverse(missing, "discovery");
        console.info(`[tracker] universe server: queued ${missing.length} local ticker(s) for publish`);
      }
    }
  })().catch((err) => {
    console.error("[tracker] failed to start:", err);
  });
}
