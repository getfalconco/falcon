import { registerIpcHandler } from "../ipc-register";
import type { GaugeReadoutRequest } from "../../shared/gauge-types";
import { getGaugeHost } from "./gauge-host";

/**
 * Gauge IPC surface (spec §8): readouts for the Shift+F panel, the
 * Propagation drawer (context mode) and the stock page (standalone). Reads
 * only; the single write is a config reload from disk.
 */
export function registerGaugeHandlers(): void {
  const host = getGaugeHost();

  registerIpcHandler("gauge:readout", (_event, req: GaugeReadoutRequest) => {
    try {
      if (!req || typeof req.ticker !== "string") return { ok: false as const, error: "ticker required" };
      return { ok: true as const, ...host.readout(req) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("gauge:status", () => {
    try {
      return { ok: true as const, status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("gauge:tickers", () => {
    try {
      return { ok: true as const, tickers: host.tickers() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("gauge:reload-config", () => {
    try {
      host.reloadConfig();
      return { ok: true as const, status: host.status() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
