import { registerIpcHandler } from "../ipc-register";
import { fetchOptionChain } from "../stock/market-data-service";
import { bulkFor } from "../stock/request-gate";
import { SOURCE_TIMEOUT_MS, withTimeout } from "../earnings/earnings-service";
import { stockReportHistory } from "../stock-tab-data/register-stock-tab-data-handlers";
import { parseImpliedRequest, type ImpliedMovesResult } from "../../shared/implied-move";
import { createImpliedMoveService, type ImpliedMoveService } from "./implied-move-service";

/**
 * Implied move IPC (Earnings tab rows and drawer, Stock tab earnings section).
 *
 *   earnings:implied  [{ ticker, date, time }]
 *       For each upcoming report: the move the listed options price for it
 *       (the at the money straddle of the first expiry covering the report,
 *       less the ordinary sessions read from the next expiry), and how the
 *       stock moved on its own last reports against it. Null for a name with
 *       no usable option quotes. See implied-move-service.ts for how often
 *       the option chains are read.
 *
 * Anything that goes wrong is logged here and answered with a fixed code.
 */

let service: ImpliedMoveService | null = null;

function implied(): ImpliedMoveService {
  if (!service) {
    service = createImpliedMoveService({
      fetchChain: fetchOptionChain,
      // Under the earnings reads' deadline: the history is a footnote to the figure, never worth holding it.
      reportMoves: async (symbol) =>
        (await withTimeout(stockReportHistory(symbol), SOURCE_TIMEOUT_MS, "report history")).flatMap((r) =>
          r.move !== null ? [{ date: r.date, move: r.move }] : [],
        ),
    });
  }
  return service;
}

export function registerImpliedMoveHandlers(): void {
  registerIpcHandler("earnings:implied", async (_event, request: unknown): Promise<ImpliedMovesResult> => {
    const reqs = parseImpliedRequest(request);
    if (!reqs) return { ok: false, error: "invalid_request" };
    try {
      return { ok: true, moves: await bulkFor(reqs.length, () => implied().many(reqs)) };
    } catch (err) {
      console.warn("[options] implied moves failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });
}
