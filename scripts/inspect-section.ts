/**
 * Debug helper: fetch a ticker filing, dump cleaned plain text, print anchor positions.
 * Usage: pnpm exec tsx scripts/inspect-section.ts [TICKER]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractFilingSection,
  fetchLatest10K,
} from "../packages/research/src/step1/fetchFiling.js";

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
    // .env optional when vars already exported
  }
}

const ticker = (process.argv[2] ?? "MSFT").trim().toUpperCase();

function printMatches(label: string, re: RegExp, text: string, limit: number): void {
  const head = text.slice(0, limit);
  console.log(`\n=== /${label}/ matches in first ${limit} chars ===`);
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const regex = new RegExp(re.source, flags);
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(head)) !== null) {
    count++;
    const snippet = head.slice(m.index, m.index + 80).replace(/\s+/g, " ");
    console.log(`  pos ${m.index}: ${snippet}`);
  }
  if (count === 0) console.log("  (none)");
}

async function main(): Promise<void> {
  await loadDesktopEnv();
  console.log(`Inspecting ${ticker}…`);

  const filing = await fetchLatest10K(ticker);
  const plain = filing.plainText;

  const debugDir = path.join(repoRoot, "data/debug");
  await mkdir(debugDir, { recursive: true });
  const outPath = path.join(debugDir, `${ticker.toLowerCase()}.txt`);
  await writeFile(outPath, plain, "utf8");
  console.log(`Wrote ${plain.length.toLocaleString()} chars to ${outPath}`);

  printMatches("item\\s*1", /item\s*1/gi, plain, 40_000);
  printMatches("business", /business/gi, plain, 40_000);
  printMatches("item\\s*2", /item\s*2/gi, plain, 40_000);

  const { text: itemSpan, sectionMethod } = extractFilingSection(plain, filing.form);
  console.log(`\nform: ${filing.form}`);
  console.log(`section_method: ${sectionMethod}`);
  console.log(`fetchLatest10K sectionMethod: ${filing.sectionMethod}`);
  console.log(`section_chars: ${itemSpan.length.toLocaleString()}`);
  console.log(`plainText_chars: ${plain.length.toLocaleString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
