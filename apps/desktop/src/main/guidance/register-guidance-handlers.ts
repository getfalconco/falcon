import path from "node:path";
import { anthropicGlossCaller, glossConfigured } from "@meridian/research/gloss";
import { resolveDataRoot } from "../data-root";
import { registerIpcHandler } from "../ipc-register";
import { filingFile, filingHistory } from "../agents/edgar";
import { normalizeTicker } from "../../shared/calendar-events";
import type { GuidanceTrackResult } from "../../shared/guidance-types";
import { createGuidanceService, type GuidanceService } from "./guidance-service";

/**
 * Guidance track record IPC (the Stock tab's guidance section, the Earnings
 * drawer's pattern lines):
 *
 *   stocktab:guidance   ticker   what the company's last earnings releases
 *                                guided against what it then reported
 *
 * The model call and every SEC read happen here; the key never leaves this
 * process. Readings are kept under `<data root>/guidance/`, one file per
 * release accession.
 */

let service: GuidanceService | null = null;

/** Built on first use: the data root moves early in a packaged build's startup. */
function guidance(): GuidanceService {
  if (!service) {
    service = createGuidanceService({
      filings: filingHistory,
      file: filingFile,
      caller: anthropicGlossCaller,
      configured: glossConfigured,
      dir: path.join(resolveDataRoot(), "guidance"),
    });
  }
  return service;
}

export function registerGuidanceHandlers(): void {
  registerIpcHandler("stocktab:guidance", async (_event, request: unknown): Promise<GuidanceTrackResult> => {
    const ticker = normalizeTicker(request);
    if (!ticker) return { ok: false, error: "invalid_request" };
    try {
      return await guidance().track(ticker);
    } catch (err) {
      console.warn(`[guidance] ${ticker}: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: "unavailable" };
    }
  });
}
