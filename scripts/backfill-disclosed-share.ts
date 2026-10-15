/**
 * Backfill `disclosed_share_pct` / `disclosed_share_quote` onto existing
 * step1 results (data/research/<T>.json) and the graph file (graph.json),
 * from stored extraction data only: a disclosed strength, or the cached
 * extraction candidates of the same filing. No model calls, no rebuild: the
 * graph is patched in place, so the only change is the two added fields.
 *
 * Usage: pnpm backfill-disclosed-share [--dry-run]
 *   FALCON_RESEARCH_DATA_DIR  research dir (default apps/desktop/data/research)
 *   FALCON_RESEARCH_CACHE_DIR cache dir    (default apps/desktop/data/cache)
 *   FALCON_GRAPH_PATH         graph file   (default apps/desktop/data/graph.json)
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backfillGraph,
  backfillRootEdges,
  candidatesCachePath,
  stringifyLike,
  type CachedCandidateLike,
  type ValidatedEdge,
} from "../packages/research/src/step1/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.join(repoRoot, "apps", "desktop", "data");

async function readJson(file: string): Promise<{ raw: string; value: unknown } | null> {
  try {
    const raw = await readFile(file, "utf8");
    return { raw, value: JSON.parse(raw) };
  } catch {
    return null;
  }
}

async function cachedCandidates(ticker: string, researchDir: string, cacheDir: string): Promise<CachedCandidateLike[] | null> {
  const meta = await readJson(path.join(researchDir, `${ticker}.meta.json`));
  const accession = (meta?.value as { accessionNumber?: unknown } | undefined)?.accessionNumber;
  if (typeof accession !== "string" || !accession) return null;
  const cached = await readJson(candidatesCachePath(ticker, accession, cacheDir));
  const list = (cached?.value as { candidates?: unknown } | undefined)?.candidates;
  return Array.isArray(list) ? (list as CachedCandidateLike[]) : null;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const researchDir = process.env.FALCON_RESEARCH_DATA_DIR?.trim() || path.join(dataRoot, "research");
  const cacheDir = process.env.FALCON_RESEARCH_CACHE_DIR?.trim() || path.join(dataRoot, "cache");
  const graphFile = process.env.FALCON_GRAPH_PATH?.trim() || path.join(dataRoot, "graph.json");
  console.info(`[backfill-disclosed-share] research ${researchDir}\n  cache ${cacheDir}\n  graph ${graphFile}${dryRun ? "\n  (dry run)" : ""}`);

  const files = (await readdir(researchDir))
    .filter((f) => /^[A-Z0-9.-]+\.json$/i.test(f) && !/\.(rejected|merged|meta|stats)\.json$/i.test(f))
    .sort();

  const all: ValidatedEdge[] = [];
  const totals = { roots: 0, rootsWritten: 0, edges: 0, stamped: 0, fromStrength: 0, fromCandidates: 0, unverified: 0, withShare: 0 };
  const shares: string[] = [];
  for (const file of files) {
    const ticker = file.replace(/\.json$/i, "").toUpperCase();
    const parsed = await readJson(path.join(researchDir, file));
    if (!parsed || !Array.isArray(parsed.value)) continue;
    totals.roots++;
    const result = backfillRootEdges(parsed.value as ValidatedEdge[], await cachedCandidates(ticker, researchDir, cacheDir));
    totals.edges += result.edges.length;
    totals.stamped += result.stamped;
    totals.fromStrength += result.fromStrength;
    totals.fromCandidates += result.fromCandidates;
    totals.unverified += result.unverified;
    for (const e of result.edges) {
      if (e.disclosed_share_pct != null) {
        totals.withShare++;
        shares.push(`  ${e.root_ticker} -> ${e.counterparty_name} (${e.category}): ${e.disclosed_share_pct}%`);
      }
    }
    all.push(...result.edges);
    if (result.stamped > 0 && !dryRun) {
      await writeFile(path.join(researchDir, file), stringifyLike(parsed.raw, result.edges), "utf8");
      totals.rootsWritten++;
    }
  }
  console.info(
    `[backfill-disclosed-share] research: ${totals.roots} roots, ${totals.edges} edges; stamped ${totals.stamped} ` +
      `(share from disclosed strength ${totals.fromStrength}, from cached candidates ${totals.fromCandidates}, ` +
      `disclosed strength without a quote stating it ${totals.unverified}); ${totals.withShare} edges carry a share; ` +
      `${totals.rootsWritten} files written`,
  );
  if (shares.length) console.info(shares.join("\n"));

  const graph = await readJson(graphFile);
  if (!graph || !graph.value || typeof graph.value !== "object") {
    console.info("[backfill-disclosed-share] no graph file; done");
    return;
  }
  const { graph: patched, report } = backfillGraph(graph.value as Record<string, unknown>, all);
  console.info(
    `[backfill-disclosed-share] graph: stamped ${report.stamped} edges (${report.withShare} with a share), ` +
      `already set ${report.alreadySet}, unmatched ${report.unmatched}`,
  );
  if (report.stamped > 0 && !dryRun) {
    await writeFile(graphFile, stringifyLike(graph.raw, patched), "utf8");
    console.info(`[backfill-disclosed-share] wrote ${graphFile}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
