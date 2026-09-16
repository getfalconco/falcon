/**
 * Replay the extraction dataset against a model and score what changed.
 *
 *   FALCON_EVAL_KEY=sk-... FALCON_EVAL_MODEL=z-ai/glm-5.2:free pnpm dataset:eval
 *   … FALCON_EVAL_CASES=40 FALCON_EVAL_BASE_URL=https://openrouter.ai/api/v1
 *
 * The point is not a leaderboard. These cases are the pipeline's own past
 * outputs, so the score measures DRIFT from the behaviour we already ship — a
 * model that scores 100% found exactly what the old one found, and one that
 * scores 60% is quietly dropping two relationships in five.
 *
 * That is the number a provider swap turns on, and until now "cheaper without
 * losing quality" was a claim nobody could check.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreDataset, type Dataset, type DatasetCase } from "../packages/research/src/dataset/index.js";
import { EXTRACTION_SYSTEM_PROMPT } from "../packages/research/src/step1/prompts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DATASET = path.join(ROOT, "data", "dataset", "extraction.json");

const KEY = process.env.FALCON_EVAL_KEY?.trim() ?? "";
const MODEL = process.env.FALCON_EVAL_MODEL?.trim() ?? "";
const BASE_URL = process.env.FALCON_EVAL_BASE_URL?.trim() || "https://openrouter.ai/api/v1";
const N = Number(process.env.FALCON_EVAL_CASES ?? 40);
/** Well under OpenRouter's 20/min so a long run does not trip the free tier. */
const SPACING_MS = Number(process.env.FALCON_EVAL_SPACING_MS ?? 3_500);

if (!KEY || !MODEL) {
  console.error(
    "\n  FALCON_EVAL_KEY and FALCON_EVAL_MODEL are required.\n\n" +
      "  FALCON_EVAL_KEY=sk-… FALCON_EVAL_MODEL=z-ai/glm-5.2:free pnpm dataset:eval\n",
  );
  process.exit(1);
}
if (!fs.existsSync(DATASET)) {
  console.error(`\n  No dataset at ${path.relative(ROOT, DATASET)} — run 'pnpm dataset:build' first.\n`);
  process.exit(1);
}

const dataset = JSON.parse(fs.readFileSync(DATASET, "utf8")) as Dataset;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A stratified sample, not the first N.
 *
 * 98 of the 459 cases contain nothing, and they are the ones that catch a model
 * inventing relationships. Taking the head of a ticker-sorted list would test
 * three companies and call it a run.
 */
function sample(cases: DatasetCase[], n: number): DatasetCase[] {
  const withEdges = cases.filter((c) => c.expected.length > 0);
  const empty = cases.filter((c) => c.expected.length === 0);
  const emptyShare = Math.max(1, Math.round((n * empty.length) / cases.length));
  const pick = <T,>(list: T[], k: number): T[] => {
    const step = Math.max(1, Math.floor(list.length / k));
    const out: T[] = [];
    for (let i = 0; i < list.length && out.length < k; i += step) out.push(list[i]!);
    return out;
  };
  return [...pick(withEdges, n - emptyShare), ...pick(empty, emptyShare)];
}

/** The extractor's own JSONL contract, parsed the way the pipeline parses it. */
function parseJsonl(raw: string): DatasetCase["expected"] {
  const out: DatasetCase["expected"] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (!o.counterparty_name) continue;
      out.push({
        counterparty_name: String(o.counterparty_name),
        counterparty_type: String(o.counterparty_type ?? ""),
        category: String(o.category ?? ""),
        evidence_quote: String(o.evidence_quote ?? ""),
      });
    } catch {
      // A malformed line is a finding, not a crash: it means this model does
      // not hold the output contract, which is exactly what we are measuring.
    }
  }
  return out;
}

async function runCase(c: DatasetCase): Promise<{ actual: DatasetCase["expected"]; failed: boolean }> {
  try {
    // Raw fetch rather than the SDK: this script lives outside the workspace
    // packages, and one endpoint does not justify dragging the dependency
    // graph along to reach it.
    const res = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": KEY,
        Authorization: `Bearer ${KEY}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 12_000,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `ROOT company: ${c.ticker}\n\n"""${c.chunk}"""` }],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      // Not truncated: a 404 here is almost always "no endpoints matching your
      // guardrail restrictions and data policy", and the actionable half of
      // that sentence sits past any reasonable cut.
      throw new Error(`HTTP ${res.status} — ${body.slice(0, 400)}`);
    }
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (body.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    return { actual: parseJsonl(text), failed: false };
  } catch (err) {
    console.log(`    ${c.case_id}: ${err instanceof Error ? err.message : String(err)}`);
    return { actual: [], failed: true };
  }
}

async function main(): Promise<void> {
  const cases = sample(dataset.cases, N);
  const host = new URL(BASE_URL).host;
  console.log(`\n  model    ${MODEL}`);
  console.log(`  host     ${host}`);
  console.log(`  cases    ${cases.length} of ${dataset.cases.length}`);
  console.log(`  baseline ${dataset.source.candidates} relationships across ${dataset.source.filings} filings\n`);

  const results: Array<{ case_id: string; expected: DatasetCase["expected"]; actual: DatasetCase["expected"] }> = [];
  let failed = 0;
  for (const [i, c] of cases.entries()) {
    process.stdout.write(`\r  running ${i + 1}/${cases.length}…`);
    const { actual, failed: f } = await runCase(c);
    if (f) failed += 1;
    results.push({ case_id: c.case_id, expected: c.expected, actual });
    if (i < cases.length - 1) await sleep(SPACING_MS);
  }
  console.log("\r" + " ".repeat(40) + "\r");

  const score = scoreDataset(results);
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  console.log(`  kept          ${score.kept}`);
  console.log(`  lost          ${score.lost}   <- relationships the baseline found and this model did not`);
  console.log(`  added         ${score.added}   (new finds; not automatically wrong)`);
  console.log(`  recategorised ${score.recategorised}   (same company, different relationship — a silent meaning change)`);
  console.log(`  retention     ${score.retention == null ? "—" : pct(score.retention)}`);
  if (failed > 0) console.log(`  call failures ${failed}`);
  console.log("");

  if (score.regressions.length > 0) {
    console.log("  worst cases:");
    for (const r of score.regressions.slice(0, 5)) {
      console.log(`    ${r.case_id}  lost ${r.lost} of ${r.lost + r.kept}`);
    }
    console.log("");
  }

  const r = score.retention ?? 0;
  if (r >= 0.9) console.log("  PASS — keeps what the current pipeline finds.\n");
  else if (r >= 0.75) console.log("  MARGINAL — drops roughly one relationship in four. Read the worst cases before shipping.\n");
  else console.log("  FAIL — loses more than a quarter of what we already find.\n");
  process.exit(r >= 0.9 ? 0 : r >= 0.75 ? 2 : 3);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
