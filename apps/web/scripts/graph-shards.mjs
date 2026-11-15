/**
 * Splits the engine's filing graph (packages/engine/data/graph.json) into one
 * small file per ticker under apps/web/data/graph/, which GET /api/graph
 * reads at request time. The whole graph is too big to bundle into the
 * route; a ticker's file holds only the links that touch it.
 *
 *   data/graph/_names.json   { ticker: company name }
 *   data/graph/<TICKER>.json { edges: [...] }   strongest first
 *
 * Only links with a ticker on both ends are kept (the route shows nothing
 * else). Runs before `next dev` and `next build`; the output is not committed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "..", "..", "packages", "engine", "data", "graph.json");
const out = path.resolve(here, "..", "data", "graph");

const TIER_RANK = { critical: 0, important: 1, marginal: 2 };
const strength = (e) => (TIER_RANK[e.tier] ?? 3) * 1000 - (e.disclosedSharePct ?? 0);

const graph = JSON.parse(fs.readFileSync(src, "utf8"));
const byTicker = new Map();
for (const e of graph.edges) {
  if (!e.to || e.to === e.from) continue;
  const slim = {
    from: e.from,
    to: e.to,
    category: e.category,
    tier: e.tier,
    disclosedSharePct: e.disclosedSharePct ?? null,
    quote: e.quote,
    form: e.form,
    filedAt: e.filedAt,
    url: e.url,
  };
  for (const t of [e.from, e.to]) {
    const list = byTicker.get(t) ?? [];
    list.push(slim);
    byTicker.set(t, list);
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const valid = /^[A-Z0-9.\-]{1,10}$/;
let files = 0;
let bytes = 0;
for (const [t, list] of byTicker) {
  if (!valid.test(t)) continue;
  list.sort((a, b) => strength(a) - strength(b) || b.filedAt.localeCompare(a.filedAt));
  const body = JSON.stringify({ edges: list });
  fs.writeFileSync(path.join(out, `${t}.json`), body);
  files++;
  bytes += body.length;
}
const names = {};
for (const t of byTicker.keys()) if (graph.names?.[t]) names[t] = graph.names[t];
fs.writeFileSync(path.join(out, "_names.json"), JSON.stringify(names));
console.log(`graph-shards: ${files} tickers, ${(bytes / 1e6).toFixed(1)} MB -> ${path.relative(process.cwd(), out) || out}`);
