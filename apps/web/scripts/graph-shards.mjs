/**
 * Splits the engine's filing graph (packages/engine/data/graph.json) into one
 * small file per ticker under apps/web/data/graph/, which GET /api/graph
 * reads at request time. The whole graph is too big to bundle into the
 * route; a ticker's file holds only the links that touch it.
 *
 *   data/graph/_names.json   { ticker: company name }
 *   data/graph/<TICKER>.json { edges: [...] }   strongest first
 *   data/graph/_all.json     the whole graph without quotes, for the Graph tab:
 *     { n: [[ticker, short name, degree, sector], ...],
 *       e: [[source index, target index, relation, strength], ...] }
 *     relation 0 supplier, 1 customer, 2 competitor, 3 partner (what target
 *     is to source); strength 3 critical, 2 important, 1 marginal. One edge per
 *     pair, its strongest link. Sector: from the company's SEC SIC code
 *     (packages/engine/data/company-sic.json, made by scripts/graph-sic.mjs;
 *     table in scripts/sic-sectors.mjs), "" when unknown.
 *
 * Only links with a ticker on both ends are kept (the route shows nothing
 * else). Runs before `next dev` and `next build`; the output is not committed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sectorFor } from "./sic-sectors.mjs";

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

// The whole graph, compact: names shortened, no quotes, one edge per pair.
const REL = { supplier: 0, customer: 1, competitor: 2, partner: 3 };
const STRENGTH = { critical: 3, important: 2, marginal: 1 };
const SUFFIX =
  /[,.]?\s+(inc|incorporated|corp|corporation|co|company|companies|ltd|limited|plc|ag|sa|se|nv|n\.v|lp|llc|holdings?|group|technologies|technology|& co|&)\.?$/i;
function shortName(name, ticker) {
  let s = String(name ?? ticker).trim();
  for (let i = 0; i < 4; i++) {
    const next = s.replace(SUFFIX, "").trim();
    if (next === s || !next) break;
    s = next;
  }
  // All-caps filer names read better in title case.
  if (s === s.toUpperCase() && /[A-Z]{3,}\s+[A-Z]{3,}/.test(s)) s = s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return s.length > 28 ? `${s.slice(0, 27).trimEnd()}…` : s;
}
const pairs = new Map();
for (const e of graph.edges) {
  if (!e.to || e.to === e.from || !valid.test(e.from) || !valid.test(e.to)) continue;
  const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
  const strength = STRENGTH[e.tier] ?? 1;
  const known = pairs.get(key);
  if (!known || strength > known.strength) pairs.set(key, { from: e.from, to: e.to, rel: REL[e.category] ?? 3, strength });
}
const index = new Map();
const nodes = [];
const degree = [];
const at = (t) => {
  let i = index.get(t);
  if (i === undefined) {
    i = nodes.length;
    index.set(t, i);
    nodes.push(t);
    degree.push(0);
  }
  return i;
};
const allEdges = [];
for (const p of pairs.values()) {
  const a = at(p.from);
  const b = at(p.to);
  degree[a]++;
  degree[b]++;
  allEdges.push([a, b, p.rel, p.strength]);
}
let sicOf = {};
try {
  sicOf = JSON.parse(fs.readFileSync(path.resolve(path.dirname(src), "company-sic.json"), "utf8")).sic ?? {};
} catch {
  // No SIC file: every sector is "" and the Graph tab leaves out its Sector filter.
}
const all = JSON.stringify({ n: nodes.map((t, i) => [t, shortName(graph.names?.[t], t), degree[i], sectorFor(t, sicOf[t]) ?? ""]), e: allEdges });
fs.writeFileSync(path.join(out, "_all.json"), all);
console.log(`graph-shards: whole graph ${nodes.length} companies, ${allEdges.length} links, ${(all.length / 1e3).toFixed(0)} KB`);

// Point in time (packages/engine/data/graph-pit.json, scripts/graph-history.ts in the engine):
// when each link was first and last stated in the filer's annual reports. Kept apart from the
// live files above (which it never changes): data/graph/_pit/<TICKER>.json with the evidence of
// the first report, and data/graph/_pit/_all.json compact. Read by /api/graph?asOf=,
// Falcon AI's falcon_graph (asOf) and load_graph. Types: lib/workspace/graph-pit.ts.
const pitSrc = path.resolve(path.dirname(src), "graph-pit.json");
if (fs.existsSync(pitSrc)) {
  const pit = JSON.parse(fs.readFileSync(pitSrc, "utf8"));
  const pitOut = path.join(out, "_pit");
  fs.mkdirSync(pitOut, { recursive: true });
  const byT = new Map();
  const tickers = [];
  const tIndex = new Map();
  const ti = (t) => {
    let i = tIndex.get(t);
    if (i === undefined) {
      i = tickers.length;
      tIndex.set(t, i);
      tickers.push(t);
    }
    return i;
  };
  const rows = [];
  const full = [];
  for (const e of pit.edges) {
    if (!e.to || e.to === e.from || !valid.test(e.from) || !valid.test(e.to)) continue;
    const slim = {
      from: e.from,
      to: e.to,
      category: e.category,
      tier: e.tier,
      disclosedSharePct: null,
      quote: e.firstSeen.quote,
      form: e.firstSeen.form,
      filedAt: e.firstSeen.filedAt,
      url: e.firstSeen.url,
      firstSeen: e.firstSeen.filedAt,
      firstAccession: e.firstSeen.accession,
      lastSeen: e.lastSeen.filedAt,
      endedAt: e.endedAt,
      seenIn: e.seenIn,
      checkedIn: e.checkedIn,
      basis: e.basis,
      current: e.current,
    };
    for (const t of [e.from, e.to]) {
      const list = byT.get(t) ?? [];
      list.push(slim);
      byT.set(t, list);
    }
    rows.push([ti(e.from), ti(e.to), REL[e.category] ?? 3, STRENGTH[e.tier] ?? 1, slim.firstSeen, slim.lastSeen, e.endedAt ?? "", e.current ? 1 : 0, e.seenIn, e.checkedIn, e.basis === "history" ? 1 : 0]);
    // load_graph's rows (lib/desk/tools/load-graph.ts PIT_ROW_COLUMNS).
    full.push([e.from, e.to, e.category, e.tier, slim.firstSeen, slim.firstAccession, slim.form, slim.lastSeen, e.endedAt ?? "", e.seenIn, e.checkedIn, e.basis, e.current ? 1 : 0, slim.url, slim.quote]);
  }
  for (const [t, list] of byT) {
    list.sort((a, b) => strength(a) - strength(b) || a.firstSeen.localeCompare(b.firstSeen));
    fs.writeFileSync(path.join(pitOut, `${t}.json`), JSON.stringify({ edges: list }));
  }
  const pitAll = JSON.stringify({ generatedAt: pit.generatedAt, since: pit.since, t: tickers, e: rows });
  fs.writeFileSync(path.join(pitOut, "_all.json"), pitAll);
  const columns = ["from", "to", "relation", "strength", "first_seen", "first_accession", "first_form", "last_seen", "ended_at", "seen_in", "checked_in", "basis", "current", "first_url", "first_quote"];
  fs.writeFileSync(path.join(pitOut, "_rows.json"), JSON.stringify({ generatedAt: pit.generatedAt, since: pit.since, columns, rows: full }));
  console.log(`graph-shards: point in time ${rows.length} links (${rows.filter((r) => r[7]).length} live, ${rows.filter((r) => r[10]).length} with history), ${(pitAll.length / 1e3).toFixed(0)} KB`);
}
