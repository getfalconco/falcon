/**
 * Rebuild graph.json so every edge carries filing_date + accession_number
 * (injected by buildGraphFromResearchDir from each ticker's *.meta.json).
 * Usage: pnpm backfill-filing-dates
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGraphFromResearchDir,
  resolveResearchDataDir,
} from "../packages/research/src/step1/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  process.env.FALCON_RESEARCH_DATA_DIR =
    process.env.FALCON_RESEARCH_DATA_DIR ??
    path.join(repoRoot, "apps", "desktop", "data", "research");

  const researchDir = resolveResearchDataDir();
  console.info(`[backfill-filing-dates] research dir: ${researchDir}`);

  const graph = await buildGraphFromResearchDir(researchDir);

  const outPath =
    process.env.FALCON_GRAPH_PATH?.trim() ||
    path.join(repoRoot, "apps", "desktop", "data", "graph.json");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(graph, null, 2), "utf8");

  let dated = 0;
  let undated = 0;
  for (const e of graph.edges) {
    if (e.filing_date) dated++;
    else undated++;
  }
  console.info(
    `[backfill-filing-dates] wrote ${outPath} — ${graph.edgeCount} edges, filing_date on ${dated}, missing ${undated}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
