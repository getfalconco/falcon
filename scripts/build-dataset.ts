/**
 * Assemble the extraction dataset from the step1 cache.
 *
 *   pnpm dataset:build
 *
 * Writes data/dataset/extraction.json — a fixed set of (chunk → relationships)
 * cases replayed by the eval so a cost change can be checked against output,
 * not just token counts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDataset } from "../packages/research/src/dataset/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const cacheDir = process.env.FALCON_STEP1_CACHE_DIR ?? path.join(ROOT, "apps", "desktop", "data", "cache");
const outDir = path.join(ROOT, "data", "dataset");
const outFile = path.join(outDir, "extraction.json");

const dataset = buildDataset(cacheDir);
if (dataset.cases.length === 0) {
  console.error(`No cases built from ${cacheDir} — is the step1 cache populated?`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(dataset, null, 1), "utf8");

const withEdges = dataset.cases.filter((c) => c.expected.length > 0).length;
const empty = dataset.cases.length - withEdges;
console.log(`
  filings        ${dataset.source.filings}
  cases          ${dataset.cases.length}   (${withEdges} with relationships, ${empty} deliberately empty)
  relationships  ${dataset.source.candidates}

  → ${path.relative(ROOT, outFile)}
`);
