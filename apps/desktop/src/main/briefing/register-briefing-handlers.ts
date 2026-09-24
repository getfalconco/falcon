import { registerIpcHandler } from "../ipc-register";
import type {
  BriefingGetResult,
  BriefingNarrativeResult,
  BriefingWindowResult,
} from "../../shared/briefing-types";
import { getBriefing, getBriefingNarrative, getBriefingWindow } from "./briefing-service";

/**
 * Handover briefing IPC surface.
 *
 * Three channels, all local. They are deliberately not engine channels: the
 * report is built from the renderer's own paper account and from market data
 * this process already reads, and the parts that do live on the engine service
 * (the chain, the risk snapshot) are reached from inside the build through
 * `invokeChannel`.
 *
 * The service already answers with result unions and never throws. The catch
 * here is the last line of that promise: whatever goes wrong, the renderer
 * gets one of the fixed codes and the real error stays in this process's log,
 * because an error string is how a key or a provider's reply would cross over.
 */
export function registerBriefingHandlers(): void {
  registerIpcHandler("briefing:window", (): BriefingWindowResult => {
    try {
      return getBriefingWindow();
    } catch (err) {
      console.warn("[briefing] briefing:window failed:", err);
      return { ok: false, error: "unavailable" };
    }
  });

  registerIpcHandler("briefing:get", async (_event, request: unknown): Promise<BriefingGetResult> => {
    try {
      return await getBriefing(request);
    } catch (err) {
      console.warn("[briefing] briefing:get failed:", err);
      return { ok: false, error: "build_failed" };
    }
  });

  registerIpcHandler("briefing:narrative", async (_event, request: unknown): Promise<BriefingNarrativeResult> => {
    try {
      return await getBriefingNarrative(request);
    } catch (err) {
      console.warn("[briefing] briefing:narrative failed:", err);
      return { ok: false, error: "unavailable" };
    }
  });
}
