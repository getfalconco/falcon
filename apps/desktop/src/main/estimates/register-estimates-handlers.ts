import path from "node:path";
import { resolveDataRoot } from "../data-root";
import { registerIpcHandler } from "../ipc-register";
import { fetchQuoteSummaryModules } from "../stock/market-data-service";
import { bulkFor } from "../stock/request-gate";
import { parseEstimatesRequest, type EstimatesResult } from "../../shared/estimate-revisions";
import { createEstimatesService, type EstimatesService } from "./estimates-service";

/**
 * Estimate revisions IPC (Earnings tab rows and drawer, Stock tab earnings
 * section).
 *
 *   earnings:estimates  string[]
 *       Per name: the mean EPS estimate for the current and next quarter and
 *       the fiscal year, its change over 7, 30 and 90 days, and how many
 *       analysts raised or lowered it in the last 30 days. Null for a name
 *       with no usable estimates. See estimates-service.ts for how often
 *       the provider is read.
 *
 * Anything that goes wrong is logged here and answered with a fixed code.
 */

let service: EstimatesService | null = null;

/** Built on first use: the data root moves early in a packaged build's startup. */
function estimates(): EstimatesService {
  if (!service) {
    service = createEstimatesService({
      dir: path.join(resolveDataRoot(), "estimates"),
      fetchTrend: (symbol) => fetchQuoteSummaryModules(symbol, ["earningsTrend"]),
    });
  }
  return service;
}

export function registerEstimatesHandlers(): void {
  registerIpcHandler("earnings:estimates", async (_event, request: unknown): Promise<EstimatesResult> => {
    const tickers = parseEstimatesRequest(request);
    if (!tickers) return { ok: false, error: "invalid_request" };
    try {
      return { ok: true, estimates: await bulkFor(tickers.length, () => estimates().many(tickers)) };
    } catch (err) {
      console.warn("[estimates] request failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });
}
