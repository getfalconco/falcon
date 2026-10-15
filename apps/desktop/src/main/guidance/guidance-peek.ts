import { normalizeTicker } from "../../shared/calendar-events";
import type { GuidancePeekResult } from "../../shared/guidance-types";
import type { GuidanceService } from "./guidance-service";

/**
 * The answer to `stocktab:guidancePeek`: the track record from disk alone.
 * Only `peek` is reachable here, so this path can never read EDGAR or call
 * the model. Electron-free, so the channel's checks are tested directly.
 */
export function guidancePeekAnswer(request: unknown, service: Pick<GuidanceService, "peek">): GuidancePeekResult {
  const ticker = normalizeTicker(request);
  if (!ticker) return { ok: false, error: "invalid_request" };
  try {
    return { ok: true, track: service.peek(ticker) };
  } catch (err) {
    console.warn(`[guidance] ${ticker} peek: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: "unavailable" };
  }
}
