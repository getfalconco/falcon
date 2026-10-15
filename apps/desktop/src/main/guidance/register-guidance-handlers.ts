import path from "node:path";
import { anthropicGlossCaller, glossConfigured } from "@meridian/research/gloss";
import { resolveDataRoot } from "../data-root";
import { registerIpcHandler } from "../ipc-register";
import { cachedFilingHistory, daysBefore, filingFile, filingHistory } from "../agents/edgar";
import { normalizeTicker } from "../../shared/calendar-events";
import type { GuidanceTrackResult } from "../../shared/guidance-types";
import { guidancePeekAnswer } from "./guidance-peek";
import { createGuidancePrefetch, type GuidancePrefetch } from "./guidance-prefetch";
import { RELEASES, createGuidanceService, earningsReleases, type GuidanceService } from "./guidance-service";

/**
 * Guidance track record IPC (the Stock tab's guidance section, the Earnings
 * drawer's pattern lines):
 *
 *   stocktab:guidance        ticker   what the company's last earnings releases
 *                                     guided against what it then reported
 *   stocktab:guidancePeek    ticker   the same from what is already on disk:
 *                                     never an EDGAR read, never a model call
 *                                     (the Calendar tab's event card)
 *
 * The model call and every SEC read happen here; the key never leaves this
 * process. Readings are kept under `<data root>/guidance/`, one file per
 * release accession.
 *
 * While Falcon runs, a held name's new earnings release is also read in the
 * background (guidance-prefetch.ts): noticed from the EDGAR index the other
 * modules already read, at most ten reads a day, so the morning handover
 * finds it on disk.
 */

/** The first pre-read pass waits for the other modules' first EDGAR reads. */
const FIRST_PREFETCH_MS = 5 * 60_000;
const PREFETCH_EVERY_MS = 30 * 60_000;

let service: GuidanceService | null = null;
let prefetch: GuidancePrefetch | null = null;

/** Built on first use: the data root moves early in a packaged build's startup. Also read by the briefing (`peek` only). */
export function guidance(): GuidanceService {
  if (!service) {
    service = createGuidanceService({
      // A heavy filer (a bank's structured notes) keeps only a year of filings in the index's newest page.
      filings: (ticker) =>
        filingHistory(ticker, { since: daysBefore(RELEASES * 92 + 60), enough: (list) => earningsReleases(list).length >= RELEASES }),
      file: filingFile,
      caller: anthropicGlossCaller,
      configured: glossConfigured,
      dir: path.join(resolveDataRoot(), "guidance"),
    });
  }
  return service;
}

function prefetcher(): GuidancePrefetch {
  if (!prefetch) {
    prefetch = createGuidancePrefetch({
      guidance: guidance(),
      cachedFilings: cachedFilingHistory,
      configured: glossConfigured,
      file: path.join(resolveDataRoot(), "guidance", "prefetch.json"),
    });
  }
  return prefetch;
}

/** The reader's held names (never the watchlist), from a module the renderer hands them to. */
export function noteHeldNames(tickers: readonly string[]): void {
  try {
    prefetcher().noteHeld(tickers);
  } catch (err) {
    console.warn(`[guidance] held names not noted: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  registerIpcHandler("stocktab:guidancePeek", (_event, request: unknown) => guidancePeekAnswer(request, guidance()));
  const sweep = () => void prefetcher().sweep();
  setTimeout(sweep, FIRST_PREFETCH_MS).unref?.();
  setInterval(sweep, PREFETCH_EVERY_MS).unref?.();
}
