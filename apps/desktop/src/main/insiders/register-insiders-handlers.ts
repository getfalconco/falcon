import path from "node:path";
import { resolveDataRoot } from "../data-root";
import { registerIpcHandler } from "../ipc-register";
import { filingFile, filingHistory } from "../agents/edgar";
import { graphEdges } from "../research/graph-edges";
import { parseInsiderRequest, type InsiderActivityResult } from "../../shared/insider-types";
import { createInsidersService, type InsidersService } from "./insiders-service";

/**
 * Insider activity IPC surface.
 *
 *   insiders:activity  "NVDA" | { ticker }          one company's events (the Stock tab);
 *                                                  waits up to 30 s for a first read
 *                      { held, watchlist }         the reader's names and their
 *                                                  filing-linked companies (the dashboard
 *                                                  card); answers at once with what is
 *                                                  read so far and `pending` for the rest
 *
 * The EDGAR reads stay in this process; a failure is logged here and
 * answered with a fixed code.
 */

let service: InsidersService | null = null;

/** Built on first use: the data root moves early in a packaged build's startup. */
export function insiders(): InsidersService {
  if (!service) {
    service = createInsidersService({
      dir: path.join(resolveDataRoot(), "insiders"),
      filings: filingHistory,
      file: filingFile,
      graphEdges,
    });
  }
  return service;
}

export function registerInsidersHandlers(): void {
  registerIpcHandler("insiders:activity", async (_event, request: unknown): Promise<InsiderActivityResult> => {
    const parsed = parseInsiderRequest(request);
    if (!parsed) return { ok: false, error: "invalid_request" };
    try {
      return await insiders().activity(parsed);
    } catch (err) {
      console.warn("[insiders] activity failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });
}
