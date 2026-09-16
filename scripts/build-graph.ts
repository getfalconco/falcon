/**
 * Merge all step1 research results into a single graph file.
 * Usage: pnpm graph
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGraphFromResearchDir,
  nodeDegree,
  resolveResearchDataDir,
} from "../packages/research/src/step1/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isMicrosoftCounterparty(edge: {
  counterparty_ticker: string | null;
  counterparty_id: string;
  counterparty_name: string;
}): boolean {
  if (edge.counterparty_ticker?.toUpperCase() === "MSFT") return true;
  if (edge.counterparty_id === "MSFT") return true;
  return /microsoft/i.test(edge.counterparty_name);
}

async function main(): Promise<void> {
  process.env.FALCON_RESEARCH_DATA_DIR =
    process.env.FALCON_RESEARCH_DATA_DIR ??
    path.join(repoRoot, "apps", "desktop", "data", "research");

  const researchDir = resolveResearchDataDir();
  const graph = await buildGraphFromResearchDir(researchDir);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));

  // The desktop app reads apps/desktop/data/graph.json (its data root); the
  // repo-root copy is only for CLI/external tools. Writing just the latter
  // left the app on a stale graph after a CLI rebuild.
  const outPaths = process.env.FALCON_GRAPH_PATH?.trim()
    ? [path.resolve(process.env.FALCON_GRAPH_PATH.trim())]
    : [
        path.join(repoRoot, "apps", "desktop", "data", "graph.json"),
        path.join(repoRoot, "data", "graph.json"),
      ];
  const serialized = JSON.stringify(graph, null, 2);
  for (const outPath of outPaths) {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, serialized, "utf8");
  }
  const outPath = outPaths.join("\n  → ");

  console.log(`\nGraph written → ${outPath}`);
  console.log(`Total nodes: ${graph.nodeCount}`);
  console.log(`Total edges: ${graph.edgeCount}`);

  const ranked = graph.nodes
    .map((node) => ({ node, degree: nodeDegree(graph.edges, node.id) }))
    .filter((r) => r.degree > 0)
    .sort((a, b) => b.degree - a.degree || a.node.id.localeCompare(b.node.id));

  console.log("\nTop 5 most-connected nodes:");
  for (const { node, degree } of ranked.slice(0, 5)) {
    console.log(`  ${node.id} (${node.label}) — ${degree} edge${degree === 1 ? "" : "s"}`);
  }

  const inbound = graph.edges.filter(isMicrosoftCounterparty);
  console.log("\n=== Reverse view: Microsoft / MSFT ===");
  if (inbound.length === 0) {
    console.log("(no inbound edges)");
  } else {
    for (const e of inbound) {
      const rootLabel = nodes.get(e.root_ticker)?.label ?? e.root_ticker;
      console.log(
        `  ${e.root_ticker} (${rootLabel}) → ${e.counterparty_name} [${e.category}${e.subtype ? ` / ${e.subtype}` : ""}]`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
