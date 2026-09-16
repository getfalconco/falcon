/**
 * Re-run MSFT extraction and print every unparseable JSONL line (first 100 chars).
 * Usage: node --import tsx scripts/inspect-parse-errors.ts [TICKER]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callClaudeJson } from "../packages/research/src/step1/anthropicClient.js";
import { parseCandidateJsonl } from "../packages/research/src/step1/extractCandidates.js";
import { chunkText, fetchLatest10K } from "../packages/research/src/step1/fetchFiling.js";
import { EXTRACTION_SYSTEM_PROMPT } from "../packages/research/src/step1/prompts.js";
import { stripJsonFences } from "../packages/research/src/step1/normalize.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadDesktopEnv(): Promise<void> {
  try {
    const raw = await readFile(path.join(repoRoot, "apps/desktop/.env"), "utf8");
    for (const line of raw.split("\n")) {
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

function collectUnparseable(raw: string, chunkIndex: number): string[] {
  const cleaned = stripJsonFences(raw);
  const failures: string[] = [];
  for (const line of cleaned.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^```(?:json)?\s*$/i.test(trimmed)) continue;
    if (trimmed === "[" || trimmed === "]" || trimmed === ",") continue;
    const jsonLine = trimmed.replace(/,\s*$/, "");
    try {
      JSON.parse(jsonLine);
    } catch {
      failures.push(jsonLine.slice(0, 100));
    }
  }
  if (failures.length) {
    console.log(`\n--- chunk ${chunkIndex}: ${failures.length} unparseable line(s) ---`);
    for (const snippet of failures) {
      console.log(snippet);
    }
  }
  return failures;
}

const ticker = (process.argv[2] ?? "MSFT").trim().toUpperCase();
const legacy300k = process.argv.includes("--legacy-300k");

async function main(): Promise<void> {
  await loadDesktopEnv();
  const filing = await fetchLatest10K(ticker);
  let section = filing.itemSpan;
  if (legacy300k) {
    const starts = [...filing.plainText.matchAll(/item\s*1\s*[.:\-–—]?\s*business/gi)];
    const start = starts.length ? starts[starts.length - 1]!.index! : 0;
    section = filing.plainText.slice(start, Math.min(start + 300_000, filing.plainText.length));
    console.log(`(legacy-300k) start=${start}, section=${section.length} chars`);
  }
  const chunks = chunkText(section, 24_000, 1_000);

  console.log(
    `${ticker}: ${filing.sectionMethod}, ${filing.itemSpan.length} section chars, ${chunks.length} chunks`,
  );

  const allFailures: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const user = `ROOT company: ${filing.companyName} (${filing.ticker})\n\n"""${chunk}"""`;
    const raw = await callClaudeJson({
      system: EXTRACTION_SYSTEM_PROMPT,
      user,
      maxTokens: 8000,
    });
    const { candidates, unparseableLines } = parseCandidateJsonl(raw, i);
    allFailures.push(...collectUnparseable(raw, i));
    console.log(`chunk ${i}: ${candidates.length} parsed, ${unparseableLines} parse errors`);
  }

  console.log(`\n=== Total unparseable lines: ${allFailures.length} ===`);
  for (let n = 0; n < allFailures.length; n++) {
    console.log(`${n + 1}. ${allFailures[n]}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
