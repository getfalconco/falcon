import { registerIpcHandler } from "../ipc-register";
import { filingForm, graphEdges, type GraphFileEdge } from "../research/graph-edges";
import { getUsStockCatalog } from "../stock/us-stock-catalog";
import {
  computeExposure,
  exposureRequestKey,
  parseExposureRequest,
  type ExposureRequest,
  type ExposureResult,
  type ExposureSummary,
} from "../../shared/exposure";

/**
 * Exposure tab and card IPC surface.
 *
 *   exposure:summary  { scope, holdings: [{ ticker, weight, fund }] }
 *       What the holdings depend on together, from the filing graph
 *       (shared/exposure.ts). The renderer sends the weights, computed the
 *       way the Positions card computes them, so both print one figure.
 *
 * The answer is kept per request (the scope and every weight at a tenth of a
 * point) and dropped as a whole when graph.json changes: graphEdges() hands
 * back the same array until the file's mtime moves, so a new array is a new
 * graph. Company names and which tickers the app can open come from the
 * listing directory the search bar uses; when it cannot be read in time the
 * names come from the filings and every ticker is offered.
 */

const CACHE_LIMIT = 16;
const CATALOG_WAIT_MS = 4_000;

let cachedFor: readonly GraphFileEdge[] | null = null;
const cache = new Map<string, ExposureSummary>();

let catalog: Map<string, string> | null = null;
let catalogAsk: Promise<Map<string, string> | null> | null = null;

/** Symbol to company name, or null when the directory cannot be read within the wait. */
function listing(): Promise<Map<string, string> | null> {
  if (catalog) return Promise.resolve(catalog);
  if (!catalogAsk) {
    catalogAsk = getUsStockCatalog()
      .then((list) => {
        catalog = new Map(list.map((e) => [e.symbol.toUpperCase(), e.companyName] as const));
        return catalog;
      })
      .catch(() => null)
      .finally(() => {
        catalogAsk = null;
      });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CATALOG_WAIT_MS);
  });
  return Promise.race([catalogAsk, wait]).finally(() => clearTimeout(timer));
}

export async function exposureSummary(request: ExposureRequest): Promise<ExposureSummary> {
  const edges = await graphEdges();
  if (edges !== cachedFor) {
    cache.clear();
    cachedFor = edges;
  }
  const key = exposureRequestKey(request);
  const known = cache.get(key);
  if (known) {
    // Most recently used last, so the oldest is the one dropped.
    cache.delete(key);
    cache.set(key, known);
    return known;
  }
  const names = await listing();
  const summary = computeExposure(edges, request, {
    formOf: filingForm,
    nameOf: (ticker) => names?.get(ticker) ?? null,
    isListed: names ? (ticker) => names.has(ticker) : undefined,
  });
  // A summary computed without the directory is not kept, so the next ask can name and link properly.
  if (names) {
    cache.set(key, summary);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  return summary;
}

export function registerExposureHandlers(): void {
  registerIpcHandler("exposure:summary", async (_event, raw: unknown): Promise<ExposureResult> => {
    const request = parseExposureRequest(raw);
    if (!request) return { ok: false, error: "invalid_request" };
    try {
      return { ok: true, summary: await exposureSummary(request) };
    } catch (err) {
      console.warn("[exposure] summary failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });
}
