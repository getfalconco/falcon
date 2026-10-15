import { getResearchResult } from "@meridian/research/step1";
import { registerIpcHandler } from "../ipc-register";
import { filingForm, graphEdges } from "../research/graph-edges";
import { resolveStep1DataDir } from "../research/research-paths";
import { edgesFromStep1Result } from "../research/step1-graph";
import {
  extractEgo,
  normalizeLinks,
  type RawGraphEdge,
  type StockGraphOptions,
  type StockGraphResult,
} from "../../shared/stock-graph";

/**
 * `stock:graph`: the Stock tab's ego network for one ticker, two hops deep,
 * from the filing graph (`graph.json`). Only filing-backed links at
 * confidence 0.5 and up; the renderer marks the weaker of those.
 *
 * When the graph file does not yet hold the stock's own filing but step1 has
 * a result for it on disk (a job that just finished before the file was
 * rebuilt), that result's links are read in too, so "Research this company"
 * shows its answer without waiting for the rebuild.
 */

const MIN_CONFIDENCE = 0.5;

async function localStep1Edges(ticker: string): Promise<RawGraphEdge[]> {
  try {
    const result = await getResearchResult(ticker, { dataDir: resolveStep1DataDir() });
    if (!result) return [];
    const types = new Map(result.validated.map((e) => [e.counterparty_name, e.counterparty_type]));
    return edgesFromStep1Result(result).map((e) => ({
      ...e,
      counterparty_type: types.get(e.counterparty_name) ?? null,
      filing_date: result.filingDate || e.valid_from,
      accession_number: result.accessionNumber ?? null,
      form: result.form ?? null,
    }));
  } catch {
    return [];
  }
}

function tickersOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().toUpperCase())
    .filter((v) => /^[A-Z0-9.\-]{1,10}$/.test(v))
    .slice(0, 200);
}

export async function stockGraph(tickerRaw: unknown, options?: StockGraphOptions): Promise<StockGraphResult> {
  const ticker = typeof tickerRaw === "string" ? tickerRaw.trim().toUpperCase() : "";
  if (!/^[A-Z0-9.\-]{1,10}$/.test(ticker)) return { ok: false, error: "ticker is required" };
  try {
    let edges: RawGraphEdge[] = await graphEdges();
    if (!edges.some((e) => e.root_ticker?.toUpperCase() === ticker)) {
      const local = await localStep1Edges(ticker);
      if (local.length > 0) edges = [...edges, ...local];
    }
    const { links, names } = normalizeLinks(edges, { minConfidence: MIN_CONFIDENCE, formOf: filingForm });
    const graph = extractEgo(links, names, ticker, { keep: tickersOf(options?.related) });
    return { ok: true, graph };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerStockGraphHandlers(): void {
  registerIpcHandler("stock:graph", (_event, ticker: unknown, options?: StockGraphOptions) => stockGraph(ticker, options));
}
