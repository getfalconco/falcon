/**
 * Makes the live graph, data/graph.json: the seed graph (data/graph-seed.json)
 * plus the whole-market extraction (data/graph-v1.json), by the rules in
 * src/graph/merge.ts. Relations whose measured precision missed the bar stay
 * out (--relations). Prints what it kept and every seed edge the extraction
 * contradicted.
 *
 *   pnpm --filter @falcon/engine run graph-merge -- --relations customer,supplier,competitor
 *
 * Flags:
 *   --seed FILE        default data/graph-seed.json
 *   --fresh FILE       default data/graph-v1.json
 *   --out FILE         default data/graph.json
 *   --relations LIST   relations shipped from the extraction (default customer,supplier,competitor,partner)
 */

import fs from "node:fs";
import path from "node:path";
import { ENGINE_ROOT } from "../src/http.ts";
import { GRAPH_PATH, loadGraph, SEED_GRAPH_PATH, type EdgeCategory } from "../src/graph.ts";
import { mergeGraphs } from "../src/graph/merge.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const seed = loadGraph(path.resolve(arg("seed") ?? SEED_GRAPH_PATH));
const fresh = loadGraph(path.resolve(arg("fresh") ?? path.join(ENGINE_ROOT, "data", "graph-v1.json")));
const out = path.resolve(arg("out") ?? GRAPH_PATH);
const relations = new Set((arg("relations") ?? "customer,supplier,competitor,partner").split(",").map((s) => s.trim()) as EdgeCategory[]);

const r = mergeGraphs(seed, fresh, { relations });
for (const c of r.contradicted) {
  console.log(`contradicted: ${c.seed.id} (${c.seed.filedAt}) by ${c.by.map((e) => `${e.id} (${e.filedAt}): "${e.quote.slice(0, 160)}"`).join("; ")}`);
}
const s = r.stats;
console.log(`seed ${s.seed} edges, ${s.seedKept} kept; extraction ${s.fresh} edges, ${s.freshKept} added (${s.freshSameId} already in the seed); relations shipped: ${[...relations].join(", ")}`);
console.log(`live graph: ${r.graph.edges.length} edges (${Object.entries(s.byRelation).map(([k, v]) => `${k} ${v}`).join(", ")}), ${Object.keys(r.graph.names).length} names`);
fs.writeFileSync(out, `${JSON.stringify(r.graph)}\n`);
console.log(`-> ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
