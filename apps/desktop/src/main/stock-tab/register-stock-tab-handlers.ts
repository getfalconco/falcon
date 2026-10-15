import { resolveDataRoot } from "../data-root";
import { registerIpcHandler } from "../ipc-register";
import { getRendererSession } from "../session-bridge";
import { userKeyFromAccessToken } from "../briefing/user-key";
import { filingForm, graphEdges } from "../research/graph-edges";
import { createThesisStore, type ThesisStore } from "./thesis-store";
import { holdingsOneHop, parseStockContextRequest, type StockContextResult } from "../../shared/stock-context";
import type { StockThesisResult } from "../../shared/stock-thesis";

/**
 * The Stock tab's own IPC surface (the header and the thesis):
 *
 *   stock:context      { ticker, held }   which holdings stand one filing hop away
 *   stock:thesis:get   ticker             the reader's thesis for it, or null
 *   stock:thesis:set   ticker, text       saves it; empty text clears it
 *
 * The thesis is the account's own words, kept per account under the data
 * root (thesis-store.ts); the account is the one the session bridge names.
 */

let theses: ThesisStore | null = null;

/** Built on first use: the data root moves early in a packaged build's startup. */
function store(): ThesisStore {
  if (!theses) {
    theses = createThesisStore({
      root: resolveDataRoot(),
      userKey: () => userKeyFromAccessToken(getRendererSession().accessToken),
    });
  }
  return theses;
}

export function registerStockTabHandlers(): void {
  registerIpcHandler("stock:context", async (_event, request: unknown): Promise<StockContextResult> => {
    const parsed = parseStockContextRequest(request);
    if (!parsed) return { ok: false, error: "invalid_request" };
    try {
      return { ok: true, links: holdingsOneHop(await graphEdges(), parsed.ticker, parsed.held, filingForm) };
    } catch (err) {
      console.warn("[stock-tab] context failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });

  registerIpcHandler("stock:thesis:get", (_event, ticker: unknown): StockThesisResult => {
    try {
      return store().get(ticker);
    } catch (err) {
      console.warn("[stock-tab] thesis read failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });

  registerIpcHandler("stock:thesis:set", (_event, ticker: unknown, text: unknown): StockThesisResult => {
    try {
      return store().set(ticker, text);
    } catch (err) {
      console.warn("[stock-tab] thesis write failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });
}
