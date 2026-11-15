/**
 * The quality gate for the whole-market graph: a blind, stratified sample of
 * the edges that would go live, labelled by hand, and precision from those
 * labels.
 *
 *   sample  N edges with a ticker on both ends, the same number per relation,
 *           spread over strength tiers and filer sectors (SIC). Writes a
 *           blind file (filer, the company as named, the company the ticker
 *           resolves to, the quote; no relation, tier or verdict) and a key.
 *   score   joins hand labels (and optionally a second labeller's) with the
 *           key: precision overall, per relation, per tier, per sector, and
 *           agreement between the two labellers.
 *
 *   pnpm --filter @falcon/engine run graph-label -- sample --graph data/graph-v1.json --n 200 --dir .cache/graph-label
 *   pnpm --filter @falcon/engine run graph-label -- score --dir .cache/graph-label [--second second.json]
 *
 * A label is { n, truth: customer | supplier | competitor | partner | none,
 * alt?: a second relation the quote also supports, resolved: whether the
 * resolved company is the one the quote names }. An edge is correct when the
 * label (or its alt) is its relation and the company resolved right.
 */

import fs from "node:fs";
import path from "node:path";
import { filerMeta, loadListings } from "../src/feed/companies.ts";
import { ENGINE_ROOT } from "../src/http.ts";
import { loadGraph, type EdgeCategory, type GraphEdge, type StrengthTier } from "../src/graph.ts";
import { sampleEdges } from "../src/graph/metrics.ts";
import { displayName } from "../src/graph/resolve.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const mode = process.argv[2];
const dir = path.resolve(arg("dir") ?? path.join(ENGINE_ROOT, ".cache", "graph-label"));

/** A coarse sector from an SEC SIC code. Pure. */
export function sectorOfSic(sic: string | null): string {
  const n = Number(sic ?? "");
  if (!Number.isFinite(n) || n <= 0) return "other";
  if (n === 3674) return "semis";
  if ((n >= 2830 && n <= 2836) || (n >= 3841 && n <= 3851) || (n >= 8000 && n <= 8099) || n === 5122 || n === 8731) return "health";
  if ((n >= 3570 && n <= 3579) || (n >= 3660 && n <= 3699) || (n >= 7370 && n <= 7379) || n === 3577) return "tech";
  if ((n >= 1300 && n <= 1399) || (n >= 2900 && n <= 2999) || (n >= 4900 && n <= 4991) || (n >= 4610 && n <= 4619)) return "energy_utilities";
  if (n >= 6000 && n <= 6799) return "financials";
  if ((n >= 5200 && n <= 5999) || (n >= 5000 && n <= 5199)) return "retail_distribution";
  if ((n >= 3710 && n <= 3716) || n === 3714) return "autos";
  if ((n >= 3720 && n <= 3729) || (n >= 3760 && n <= 3769) || (n >= 4500 && n <= 4599) || n === 3812) return "aerospace_airlines";
  if ((n >= 2000 && n <= 2399) || (n >= 2500 && n <= 2599) || (n >= 2840 && n <= 2844) || (n >= 3100 && n <= 3199) || (n >= 3900 && n <= 3999) || (n >= 7000 && n <= 7099) || (n >= 5800 && n <= 5899) || (n >= 7900 && n <= 7999)) return "consumer";
  if ((n >= 4800 && n <= 4899) || (n >= 2700 && n <= 2799) || (n >= 7800 && n <= 7899)) return "media_telecom";
  if ((n >= 1000 && n <= 1499) || (n >= 2600 && n <= 2699) || (n >= 2800 && n <= 2829) || (n >= 2850 && n <= 2899) || (n >= 3200 && n <= 3399)) return "materials";
  return "industrials";
}

type Key = { n: number; id: string; from: string; to: string; category: EdgeCategory; tier: StrengthTier; sector: string; verified?: boolean };
type Label = { n: number; truth: EdgeCategory | "none"; alt?: EdgeCategory; resolved: boolean; note?: string };

const RELATIONS: EdgeCategory[] = ["customer", "supplier", "competitor", "partner"];
const TIERS: StrengthTier[] = ["critical", "important", "marginal"];

if (mode === "sample") {
  const graph = loadGraph(path.resolve(arg("graph") ?? path.join(ENGINE_ROOT, "data", "graph-v1.json")));
  const n = Number(arg("n") ?? 200);
  const listings = await loadListings();
  const live = graph.edges.filter((e) => e.to && (e as GraphEdge & { verified?: boolean }).verified !== false);
  const sectors = new Map<string, string>();
  for (const t of new Set(live.map((e) => e.from))) {
    const l = listings.byTicker.get(t) ?? listings.byTicker.get(t.replace(".", "-"));
    const meta = l ? await filerMeta(l.cik).catch(() => null) : null;
    sectors.set(t, sectorOfSic(meta?.sic ?? null));
  }
  // Per relation n/4; within a relation, tiers get equal shares where they have the edges;
  // within a (relation, tier) cell, sectors take turns so no one sector fills the sample.
  const picked: GraphEdge[] = [];
  for (const rel of RELATIONS) {
    const want = Math.round(n / RELATIONS.length);
    const cells = TIERS.map((tier) => live.filter((e) => e.category === rel && e.tier === tier));
    const quota = TIERS.map(() => 0);
    let left = want;
    while (left > 0 && cells.some((c, i) => c.length > quota[i]!)) {
      for (let i = 0; i < TIERS.length && left > 0; i++) if (cells[i]!.length > quota[i]!) (quota[i]!++, left--);
    }
    cells.forEach((cell, i) => {
      const bySector = new Map<string, GraphEdge[]>();
      for (const e of sampleEdges(cell, cell.length, 20261115 + i)) {
        const s = sectors.get(e.from)!;
        (bySector.get(s) ?? bySector.set(s, []).get(s)!).push(e);
      }
      const queues = [...bySector.values()];
      for (let k = 0; picked.length < 1e9 && quota[i]! > 0 && queues.some((q) => q.length); k++) {
        const q = queues[k % queues.length]!;
        const e = q.shift();
        if (e) (picked.push(e), quota[i]!--);
      }
    });
  }
  const order = sampleEdges(picked, picked.length, 7);
  const keys: Key[] = order.map((e, i) => ({ n: i + 1, id: e.id, from: e.from, to: e.to!, category: e.category, tier: e.tier, sector: sectors.get(e.from)!, verified: (e as GraphEdge & { verified?: boolean }).verified }));
  const blind = order.map((e, i) => ({
    n: i + 1,
    filer: `${graph.names[e.from] ?? e.from} (${e.from})`,
    named: e.toName,
    resolvedTo: `${displayName(listings.byTicker.get(e.to!)?.name ?? graph.names[e.to!] ?? e.to!)} (${e.to})`,
    quote: e.quote,
  }));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "blind.json"), `${JSON.stringify(blind, null, 1)}\n`);
  fs.writeFileSync(path.join(dir, "key.json"), `${JSON.stringify(keys, null, 1)}\n`);
  const count = (f: (k: Key) => string) => Object.entries(keys.reduce<Record<string, number>>((m, k) => ((m[f(k)] = (m[f(k)] ?? 0) + 1), m), {})).map(([a, b]) => `${a} ${b}`).join(", ");
  console.log(`${keys.length} edges sampled from ${live.length} live candidates -> ${dir}/blind.json`);
  console.log(`  sectors: ${count((k) => k.sector)}`);
  console.log(`  relation x tier: ${count((k) => `${k.category}/${k.tier}`)}`);
} else if (mode === "score") {
  const keys = JSON.parse(fs.readFileSync(path.join(dir, "key.json"), "utf8")) as Key[];
  const labels = new Map((JSON.parse(fs.readFileSync(arg("labels") ?? path.join(dir, "labels.json"), "utf8")) as Label[]).map((l) => [l.n, l]));
  const ok = (k: Key, l: Label) => l.resolved && (l.truth === k.category || l.alt === k.category);
  const rows = keys.filter((k) => labels.has(k.n));
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
  const table = (name: string, group: (k: Key) => string) => {
    const g = new Map<string, Key[]>();
    for (const k of rows) (g.get(group(k)) ?? g.set(group(k), []).get(group(k))!).push(k);
    console.log(`\nby ${name}:`);
    for (const [v, ks] of [...g].sort()) {
      const c = ks.filter((k) => ok(k, labels.get(k.n)!)).length;
      console.log(`  ${v.padEnd(22)} ${String(c).padStart(3)}/${String(ks.length).padEnd(3)} ${pct(c, ks.length)}`);
    }
  };
  const correct = rows.filter((k) => ok(k, labels.get(k.n)!));
  const relOnly = rows.filter((k) => {
    const l = labels.get(k.n)!;
    return l.truth === k.category || l.alt === k.category;
  });
  console.log(`labelled ${rows.length}/${keys.length}; precision ${correct.length}/${rows.length} = ${pct(correct.length, rows.length)} (relation only, resolution aside: ${pct(relOnly.length, rows.length)}; wrong company: ${rows.filter((k) => !labels.get(k.n)!.resolved).length})`);
  table("relation", (k) => k.category);
  table("tier", (k) => k.tier);
  table("sector", (k) => k.sector);
  console.log("\nwrong:");
  for (const k of rows.filter((x) => !ok(x, labels.get(x.n)!))) {
    const l = labels.get(k.n)!;
    console.log(`  #${k.n} ${k.id} (${k.tier}) labelled ${l.truth}${l.alt ? `/${l.alt}` : ""}${l.resolved ? "" : ", wrong company"}${l.note ? `: ${l.note}` : ""}`);
  }
  const second = arg("second");
  if (second) {
    const two = new Map((JSON.parse(fs.readFileSync(second, "utf8")) as Label[]).map((l) => [l.n, l]));
    const both = rows.filter((k) => two.has(k.n));
    const verdictAgree = both.filter((k) => ok(k, labels.get(k.n)!) === ok(k, two.get(k.n)!)).length;
    const labelAgree = both.filter((k) => labels.get(k.n)!.truth === two.get(k.n)!.truth).length;
    const p1 = both.filter((k) => ok(k, labels.get(k.n)!)).length / (both.length || 1);
    const p2 = both.filter((k) => ok(k, two.get(k.n)!)).length / (both.length || 1);
    const po = verdictAgree / (both.length || 1);
    const pe = p1 * p2 + (1 - p1) * (1 - p2);
    console.log(`\nsecond labeller on ${both.length}: correct/wrong verdicts agree ${verdictAgree}/${both.length} (${pct(verdictAgree, both.length)}), Cohen's kappa ${pe < 1 ? ((po - pe) / (1 - pe)).toFixed(2) : "n/a"}; same relation label ${labelAgree}/${both.length}; second labeller's precision ${pct(p2 * both.length, both.length)}`);
    for (const k of both.filter((x) => ok(x, labels.get(x.n)!) !== ok(x, two.get(x.n)!) || labels.get(x.n)!.truth !== two.get(x.n)!.truth)) {
      const a = labels.get(k.n)!;
      const b = two.get(k.n)!;
      console.log(`  #${k.n} ${k.id}: first ${a.truth}${a.alt ? `/${a.alt}` : ""}${a.resolved ? "" : " (wrong co.)"}, second ${b.truth}${b.alt ? `/${b.alt}` : ""}${b.resolved ? "" : " (wrong co.)"}`);
    }
  }
} else {
  throw new Error("give sample or score");
}
