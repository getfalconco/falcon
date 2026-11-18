/**
 * Writes packages/engine/data/company-sic.json: the SEC SIC code of every
 * company in the filing graph, which graph-shards.mjs turns into a sector
 * (scripts/sic-sectors.mjs) for the Graph tab's Sector filter. Run by hand
 * when the graph gains companies; the output is committed (public SEC data).
 *
 *   node apps/web/scripts/graph-sic.mjs
 *
 * Reads only the engine's local EDGAR cache (packages/engine/.cache/study:
 * company_tickers_exchange.json for ticker -> CIK and submissions/<cik>.json
 * for `sic`, filled by the engine's study scripts with its declared
 * User-Agent). It makes no network calls; a company missing from the cache
 * is listed and left without a SIC (scripts/sic-sectors.mjs SECTOR_OVERRIDES
 * can name its sector).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.resolve(here, "..", "..", "..", "packages", "engine");
const cache = path.join(engine, ".cache", "study");
const graph = JSON.parse(fs.readFileSync(path.join(engine, "data", "graph.json"), "utf8"));

const tickers = new Set();
for (const e of graph.edges) {
  if (e.from) tickers.add(e.from);
  if (e.to) tickers.add(e.to);
}

const exchange = JSON.parse(fs.readFileSync(path.join(cache, "company_tickers_exchange.json"), "utf8"));
const iTicker = exchange.fields.indexOf("ticker");
const iCik = exchange.fields.indexOf("cik");
const cikOf = new Map(exchange.data.map((row) => [row[iTicker], row[iCik]]));

const sic = {};
const missing = [];
for (const t of Array.from(tickers).sort()) {
  // Share classes and preferreds (BRK.B, PCG-PE) fall back to the common ticker.
  const cik = cikOf.get(t) ?? cikOf.get(t.replace(".", "-")) ?? cikOf.get(t.split(/[.-]/)[0]);
  const file = cik === undefined ? null : path.join(cache, "submissions", `${cik}.json`);
  const code = file && fs.existsSync(file) ? Number(JSON.parse(fs.readFileSync(file, "utf8")).sic) : NaN;
  if (Number.isFinite(code) && code > 0) sic[t] = code;
  else missing.push(t);
}

const out = path.join(engine, "data", "company-sic.json");
fs.writeFileSync(
  out,
  `${JSON.stringify({ source: "SEC EDGAR submissions (sic)", generatedAt: new Date().toISOString().slice(0, 10), sic })}\n`,
);
console.log(`graph-sic: ${Object.keys(sic).length} of ${tickers.size} companies have a SIC -> ${path.relative(process.cwd(), out)}`);
if (missing.length) console.log(`graph-sic: no SIC for ${missing.join(", ")}`);
