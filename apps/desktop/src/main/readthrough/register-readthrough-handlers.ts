import path from "node:path";
import { resolveDataRoot } from "../data-root";
import { invokeChannel, registerIpcHandler } from "../ipc-register";
import { earningsReaders } from "../earnings/register-earnings-handlers";
import { SOURCE_TIMEOUT_MS, withTimeout } from "../earnings/earnings-service";
import { fetchStockChartRange } from "../stock/market-data-service";
import { filingForm, graphEdges } from "../research/graph-edges";
import type { EarningsResult } from "../../shared/earnings-types";
import { parseReadthroughRequest, type ReadthroughResult } from "../../shared/readthrough-types";
import { fetchReleaseFilings } from "./releases";
import { createReadthroughService, type ReadthroughService } from "./readthrough-service";

/**
 * Read-through radar IPC surface.
 *
 *   readthrough:radar  { held, watchlist } | { focus, held?, watchlist? }
 *       For the reader's names: each filing-linked supplier, customer or
 *       competitor with a report in the next four weeks or the last week,
 *       with how the name has moved on that company's past report days
 *       (event-study.ts). With `focus`, every link of that one name,
 *       measured whatever the dates (the Stock tab).
 *
 * The provider reads stay in this process; a failure is logged here and
 * answered with a fixed code.
 */

let service: ReadthroughService | null = null;

const fetchDaily: typeof fetchStockChartRange = (symbol, startSec, endSec) =>
  withTimeout(fetchStockChartRange(symbol, startSec, endSec), SOURCE_TIMEOUT_MS, "daily closes");

/** Built on first use: the data root moves early in a packaged build's startup. */
export function readthrough(): ReadthroughService {
  if (!service) {
    service = createReadthroughService({
      dir: path.join(resolveDataRoot(), "readthrough"),
      graphEdges,
      formOf: filingForm,
      upcoming: async (tickers, days) => {
        // The Earnings tab's own answer with the linked companies as the names: same caches, same rows.
        const answer = await invokeChannel<EarningsResult>("earnings:upcoming", { scope: "mine", days, held: tickers, watchlist: [] });
        if (!answer || answer.ok !== true) throw new Error("report dates unavailable");
        return answer.rows;
      },
      quarters: async (symbol) => (await earningsReaders().read(symbol))?.quarters ?? null,
      releases: (symbol) => withTimeout(fetchReleaseFilings(symbol), SOURCE_TIMEOUT_MS, "release filings"),
      fetchDaily,
    });
  }
  return service;
}

export function registerReadthroughHandlers(): void {
  registerIpcHandler("readthrough:radar", async (_event, request: unknown): Promise<ReadthroughResult> => {
    const parsed = parseReadthroughRequest(request);
    if (!parsed) return { ok: false, error: "invalid_request" };
    try {
      return await readthrough().radar(parsed);
    } catch (err) {
      console.warn("[readthrough] radar failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });
}
