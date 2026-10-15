import fs from "node:fs";
import path from "node:path";
import { resolveDataRoot } from "../data-root";
import { resolveStep1DataDir } from "./research-paths";

/**
 * The filing graph (`graph.json`), read for main-process features that need
 * its links: the news panel's relationship lines and the Earnings tab's
 * "reads through to". Read once and again only when the file changes.
 *
 * Every edge in the file comes from a 10-K or 20-F (step1 extracts it with a
 * quote and keeps it only when the quote is found in the filing). The form
 * itself is missing on graphs built before it was carried, so `filingForm`
 * reads it from the step1 meta file of the company whose filing it is.
 */

export function graphPath(): string {
  return process.env.FALCON_GRAPH_PATH?.trim() || path.join(resolveDataRoot(), "graph.json");
}

/** A graph edge as the file stores it; every field optional, since older graphs carry fewer. */
export type GraphFileEdge = {
  root_ticker?: string;
  counterparty_ticker?: string | null;
  counterparty_name?: string;
  category?: string;
  subtype?: string;
  strength_tier?: string;
  confidence?: number;
  evidence_quote?: string;
  source_url?: string;
  filing_date?: string;
  accession_number?: string | null;
  form?: "10-K" | "20-F" | null;
};

let graphCache: { file: string; mtimeMs: number; edges: GraphFileEdge[] } | null = null;

/** The graph's edges; empty when there is no graph or it cannot be read. */
export async function graphEdges(): Promise<GraphFileEdge[]> {
  const file = graphPath();
  try {
    const stat = await fs.promises.stat(file);
    if (graphCache && graphCache.file === file && graphCache.mtimeMs === stat.mtimeMs) return graphCache.edges;
    const parsed = JSON.parse(await fs.promises.readFile(file, "utf8")) as { edges?: unknown };
    const edges = Array.isArray(parsed.edges) ? (parsed.edges as GraphFileEdge[]) : [];
    graphCache = { file, mtimeMs: stat.mtimeMs, edges };
    return edges;
  } catch {
    return [];
  }
}

const forms = new Map<string, "10-K" | "20-F" | null>();

/** The form of the filing step1 read for `ticker` ("10-K" or "20-F"), from its meta file; null when not on disk. */
export function filingForm(ticker: string): "10-K" | "20-F" | null {
  const key = ticker.toUpperCase();
  if (forms.has(key)) return forms.get(key)!;
  let form: "10-K" | "20-F" | null = null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(resolveStep1DataDir(), `${key}.meta.json`), "utf8")) as { form?: unknown };
    form = meta.form === "10-K" || meta.form === "20-F" ? meta.form : null;
  } catch {
    form = null;
  }
  forms.set(key, form);
  return form;
}
