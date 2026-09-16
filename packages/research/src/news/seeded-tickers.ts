import { readFile } from "node:fs/promises";
import { resolveGraphPath } from "./event-paths.js";

/**
 * Built-in fallback list — only used when the graph file can't be read. The live
 * source of truth is the seeded root nodes in the relationship graph (see
 * {@link loadSeededTickers}), so this array does NOT need to stay in sync by hand.
 */
export const SEEDED_TICKERS = [
  "AMD",
  "AVGO",
  "DELL",
  "GRMN",
  "HPQ",
  "INTC",
  "MRT",
  "MSFT",
  "NVDA",
  "ORCL",
  "PLTR",
  "QCOM",
  "RBLX",
  "SNOW",
  "TSM",
] as const;

export type SeededTicker = (typeof SEEDED_TICKERS)[number];

type GraphEdgeLike = { root_ticker?: unknown };
type GraphFileLike = { edges?: GraphEdgeLike[] };

/**
 * Resolve the tickers to poll from the seeded relationship graph: every distinct
 * `root_ticker` across the graph's edges (i.e. the companies that were actually
 * step1-researched). This keeps the poller in lock-step with the graph — add a
 * seeded root and it gets polled with no code change. Falls back to
 * {@link SEEDED_TICKERS} only when the graph is missing/unreadable/empty.
 */
export async function loadSeededTickers(graphPath?: string): Promise<string[]> {
  const p = graphPath?.trim() || resolveGraphPath();
  try {
    const raw = await readFile(p, "utf8");
    const graph = JSON.parse(raw) as GraphFileLike;
    const set = new Set<string>();
    for (const edge of graph.edges ?? []) {
      const t = typeof edge.root_ticker === "string" ? edge.root_ticker.trim().toUpperCase() : "";
      if (t) set.add(t);
    }
    if (set.size > 0) {
      const tickers = [...set].sort();
      console.info(
        `[events] seeded tickers from graph (${p}): ${tickers.length} — ${tickers.join(" ")}`,
      );
      return tickers;
    }
    console.warn(`[events] graph ${p} has no root tickers — using built-in fallback list`);
  } catch (err) {
    console.warn(
      `[events] could not read seeded tickers from graph (${p}) — using built-in fallback:`,
      err instanceof Error ? err.message : err,
    );
  }
  return [...SEEDED_TICKERS];
}
