/**
 * Backfill `disclosed_share_pct` / `disclosed_share_quote` onto existing
 * step1 results (data/research/<T>.json) and the graph file (graph.json),
 * from stored extraction data only: a disclosed strength, or the cached
 * extraction candidates of the same filing. No model calls, no rebuild: the
 * graph is patched in place, so the only change is the two added fields.
 *
 * With --recompute-tiers it also puts every edge's strength tier back on the
 * rule that a percentage sets the tier only when a quote states it as the
 * current share (`disclosed_share_pct`): a verified share gives its tier, and
 * a "disclosed" strength with no verified share (the tier came from a
 * percentage no quote states) is classified again from its words, the one
 * model call this makes (the step1 strength classifier, Anthropic key from
 * apps/desktop/.env). Rebuild the graph afterwards: pnpm graph.
 *
 * With --only-defaulted it classifies again, from the words, the edges whose
 * tier may be a silent default rather than a judgement: every edge stored as
 * `strength_basis: "unclassified"` (the classifier gave no tier), and with
 * --legacy-important also every edge written before that marker existed that
 * carries exactly what the old silent default wrote ("classified",
 * "important", strength 0.6, no stated share): stored data keeps no rationale,
 * so a default and a real "important" look the same there. A new tier is
 * written only when the classifier returns one and a second, independent pass
 * over the changed edges returns the same tier (the classifier is not
 * deterministic on borderline quotes: in the 2026-10-16 run 22 of 55 first-pass
 * changes flipped back on a second pass); an edge it still cannot judge, or
 * whose two passes disagree, keeps what it had. --single-pass skips the check. --max-edges N (default 600) refuses a larger selection,
 * the cost cap (one model call per 20 edges); --limit N takes only the first N
 * (a probe); --report <file> writes every judged edge, before and after, as JSON.
 *
 * Usage: pnpm backfill-disclosed-share [--dry-run] [--recompute-tiers]
 *          [--only-defaulted [--legacy-important] [--max-edges N] [--limit N] [--report file]]
 *   FALCON_RESEARCH_DATA_DIR  research dir (default apps/desktop/data/research)
 *   FALCON_RESEARCH_CACHE_DIR cache dir    (default apps/desktop/data/cache)
 *   FALCON_GRAPH_PATH         graph file   (default apps/desktop/data/graph.json)
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STRENGTH_BATCH_SIZE,
  backfillGraph,
  backfillRootEdges,
  candidatesCachePath,
  classifyEdgesStrength,
  createTokenUsage,
  defaultedStrengthPlan,
  stringifyLike,
  tierRecomputePlan,
  withStrength,
  type CachedCandidateLike,
  type EdgeStrength,
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

async function loadDesktopEnv(): Promise<void> {
  try {
    const raw = await readFile(path.join(repoRoot, "apps/desktop/.env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // optional
  }
}

const strengthText = (s: EdgeStrength) => `${s.strength_tier} ${s.strength} (${s.strength_basis})`;

/**
 * --recompute-tiers: every root's tiers back on the verified-share rule.
 * Returns the edges by root, changed or not, and writes the files that changed.
 */
async function recomputeTiers(
  roots: Array<{ file: string; raw: string; edges: ValidatedEdge[] }>,
  researchDir: string,
  dryRun: boolean,
): Promise<void> {
  const changes: string[] = [];
  const pending: Array<{ root: number; index: number }> = [];
  const next = roots.map((r) => [...r.edges]);
  roots.forEach((r, root) => {
    const plan = tierRecomputePlan(r.edges);
    for (const { index, resolved } of plan.fromShare) {
      const e = r.edges[index]!;
      changes.push(`  ${e.root_ticker} -> ${e.counterparty_name} (${e.category}): ${strengthText(e)} => ${strengthText(resolved)} (share stated)`);
      next[root]![index] = withStrength(e, resolved);
    }
    for (const index of plan.reclassify) pending.push({ root, index });
  });
  if (pending.length > 0) {
    await loadDesktopEnv();
    const inputs = pending.map(({ root, index }) => {
      const e = roots[root]!.edges[index]!;
      return {
        counterparty_name: e.counterparty_name,
        category: e.category,
        subtype: e.subtype,
        disclosed_revenue_dependency_pct: null,
        evidence_quote: e.evidence[0]?.quote ?? "",
      };
    });
    const resolved = await classifyEdgesStrength(inputs);
    pending.forEach(({ root, index }, i) => {
      const e = roots[root]!.edges[index]!;
      const s = resolved[i]!;
      changes.push(`  ${e.root_ticker} -> ${e.counterparty_name} (${e.category}): ${strengthText(e)} => ${strengthText(s)} (no stated share; classified from the words)`);
      next[root]![index] = withStrength(e, s);
    });
  }
  const tierChanges = changes.length;
  let written = 0;
  for (let i = 0; i < roots.length; i++) {
    if (next[i]!.every((e, j) => e === roots[i]!.edges[j])) continue;
    roots[i]!.edges = next[i]!;
    if (!dryRun) {
      await writeFile(path.join(researchDir, roots[i]!.file), stringifyLike(roots[i]!.raw, next[i]), "utf8");
      written++;
    }
  }
  console.info(`[backfill-disclosed-share] tiers: ${tierChanges} edges recomputed (${pending.length} classified from the words), ${written} files written`);
  if (changes.length) console.info(changes.join(String.fromCharCode(10)));
}

function flagValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

/**
 * --only-defaulted: classify again the edges whose tier may be a silent
 * default (see the header). Writes the files that changed.
 */
async function reclassifyDefaulted(
  roots: Array<{ file: string; raw: string; edges: ValidatedEdge[] }>,
  researchDir: string,
  dryRun: boolean,
): Promise<void> {
  const legacy = process.argv.includes("--legacy-important");
  const maxEdges = Number(flagValue("--max-edges") ?? 600);
  const limit = flagValue("--limit") === null ? Infinity : Number(flagValue("--limit"));
  const reportFile = flagValue("--report");

  let pending: Array<{ root: number; index: number; was: "unclassified" | "legacy" }> = [];
  roots.forEach((r, root) => {
    const plan = defaultedStrengthPlan(r.edges, { legacy });
    for (const index of plan.unclassified) pending.push({ root, index, was: "unclassified" });
    for (const index of plan.legacy) pending.push({ root, index, was: "legacy" });
  });
  const selected = pending.length;
  pending = pending.slice(0, limit);
  const calls = Math.ceil(pending.length / STRENGTH_BATCH_SIZE);
  console.info(
    `[backfill-disclosed-share] only-defaulted: ${selected} edges selected ` +
      `(${pending.filter((p) => p.was === "unclassified").length} unclassified, ${pending.filter((p) => p.was === "legacy").length} legacy "important" defaults), ` +
      `${pending.length} to classify in ${calls} model calls${dryRun ? " (dry run: nothing is written)" : ""}`,
  );
  if (pending.length > maxEdges) {
    throw new Error(`only-defaulted: ${pending.length} edges is over --max-edges ${maxEdges}; raise it to go on`);
  }
  if (pending.length === 0) return;

  await loadDesktopEnv();
  const usage = createTokenUsage();
  const resolved = await classifyEdgesStrength(
    pending.map(({ root, index }) => {
      const e = roots[root]!.edges[index]!;
      return {
        counterparty_name: e.counterparty_name,
        category: e.category,
        subtype: e.subtype,
        disclosed_revenue_dependency_pct: null,
        evidence_quote: e.evidence[0]?.quote ?? "",
      };
    }),
    undefined,
    usage,
  );

  const outcomeOf = (e: ValidatedEdge, s: EdgeStrength) =>
    s.strength_basis === "unclassified" ? "still unclassified" : s.strength_tier === e.strength_tier && e.strength_basis === "classified" ? "same" : "changed";

  // Second pass over the first pass's changes: a change stands only when both agree.
  let callsTotal = calls;
  const second = new Map<number, EdgeStrength>();
  if (!process.argv.includes("--single-pass")) {
    const recheck = pending.map((p, i) => i).filter((i) => outcomeOf(roots[pending[i]!.root]!.edges[pending[i]!.index]!, resolved[i]!) === "changed");
    if (recheck.length > 0) {
      const again = await classifyEdgesStrength(
        recheck.map((i) => {
          const e = roots[pending[i]!.root]!.edges[pending[i]!.index]!;
          return { counterparty_name: e.counterparty_name, category: e.category, subtype: e.subtype, disclosed_revenue_dependency_pct: null, evidence_quote: e.evidence[0]?.quote ?? "" };
        }),
        undefined,
        usage,
      );
      recheck.forEach((i, j) => second.set(i, again[j]!));
      callsTotal += Math.ceil(recheck.length / STRENGTH_BATCH_SIZE);
    }
  }

  const next = roots.map((r) => [...r.edges]);
  const changes: string[] = [];
  const report: Array<Record<string, unknown>> = [];
  const tally = { changed: 0, same: 0, stillUnclassified: 0, unconfirmed: 0 };
  pending.forEach(({ root, index, was }, i) => {
    const e = roots[root]!.edges[index]!;
    const s = resolved[i]!;
    const check = second.get(i);
    let outcome = outcomeOf(e, s);
    if (outcome === "changed" && check && check.strength_tier !== s.strength_tier) outcome = "unconfirmed";
    report.push({
      root_ticker: e.root_ticker,
      counterparty_name: e.counterparty_name,
      category: e.category,
      subtype: e.subtype,
      selected_as: was,
      before: { strength: e.strength, strength_tier: e.strength_tier, strength_basis: e.strength_basis },
      after: { strength: s.strength, strength_tier: s.strength_tier, strength_basis: s.strength_basis },
      ...(check ? { second_pass: check.strength_tier } : {}),
      outcome,
      quote: e.evidence[0]?.quote ?? "",
    });
    if (outcome === "still unclassified") {
      tally.stillUnclassified++;
      return;
    }
    if (outcome === "same") {
      tally.same++;
      return;
    }
    if (outcome === "unconfirmed") {
      tally.unconfirmed++;
      return;
    }
    tally.changed++;
    changes.push(`  ${e.root_ticker} -> ${e.counterparty_name} (${e.category}): ${strengthText(e)} => ${strengthText(s)}`);
    next[root]![index] = withStrength(e, s);
  });

  let written = 0;
  for (let i = 0; i < roots.length; i++) {
    if (next[i]!.every((e, j) => e === roots[i]!.edges[j])) continue;
    roots[i]!.edges = next[i]!;
    if (!dryRun) {
      await writeFile(path.join(researchDir, roots[i]!.file), stringifyLike(roots[i]!.raw, next[i]), "utf8");
      written++;
    }
  }
  if (reportFile) await writeFile(reportFile, JSON.stringify({ calls: callsTotal, usage, tally, edges: report }, null, 2), "utf8");
  console.info(
    `[backfill-disclosed-share] only-defaulted: ${tally.changed} changed, ${tally.same} confirmed, ` +
      `${tally.unconfirmed} changed on one pass only (kept as they were), ${tally.stillUnclassified} still unclassified (kept as they were); ` +
      `${callsTotal} model calls, ${usage.inputTokens} input / ${usage.outputTokens} output tokens; ${written} files written`,
  );
  if (changes.length) console.info(changes.join(String.fromCharCode(10)));
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
  const recompute = process.argv.includes("--recompute-tiers");
  const researchDir = process.env.FALCON_RESEARCH_DATA_DIR?.trim() || path.join(dataRoot, "research");
  const cacheDir = process.env.FALCON_RESEARCH_CACHE_DIR?.trim() || path.join(dataRoot, "cache");
  const graphFile = process.env.FALCON_GRAPH_PATH?.trim() || path.join(dataRoot, "graph.json");
  console.info(`[backfill-disclosed-share] research ${researchDir}\n  cache ${cacheDir}\n  graph ${graphFile}${dryRun ? "\n  (dry run)" : ""}`);

  const files = (await readdir(researchDir))
    .filter((f) => /^[A-Z0-9.-]+\.json$/i.test(f) && !/\.(rejected|merged|meta|stats)\.json$/i.test(f))
    .sort();

  const all: ValidatedEdge[] = [];
  const roots: Array<{ file: string; raw: string; edges: ValidatedEdge[] }> = [];
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
    roots.push({ file, raw: parsed.raw, edges: result.edges });
    if (result.stamped > 0 && !dryRun) {
      await writeFile(path.join(researchDir, file), stringifyLike(parsed.raw, result.edges), "utf8");
      totals.rootsWritten++;
    }
  }
  if (recompute) await recomputeTiers(roots, researchDir, dryRun);
  if (process.argv.includes("--only-defaulted")) await reclassifyDefaulted(roots, researchDir, dryRun);
  for (const r of roots) all.push(...r.edges);
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
