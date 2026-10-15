/**
 * One ask of `earnings:upcoming`, read so a main process older than this
 * renderer still gives the reader a list.
 *
 * In development the renderer reloads on every save while the main process
 * keeps running the code it started with, and a packaged update can do the
 * same for a moment. A main process from before "For you" rejects that scope
 * as an invalid request (its parser knows mine, tracked and all), and one
 * from before the Earnings tab has no handler at all. Both used to read as
 * "Earnings dates could not be loaded", with nothing the reader could do.
 *
 *   - No handler, or no bridge method: "restart", which the views word as
 *     "Restart Falcon to load earnings dates."
 *   - "For you" turned down as invalid although this renderer builds it
 *     correctly: the reader's own names are asked for instead (scope "mine",
 *     which every main process with the channel knows) and shown with a note
 *     that a restart brings the full list back.
 *   - Any other request turned down as invalid: "restart".
 *
 * Pure apart from the `ask` it is given, so the paths can be tested in node.
 */

import { parseEarningsRequest, type EarningsRequest, type EarningsResult, type EarningsRow } from "../../shared/earnings-types";

/** An answer as the views read it: `outdatedMain` marks one put together for a main process that needs a restart. */
export type EarningsAnswer = Extract<EarningsResult, { ok: true }> & { outdatedMain?: boolean };

export type EarningsLoad = { ok: true; value: EarningsAnswer } | { ok: false; error: string };

export type EarningsAsk = (request: EarningsRequest) => Promise<EarningsResult | null | undefined>;

/** Electron's rejection when the main process registered no handler for the channel. */
export function isMissingHandler(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /No handler registered/i.test(message);
}

/**
 * Fills the fields a main process older than this renderer leaves out, so
 * the views never read undefined: a row's reason (from the reader's own
 * names, when the list stands in for "For you") and market value, and the
 * answer's list of reads that failed.
 */
function normalize(res: Extract<EarningsResult, { ok: true }>, request: EarningsRequest, outdatedMain: boolean): EarningsAnswer {
  const held = new Set(request.held ?? []);
  const watch = new Set(request.watchlist ?? []);
  const forYou = request.scope === "foryou";
  const rows: EarningsRow[] = (Array.isArray(res.rows) ? res.rows : []).map((row) => {
    const reason = row.reason ?? (forYou ? (held.has(row.ticker) || row.held ? "held" : watch.has(row.ticker) || row.watchlist ? "watchlist" : null) : null);
    return { ...row, reason, marketCap: row.marketCap ?? null, readsThrough: Array.isArray(row.readsThrough) ? row.readsThrough : [] };
  });
  return {
    ...res,
    scope: request.scope,
    rows,
    unavailable: Array.isArray(res.unavailable) ? res.unavailable : [],
    degraded: Array.isArray(res.degraded) ? res.degraded : [],
    ...(outdatedMain ? { outdatedMain: true } : {}),
  };
}

async function askOnce(ask: EarningsAsk, request: EarningsRequest): Promise<EarningsResult | { ok: false; error: "restart" | "unavailable" }> {
  try {
    return (await ask(request)) ?? { ok: false, error: "unavailable" };
  } catch (err) {
    return { ok: false, error: isMissingHandler(err) ? "restart" : "unavailable" };
  }
}

export async function loadEarnings(ask: EarningsAsk | undefined, request: EarningsRequest): Promise<EarningsLoad> {
  if (typeof ask !== "function") return { ok: false, error: "restart" };
  const res = await askOnce(ask, request);
  if (res.ok) return { ok: true, value: normalize(res, request, false) };
  // This renderer only sends requests its own parser takes; main turning one
  // down means main runs older code.
  if (res.error === "invalid_request" && parseEarningsRequest(request) !== null) {
    if (request.scope === "foryou") {
      const older = await askOnce(ask, { scope: "mine", days: request.days, held: request.held, watchlist: request.watchlist });
      if (older.ok) return { ok: true, value: normalize(older, request, true) };
    }
    return { ok: false, error: "restart" };
  }
  return { ok: false, error: res.error ?? "unavailable" };
}
