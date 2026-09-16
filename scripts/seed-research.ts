/**
 * Batch seed step1 research for many tickers.
 * Usage:
 *   pnpm seed -- MSFT AAPL GOOGL
 *   pnpm seed -- --file tickers.txt
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveResearchCacheDir,
  resolveResearchDataDir,
  runStep1Pipeline,
  tryLoadCachedResult,
} from "../packages/research/src/step1/index.js";
import { estimateCostUsd } from "../packages/research/src/step1/tokenUsage.js";
import type { Step1Result } from "../packages/research/src/step1/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGAR_DELAY_MS = 2_000;

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

async function parseTickers(argv: string[]): Promise<string[]> {
  const tickers: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--file" || arg === "-f") {
      const filePath = argv[++i];
      if (!filePath) throw new Error("--file requires a path");
      const raw = await readFile(path.resolve(filePath), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const t = line.replace(/#.*/, "").trim().toUpperCase();
        if (t) tickers.push(t);
      }
      continue;
    }
    if (arg.startsWith("-")) continue;
    tickers.push(arg.trim().toUpperCase());
  }
  return [...new Set(tickers)];
}

type Row = {
  ticker: string;
  status: "cached" | "ok" | "error";
  edges: number;
  method: string;
  costUsd: number;
  error?: string;
};

function summarize(result: Step1Result): Pick<Row, "edges" | "method" | "costUsd"> {
  return {
    edges: result.validated.length,
    method: result.stats.section_method,
    costUsd: result.stats.estimated_cost_usd ?? estimateCostUsd({
      inputTokens: result.stats.input_tokens ?? 0,
      outputTokens: result.stats.output_tokens ?? 0,
    }),
  };
}

async function main(): Promise<void> {
  await loadDesktopEnv();
  process.env.FALCON_RESEARCH_DATA_DIR =
    process.env.FALCON_RESEARCH_DATA_DIR ??
    path.join(repoRoot, "apps", "desktop", "data", "research");
  process.env.FALCON_RESEARCH_CACHE_DIR =
    process.env.FALCON_RESEARCH_CACHE_DIR ?? path.join(repoRoot, "data", "cache");

  const tickers = await parseTickers(process.argv.slice(2));
  if (tickers.length === 0) {
    console.error("Usage: pnpm seed -- TICKER [TICKER...] | --file tickers.txt");
    process.exit(1);
  }

  const dataDir = resolveResearchDataDir();
  const cacheDir = resolveResearchCacheDir();
  const rows: Row[] = [];

  console.log(`Seeding ${tickers.length} ticker(s) → ${dataDir}\n`);

  for (const ticker of tickers) {
    try {
      if (!process.argv.includes("--force")) {
        const cached = await tryLoadCachedResult(ticker, dataDir);
        if (cached) {
          const s = summarize(cached);
          rows.push({ ticker, status: "cached", ...s });
          console.log(`[${ticker}] cached — ${s.edges} edges`);
          continue;
        }
      }

      const result = await runStep1Pipeline(ticker, {
        dataDir,
        cacheDir,
        force: process.argv.includes("--force"),
        edgarDelayMs: EDGAR_DELAY_MS,
      });

      const s = summarize(result);
      rows.push({
        ticker,
        status: result.fromCache ? "cached" : "ok",
        ...s,
      });
      console.log(
        `[${ticker}] ${result.fromCache ? "cached" : "done"} — ${s.edges} edges · ${s.method} · $${s.costUsd.toFixed(4)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rows.push({
        ticker,
        status: "error",
        edges: 0,
        method: "—",
        costUsd: 0,
        error: message,
      });
      console.error(`[${ticker}] ERROR: ${message}`);
    }
  }

  console.log("\n=== Summary ===");
  console.log(
    "ticker".padEnd(8) +
      " | " +
      "edges".padStart(5) +
      " | " +
      "method".padEnd(18) +
      " | " +
      "cost".padStart(8) +
      " | status",
  );
  console.log("-".repeat(60));
  for (const row of rows) {
    const cost = row.status === "error" ? "—" : `$${row.costUsd.toFixed(4)}`;
    console.log(
      `${row.ticker.padEnd(8)} | ${String(row.edges).padStart(5)} | ${row.method.padEnd(18)} | ${cost.padStart(8)} | ${row.status}${row.error ? ` (${row.error.slice(0, 40)})` : ""}`,
    );
  }

  const totalCost = rows.reduce((sum, r) => sum + r.costUsd, 0);
  const ok = rows.filter((r) => r.status === "ok").length;
  const cached = rows.filter((r) => r.status === "cached").length;
  const failed = rows.filter((r) => r.status === "error").length;
  console.log(`\n${ok} run, ${cached} cached, ${failed} failed · est. cost $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
