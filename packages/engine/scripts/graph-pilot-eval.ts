/**
 * Measures a graph-extract run (scripts/graph-extract.ts): edges per filer
 * and sector, share with a ticker on both ends, how names were resolved, why
 * proposals were rejected, model tokens and dollars per filer, recall
 * against the seed graph (data/graph-seed.json) for the filers both read, and
 * precision from hand labels. Reads only local files; no network, no model.
 *
 *   pnpm --filter @falcon/engine exec node --import tsx scripts/graph-pilot-eval.ts
 *   ... --run .cache/graph-extract/graph-pilot-run.json --sample 40 --labels data/graph-pilot-labels.json
 *
 * --sample N writes N stage A edges in a fixed random order to
 * .cache/graph-extract/sample.json for labelling (blind: the file shows the
 * quote and the two names first; the claimed relation is listed apart).
 */

import fs from "node:fs";
import path from "node:path";
import { ENGINE_ROOT } from "../src/http.ts";
import { loadGraph, SEED_GRAPH_PATH, type EdgeCategory } from "../src/graph.ts";
import { applyVerdict, type ExtractedEdge, type Verdict } from "../src/graph/extract.ts";
import { graphStats, precisionFrom, recallAgainst, sampleEdges, type Label } from "../src/graph/metrics.ts";
import type { LlmUsage } from "../src/detectors/llm.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

type Run = {
  seconds: number;
  verify: string;
  extractModel?: string;
  usage: LlmUsage;
  runs: Array<{
    ticker: string;
    sector: string;
    name: string;
    error?: string;
    passageChars?: number;
    proposed?: number;
    rejected?: Array<{ reason: string }>;
    edges?: ExtractedEdge[];
    verdicts?: Record<string, Verdict>;
  }>;
};

const runFile = path.resolve(arg("run") ?? path.join(ENGINE_ROOT, ".cache", "graph-extract", "graph-pilot-run.json"));
const run = JSON.parse(fs.readFileSync(runFile, "utf8")) as Run;
const filers = run.runs.map((r) => r.ticker);

const stageA = run.runs.flatMap((r) => r.edges ?? []);
const finalById = new Map<string, EdgeCategory | null>();
const final: ExtractedEdge[] = [];
for (const r of run.runs) {
  for (const e of r.edges ?? []) {
    const after = applyVerdict(e, r.verdicts?.[e.id]);
    finalById.set(e.id, after ? after.category : null);
    if (after) final.push(after);
  }
}

const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
function show(label: string, edges: ExtractedEdge[]) {
  const s = graphStats(edges, filers);
  console.log(
    `${label}: ${s.edges} edges over ${s.filers} filers; per filer mean ${s.perFiler.mean.toFixed(1)}, median ${s.perFiler.median}, ${s.perFiler.zero} with none; ticker on both ends ${pct(s.listedShare)}; share stated ${s.withShare}, sole source ${s.soleSource}`,
  );
  console.log(`  categories ${JSON.stringify(s.byCategory)}; tiers ${JSON.stringify(s.byTier)}`);
}

console.log(`run ${path.basename(runFile)}: extract ${run.extractModel ?? "claude-haiku-5-5"}, verify ${run.verify}, ${run.seconds}s`);
show("stage A (checked in code)", stageA);
if (run.verify !== "off") show("final (after stage B)", final);

console.log("\nby sector (final): filers, edges, listed both ends");
const sectors = [...new Set(run.runs.map((r) => r.sector))];
for (const s of sectors) {
  const ts = new Set(run.runs.filter((r) => r.sector === s).map((r) => r.ticker));
  const es = final.filter((e) => ts.has(e.from));
  console.log(`  ${s.padEnd(20)} ${String(ts.size).padStart(3)} ${String(es.length).padStart(5)}  ${pct(es.length ? es.filter((e) => e.to).length / es.length : 0)}   ${[...ts].map((t) => `${t}:${es.filter((e) => e.from === t).length}`).join(" ")}`);
}

const resolved: Record<string, number> = {};
for (const e of final) resolved[e.resolvedBy] = (resolved[e.resolvedBy] ?? 0) + 1;
console.log(`\nresolution (final edges): ${JSON.stringify(resolved)}`);
const reasons: Record<string, number> = {};
for (const r of run.runs) for (const x of r.rejected ?? []) reasons[x.reason] = (reasons[x.reason] ?? 0) + 1;
const proposed = run.runs.reduce((s, r) => s + (r.proposed ?? 0), 0);
console.log(`proposals ${proposed}, rejected in code ${Object.values(reasons).reduce((a, b) => a + b, 0)}: ${JSON.stringify(reasons)}`);
let moved = 0;
let dropped = 0;
for (const r of run.runs) for (const v of Object.values(r.verdicts ?? {})) if (!v.supported || v.relation === "none") dropped++;
for (const e of stageA) if (finalById.get(e.id) && finalById.get(e.id) !== e.category) moved++;
if (run.verify !== "off") console.log(`stage B: dropped ${dropped}, relation changed ${moved}, of ${stageA.length}`);
const errors = run.runs.filter((r) => r.error);
if (errors.length) console.log(`errors: ${errors.map((r) => `${r.ticker} (${r.error})`).join(", ")}`);

const u = run.usage;
const n = filers.length;
console.log(`\nmodel: ${u.calls} calls, ${u.inputTokens} in / ${u.outputTokens} out tokens, $${u.costUsd.toFixed(4)} (${u.cached} answers from cache, not counted)`);
for (const [m, mu] of Object.entries(u.byModel ?? {})) {
  console.log(`  ${m}: ${mu.calls} calls, ${Math.round(mu.inputTokens / n)} in / ${Math.round(mu.outputTokens / n)} out tokens per filer, $${(mu.costUsd / n).toFixed(4)} per filer`);
}
console.log(`  per filer: $${(u.costUsd / n).toFixed(4)}, ${(run.seconds / n).toFixed(1)} s wall (4 at once)`);

// Recall against the seed graph, for the filers both graphs read.
const seed = loadGraph(SEED_GRAPH_PATH);
const seedFilers = new Set(seed.edges.map((e) => e.from).filter((f) => filers.includes(f)));
for (const [label, edges] of [["stage A", stageA], ["final", final]] as const) {
  const rc = recallAgainst(seed.edges, edges, seedFilers);
  console.log(`\nrecall vs data/graph-seed.json (${[...seedFilers].join(", ")}), ${label}: ${rc.pairs}/${rc.reference} pairs (${pct(rc.pairs / rc.reference)}), ${rc.exact} with the same category (${pct(rc.exact / rc.reference)})`);
  const byTier: Record<string, [number, number]> = {};
  const missedIds = new Set(rc.missed.map((m) => m.id));
  for (const e of seed.edges.filter((x) => seedFilers.has(x.from))) {
    const t = (byTier[e.tier] ??= [0, 0]);
    t[1]++;
    if (!missedIds.has(e.id)) t[0]++;
  }
  console.log(`  by seed tier: ${Object.entries(byTier).map(([t, [h, all]]) => `${t} ${h}/${all}`).join(", ")}`);
  if (label === "final" && process.argv.includes("--missed")) for (const m of rc.missed) console.log(`  missed ${m.from} ${m.category} ${m.to ?? "-"} "${m.toName}" (${m.tier})`);
}

const sampleN = Number(arg("sample") ?? 0);
if (sampleN > 0) {
  // --seed draws another sample; --exclude FILE leaves out edges already labelled there.
  const done = arg("exclude") ? new Set((JSON.parse(fs.readFileSync(arg("exclude")!, "utf8")) as Label[]).map((l) => l.id)) : new Set<string>();
  const pick = sampleEdges(
    stageA.filter((e) => !done.has(e.id)),
    sampleN,
    arg("seed") ? Number(arg("seed")) : undefined,
  );
  const file = path.join(ENGINE_ROOT, ".cache", "graph-extract", "sample.json");
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      pick.map((e) => ({ id: e.id, filer: `${run.runs.find((r) => r.ticker === e.from)?.name} (${e.from})`, named: e.toName, quote: e.quote })),
      null,
      1,
    )}\n`,
  );
  console.log(`\nsample of ${pick.length} stage A edges -> ${file}`);
}

const labelsFile = arg("labels");
if (labelsFile) {
  const labels = JSON.parse(fs.readFileSync(labelsFile, "utf8")) as Label[];
  const p = precisionFrom(labels, new Map(stageA.map((e) => [e.id, e.category])), finalById);
  console.log(
    `\nprecision on ${p.labelled} hand-labelled edges: stage A ${p.stageA.correct}/${p.labelled} (${pct(p.stageA.precision)}); after stage B ${p.final.correct}/${p.final.kept} kept (${pct(p.final.precision)}); stage B dropped ${p.droppedCorrect} correct, caught ${p.caught} wrong`,
  );
}
