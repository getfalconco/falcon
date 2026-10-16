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
 * With --full-evidence it classifies again, under the same two-pass rule and
 * caps, the edges the classifier once judged from their first quote alone
 * that now have more to read: more than one quote, or a sentence of the same
 * filing section stating dependence on the edge's category ("We depend on
 * foundries ..."). Every classification here (all modes) reads the edge's
 * quotes found in the cached filing section (all stored quotes when the
 * section is not cached) and those dependence sentences (`strengthInputForEdge`).
 *
 * With --merge-duplicates it folds the edges of one filer to one counterparty
 * in one category (two spellings of one company, "Taiwan Semiconductor
 * Manufacturing Company" and "TSMC") into one edge (`mergeSameCounterpartyEdges`)
 * and judges each merged edge again on its merged quotes, twice: the merged
 * edge takes the tier both passes agree on, else the lower of the two. A
 * merged edge with a stated share takes the share's tier.
 *
 * Usage: pnpm backfill-disclosed-share [--dry-run] [--recompute-tiers]
 *          [--only-defaulted [--legacy-important]] [--full-evidence] [--edges "ROOT:Name;ROOT:Name"] [--merge-duplicates]
 *          [--max-edges N] [--limit N] [--report file] [--single-pass]
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
  fullEvidencePlan,
  mergeSameCounterpartyEdges,
  resolveEdgeStrength,
  sectionCachePath,
  strengthInputForEdge,
  type CachedCandidateLike,
  type EdgeStrength,
  type StrengthClassifyInput,
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

type Root = { file: string; raw: string; edges: ValidatedEdge[]; filingText: string | null };

/**
 * The cached filing section of a root's current filing (the text its quotes
 * were checked against), whatever pipeline version wrote it; null when it is
 * not cached.
 */
async function cachedSectionText(ticker: string, researchDir: string, cacheDir: string): Promise<string | null> {
  const meta = await readJson(path.join(researchDir, `${ticker}.meta.json`));
  const accession = (meta?.value as { accessionNumber?: unknown } | undefined)?.accessionNumber;
  if (typeof accession !== "string" || !accession) return null;
  try {
    const raw = await readFile(sectionCachePath(ticker, accession, cacheDir), "utf8");
    const newline = raw.indexOf(String.fromCharCode(10));
    const text = newline >= 0 ? raw.slice(newline + 1) : "";
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** The classifier input of a root's edge: its quotes found in the section and the section's category dependence. */
function inputOf(root: Root, index: number): StrengthClassifyInput {
  return strengthInputForEdge(
    root.edges[index]!,
    root.filingText,
    root.edges.map((e) => e.counterparty_name),
  );
}

/**
 * --recompute-tiers: every root's tiers back on the verified-share rule.
 * Returns the edges by root, changed or not, and writes the files that changed.
 */
async function recomputeTiers(
  roots: Root[],
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
    const inputs = pending.map(({ root, index }) => inputOf(roots[root]!, index));
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

type Pending = { root: number; index: number; was: string };

/**
 * --only-defaulted: the edges whose tier may be a silent default (see the
 * header).
 */
function defaultedSelection(roots: Root[]): { pending: Pending[]; summary: string } {
  const legacy = process.argv.includes("--legacy-important");
  const pending: Pending[] = [];
  roots.forEach((r, root) => {
    const plan = defaultedStrengthPlan(r.edges, { legacy });
    for (const index of plan.unclassified) pending.push({ root, index, was: "unclassified" });
    for (const index of plan.legacy) pending.push({ root, index, was: "legacy" });
  });
  const count = (was: string) => pending.filter((p) => p.was === was).length;
  return { pending, summary: `${count("unclassified")} unclassified, ${count("legacy")} legacy "important" defaults` };
}

/**
 * --edges "ROOT:Counterparty name[:category];...": exactly these edges (a
 * re-judgement after a prompt change). A name matches the stored
 * counterparty_name exactly; an entry that matches no edge is an error.
 */
function namedEdgesSelection(roots: Root[], spec: string): { pending: Pending[]; summary: string } {
  const wanted = spec.split(";").map((s) => s.trim()).filter(Boolean);
  const pending: Pending[] = [];
  for (const w of wanted) {
    const [tickerPart = "", name = "", category = ""] = w.split(":").map((p) => p.trim());
    const ticker = tickerPart.toUpperCase();
    let found = 0;
    roots.forEach((r, root) => {
      r.edges.forEach((e, index) => {
        if (e.root_ticker.toUpperCase() === ticker && e.counterparty_name === name && (!category || e.category === category)) {
          pending.push({ root, index, was: "named" });
          found++;
        }
      });
    });
    if (found === 0) throw new Error(`--edges: no edge ${ticker} -> ${name}`);
  }
  return { pending, summary: `${wanted.length} named` };
}

/**
 * --full-evidence: the edges that have more to read than the first quote
 * they were judged from (see the header).
 */
function fullEvidenceSelection(roots: Root[]): { pending: Pending[]; summary: string } {
  const pending: Pending[] = [];
  roots.forEach((r, root) => {
    const plan = fullEvidencePlan(r.edges, r.edges.map((_, i) => inputOf(r, i)));
    for (const index of plan.dependence) pending.push({ root, index, was: "category dependence" });
    for (const index of plan.multiQuote) pending.push({ root, index, was: "several quotes" });
  });
  const count = (was: string) => pending.filter((p) => p.was === was).length;
  return {
    pending,
    summary:
      `${count("category dependence")} with a category dependence sentence, ${count("several quotes")} with several quotes only; ` +
      `${roots.filter((r) => r.filingText).length} of ${roots.length} roots have their filing section cached`,
  };
}

/**
 * Classify `selection` again from the full evidence and write a new tier only
 * when a second, independent pass over the changed edges agrees (unless
 * --single-pass). Writes the files that changed.
 */
async function reclassifyTwoPass(
  mode: string,
  roots: Root[],
  selection: { pending: Pending[]; summary: string },
  researchDir: string,
  dryRun: boolean,
): Promise<void> {
  const maxEdges = Number(flagValue("--max-edges") ?? 600);
  const limit = flagValue("--limit") === null ? Infinity : Number(flagValue("--limit"));
  const reportFile = flagValue("--report");

  const selected = selection.pending.length;
  const pending = selection.pending.slice(0, limit);
  const calls = Math.ceil(pending.length / STRENGTH_BATCH_SIZE);
  console.info(
    `[backfill-disclosed-share] ${mode}: ${selected} edges selected (${selection.summary}), ` +
      `${pending.length} to classify in ${calls} model calls${dryRun ? " (dry run: nothing is written)" : ""}`,
  );
  if (pending.length > maxEdges) {
    throw new Error(`${mode}: ${pending.length} edges is over --max-edges ${maxEdges}; raise it to go on`);
  }
  if (pending.length === 0) return;

  await loadDesktopEnv();
  const usage = createTokenUsage();
  const inputs = pending.map(({ root, index }) => inputOf(roots[root]!, index));
  const resolved = await classifyEdgesStrength(inputs, undefined, usage);

  const outcomeOf = (e: ValidatedEdge, s: EdgeStrength) =>
    s.strength_basis === "unclassified" ? "still unclassified" : s.strength_tier === e.strength_tier && e.strength_basis === "classified" ? "same" : "changed";

  // Second pass over the first pass's changes: a change stands only when both agree.
  let callsTotal = calls;
  const second = new Map<number, EdgeStrength>();
  if (!process.argv.includes("--single-pass")) {
    const recheck = pending.map((p, i) => i).filter((i) => outcomeOf(roots[pending[i]!.root]!.edges[pending[i]!.index]!, resolved[i]!) === "changed");
    if (recheck.length > 0) {
      const again = await classifyEdgesStrength(recheck.map((i) => inputs[i]!), undefined, usage);
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
      evidence_quotes: inputs[i]!.evidence_quotes ?? [],
      ...(inputs[i]!.category_dependence ? { category_dependence: inputs[i]!.category_dependence } : {}),
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
  if (reportFile) await writeFile(reportFile, JSON.stringify({ mode, calls: callsTotal, usage, tally, edges: report }, null, 2), "utf8");
  console.info(
    `[backfill-disclosed-share] ${mode}: ${tally.changed} changed, ${tally.same} confirmed, ` +
      `${tally.unconfirmed} changed on one pass only (kept as they were), ${tally.stillUnclassified} still unclassified (kept as they were); ` +
      `${callsTotal} model calls, ${usage.inputTokens} input / ${usage.outputTokens} output tokens; ${written} files written`,
  );
  if (changes.length) console.info(changes.join(String.fromCharCode(10)));
}

/**
 * --merge-duplicates: one edge per filer, counterparty and category (see the
 * header). Writes the files that changed.
 */
async function mergeDuplicates(roots: Root[], researchDir: string, dryRun: boolean): Promise<void> {
  const reportFile = flagValue("--report");
  const plans = roots.map((r) => mergeSameCounterpartyEdges(r.edges));
  const jobs: Array<{ root: number; merge: (typeof plans)[number]["merges"][number] }> = [];
  plans.forEach((p, root) => p.merges.forEach((merge) => jobs.push({ root, merge })));
  const toJudge = jobs.filter((j) => j.merge.merged.disclosed_share_pct == null);
  const maxEdges = Number(flagValue("--max-edges") ?? 600);
  console.info(
    `[backfill-disclosed-share] merge-duplicates: ${jobs.length} groups (${jobs.reduce((n, j) => n + j.merge.from.length, 0)} edges) in ` +
      `${new Set(jobs.map((j) => j.root)).size} roots; ${toJudge.length} merged edges to judge twice in ${2 * Math.ceil(toJudge.length / STRENGTH_BATCH_SIZE)} model calls${dryRun ? " (dry run: nothing is written)" : ""}`,
  );
  if (toJudge.length > maxEdges) throw new Error(`merge-duplicates: ${toJudge.length} edges is over --max-edges ${maxEdges}`);
  if (jobs.length === 0) return;

  const usage = createTokenUsage();
  const inputs = toJudge.map(({ root, merge }) =>
    strengthInputForEdge(merge.merged, roots[root]!.filingText, plans[root]!.edges.map((e) => e.counterparty_name)),
  );
  let first: EdgeStrength[] = [];
  let second: EdgeStrength[] = [];
  if (inputs.length > 0) {
    await loadDesktopEnv();
    first = await classifyEdgesStrength(inputs, undefined, usage);
    second = await classifyEdgesStrength(inputs, undefined, usage);
  }

  const lines: string[] = [];
  const report: Array<Record<string, unknown>> = [];
  const tally = { agreed: 0, disagreed: 0, fromShare: 0 };
  for (const job of jobs) {
    const { merged, from } = job.merge;
    const k = toJudge.indexOf(job);
    let strength: EdgeStrength;
    let how: string;
    if (k < 0) {
      strength = resolveEdgeStrength({ disclosed_revenue_dependency_pct: merged.disclosed_share_pct });
      how = "stated share";
      tally.fromShare++;
    } else if (first[k]!.strength_basis !== "unclassified" && first[k]!.strength_tier === second[k]!.strength_tier) {
      strength = first[k]!;
      how = "both passes";
      tally.agreed++;
    } else {
      // The merged edge is new, so there is no "as it was" to keep: the lower
      // of two disagreeing passes, or the leading member's tier when neither
      // pass gave one.
      const judged = [first[k]!, second[k]!].filter((p) => p.strength_basis !== "unclassified");
      const lower = judged.sort((x, y) => x.strength - y.strength)[0];
      strength = lower ?? { strength: merged.strength, strength_tier: merged.strength_tier, strength_basis: merged.strength_basis };
      how = `passes disagreed (${first[k]!.strength_tier}/${second[k]!.strength_tier}): ${lower ? "took the lower" : "kept the leading member's"}`;
      tally.disagreed++;
    }
    const out = withStrength(merged, strength);
    plans[job.root]!.edges[job.merge.index] = out;
    lines.push(
      `  ${merged.root_ticker} [${merged.category}] ${from.map((e) => `${e.counterparty_name} (${e.strength_tier})`).join(" + ")} => ${out.counterparty_name}: ${out.strength_tier} (${how})`,
    );
    report.push({
      root_ticker: merged.root_ticker,
      category: merged.category,
      from: from.map((e) => ({ counterparty_name: e.counterparty_name, subtype: e.subtype, strength_tier: e.strength_tier, strength_basis: e.strength_basis, quotes: e.evidence.map((x) => x.quote) })),
      merged: { counterparty_name: out.counterparty_name, counterparty_ticker: out.counterparty_ticker, subtype: out.subtype, strength_tier: out.strength_tier, strength_basis: out.strength_basis },
      passes: k < 0 ? null : [first[k]!.strength_tier, second[k]!.strength_tier],
      how,
      evidence_quotes: k < 0 ? out.evidence.map((x) => x.quote) : inputs[k]!.evidence_quotes,
      ...(k >= 0 && inputs[k]!.category_dependence ? { category_dependence: inputs[k]!.category_dependence } : {}),
    });
  }

  let written = 0;
  for (let i = 0; i < roots.length; i++) {
    if (plans[i]!.merges.length === 0) continue;
    roots[i]!.edges = plans[i]!.edges;
    if (!dryRun) {
      await writeFile(path.join(researchDir, roots[i]!.file), stringifyLike(roots[i]!.raw, plans[i]!.edges), "utf8");
      written++;
    }
  }
  if (reportFile) await writeFile(reportFile, JSON.stringify({ mode: "merge-duplicates", usage, tally, groups: report }, null, 2), "utf8");
  console.info(
    `[backfill-disclosed-share] merge-duplicates: ${tally.agreed} tiers from two agreeing passes, ${tally.disagreed} from disagreeing passes (the lower), ` +
      `${tally.fromShare} from a stated share; ${usage.inputTokens} input / ${usage.outputTokens} output tokens; ${written} files written`,
  );
  console.info(lines.join(String.fromCharCode(10)));
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
  const roots: Root[] = [];
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
    roots.push({ file, raw: parsed.raw, edges: result.edges, filingText: await cachedSectionText(ticker, researchDir, cacheDir) });
    if (result.stamped > 0 && !dryRun) {
      await writeFile(path.join(researchDir, file), stringifyLike(parsed.raw, result.edges), "utf8");
      totals.rootsWritten++;
    }
  }
  if (recompute) await recomputeTiers(roots, researchDir, dryRun);
  if (process.argv.includes("--only-defaulted")) await reclassifyTwoPass("only-defaulted", roots, defaultedSelection(roots), researchDir, dryRun);
  if (process.argv.includes("--full-evidence")) await reclassifyTwoPass("full-evidence", roots, fullEvidenceSelection(roots), researchDir, dryRun);
  if (process.argv.includes("--merge-duplicates")) await mergeDuplicates(roots, researchDir, dryRun);
  const named = flagValue("--edges");
  if (named) await reclassifyTwoPass("edges", roots, namedEdgesSelection(roots, named), researchDir, dryRun);
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
