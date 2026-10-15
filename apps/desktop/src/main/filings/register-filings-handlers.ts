import path from "node:path";
import { resolveDataRoot } from "../data-root";
import { registerIpcHandler } from "../ipc-register";
import { filingDocument, filingHistory } from "../agents/edgar";
import { graphEdges } from "../research/graph-edges";
import {
  parseChangesRequest,
  parseOverviewRequest,
  type FilingChangesResult,
  type FilingOverviewResult,
} from "../../shared/filing-changes";
import { createFilingsService, type FilingsService } from "./service";

/**
 * Filing changes IPC surface.
 *
 *   filings:changes   ticker | { ticker }
 *       One company's latest annual report against the one before, its
 *       latest 10-Q risk factor update and the red flags in its EDGAR index
 *       (the Stock tab). Read from EDGAR at most once a New York day.
 *   filings:overview  { held, watchlist }
 *       The notable changes across the reader's names from what is kept
 *       (the dashboard card); names not read today are read one at a time
 *       in the background and listed in `pending`.
 *
 * The names of the last overview are checked again every six hours while
 * Falcon runs; each is read from EDGAR at most once a day. They are kept in
 * memory only.
 */

const REFRESH_EVERY_MS = 6 * 60 * 60_000;
const FIRST_REFRESH_MS = 3 * 60_000;

let service: FilingsService | null = null;

/** Built on first use: the data root moves early in a packaged build's startup. */
export function filings(): FilingsService {
  if (!service) {
    service = createFilingsService({
      dir: path.join(resolveDataRoot(), "filings"),
      filings: filingHistory,
      document: (f) => filingDocument({ ...f, acceptedAt: null }),
      graphEdges,
    });
  }
  return service;
}

export function registerFilingsHandlers(): void {
  registerIpcHandler("filings:changes", async (_event, request: unknown): Promise<FilingChangesResult> => {
    const ticker = parseChangesRequest(request);
    if (!ticker) return { ok: false, error: "invalid_request" };
    try {
      return { ok: true, changes: await filings().changes(ticker) };
    } catch (err) {
      console.warn("[filings] changes failed:", ticker, err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });

  registerIpcHandler("filings:overview", async (_event, request: unknown): Promise<FilingOverviewResult> => {
    const parsed = parseOverviewRequest(request);
    if (!parsed) return { ok: false, error: "invalid_request" };
    try {
      return filings().overview(parsed);
    } catch (err) {
      console.warn("[filings] overview failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });

  const refresh = () => {
    try {
      filings().refreshDue();
    } catch (err) {
      console.warn("[filings] refresh failed:", err instanceof Error ? err.message : String(err));
    }
  };
  setTimeout(refresh, FIRST_REFRESH_MS).unref?.();
  setInterval(refresh, REFRESH_EVERY_MS).unref?.();
}
