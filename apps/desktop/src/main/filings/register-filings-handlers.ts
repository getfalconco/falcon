import path from "node:path";
import { resolveDataRoot } from "../data-root";
import { registerIpcHandler } from "../ipc-register";
import { filingDocument, filingHistory } from "../agents/edgar";
import { graphEdges } from "../research/graph-edges";
import { noteHeldNames } from "../guidance/register-guidance-handlers";
import {
  parseChangesRequest,
  parseOverviewRequest,
  type FilingChangesResult,
  type FilingOverviewResult,
} from "../../shared/filing-changes";
import { createFilingParser } from "./parse-pool";
import { spawnParseWorker } from "./parse-worker-spawn";
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
/** The dashboard's background reads (10-Ks of ten megabytes and more) wait this long after launch. */
const BACKGROUND_HOLD_MS = 60_000;
/** And pause this long between two held names, so a first look at forty names does not hold the SEC queue. */
const BACKGROUND_GAP_MS = 2_000;
/** The watchlist comes after every held name, this far apart (three 10-K/10-Q documents a name, up to 15 MB each). */
const WATCHLIST_GAP_MS = 30_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;
const startedAt = Date.now();
let lastPruneAt = 0;

let service: FilingsService | null = null;

/** Built on first use: the data root moves early in a packaged build's startup. */
export function filings(): FilingsService {
  if (!service) {
    service = createFilingsService({
      dir: path.join(resolveDataRoot(), "filings"),
      filings: filingHistory,
      document: (f) => filingDocument({ ...f, acceptedAt: null }),
      graphEdges,
      backgroundStartAt: startedAt + BACKGROUND_HOLD_MS,
      backgroundGapMs: BACKGROUND_GAP_MS,
      watchlistGapMs: WATCHLIST_GAP_MS,
      // Parsing runs in a worker thread; on the main thread only if the worker cannot start.
      parse: createFilingParser({ spawn: spawnParseWorker }).parse,
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
    // The guidance pre-read follows the held names the dashboard last showed (never the watchlist).
    noteHeldNames(parsed.held);
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
      if (Date.now() - lastPruneAt >= PRUNE_EVERY_MS) {
        lastPruneAt = Date.now();
        void filings()
          .prune()
          .then((n) => {
            if (n.changes + n.texts + n.digests > 0) console.info(`[filings] pruned ${n.changes} answers, ${n.texts} texts, ${n.digests} digests`);
          });
      }
    } catch (err) {
      console.warn("[filings] refresh failed:", err instanceof Error ? err.message : String(err));
    }
  };
  setTimeout(refresh, FIRST_REFRESH_MS).unref?.();
  setInterval(refresh, REFRESH_EVERY_MS).unref?.();
}
