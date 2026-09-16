/**
 * End-to-end deep analysis verify for the BIIB Leqembi IQLIK approval event.
 * Loads apps/desktop/.env.local secrets. Prints briefing + checklist verdict.
 *
 * Usage: npx tsx packages/research/scripts/verify-biib-deep-analysis.mts
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSignalDeepAnalysis } from "../src/dailySignal/generateSignalDeepAnalysis.js";
import { validateAnalysisWithSeverity } from "../src/dailySignal/validateSignalQuality.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function loadEnvFile(envPath: string, override = false): void {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i === -1) continue;
    const key = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim();
    if (!key) continue;
    if (override) {
      if (!value && process.env[key]?.trim()) continue;
      process.env[key] = value;
      continue;
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(root, ".env"));
loadEnvFile(path.join(root, ".env.local"));
loadEnvFile(path.join(root, "apps/desktop/.env"));
// Local desktop secrets win (Massive key). Skip blank overrides from tracked .env.
loadEnvFile(path.join(root, "apps/desktop/.env"), true);
loadEnvFile(path.join(root, "apps/desktop/.env.local"), true);

const signal = {
  id: "verify-biib-leqembi-iqlik-2026-07-13",
  signalDate: "2026-07-17",
  eventAt: "2026-07-13T16:00:00.000Z",
  commercialAvailabilityAt: "late August 2026",
  headline:
    "FDA approves LEQEMBI IQLIK subcutaneous initiation dose for early Alzheimer's (Eisai/Biogen)",
  insight:
    "Primary BIIB is context after public approval. Second-order question is which connected names (competitors, autoinjector/fill suppliers, infusion-center demand losers) remain unpriced and material.",
  tickers: [
    {
      symbol: "BIIB",
      direction: "positive" as const,
      role: "primary_context" as const,
      materiality: "unknown" as const,
      mechanism: "headline co-commercializer of approved SC initiation dose",
    },
    {
      symbol: "CVS",
      direction: "positive" as const,
      role: "connected_edge" as const,
      materiality: "immaterial" as const,
      mechanism: "specialty pharmacy / retail distribution of one drug",
    },
    {
      symbol: "UNH",
      direction: "positive" as const,
      role: "connected_edge" as const,
      materiality: "immaterial" as const,
      mechanism: "PBM/plan exposure to one Alzheimer's therapy",
    },
  ],
};

console.log("Generating deep analysis (network expansion + Massive + OpenAI)...");
const analysis = await generateSignalDeepAnalysis(signal);
console.log("\n========== BRIEFING ==========\n");
console.log(analysis);
console.log("\n========== CHECKLIST ==========\n");

const lower = analysis.toLowerCase();
const missingPrimary =
  /market reaction data is missing/i.test(analysis) &&
  !/\bBIIB\b[^\n%]{0,40}\d+(?:\.\d+)?\s*%/i.test(analysis) &&
  !/\d+(?:\.\d+)?\s*%[^\n]{0,40}\bBIIB\b/i.test(analysis);
const pricedIn = /\bno edge\.?\s*priced in\.?\b/i.test(analysis);
const hasPct = /\b\d+(?:\.\d+)?\s*%\b/.test(analysis);
const watchPrimary = /^\s*Watch:\s*BIIB\b/im.test(analysis);
const watchCvs = /^\s*Watch:\s*CVS\b/im.test(analysis);
const watchUnh = /^\s*Watch:\s*UNH\b/im.test(analysis);
const dirPrimary = /^\s*BIIB\s*:\s*(positive|negative)\s*$/im.test(analysis);
const mentionsLoser =
  /infusion|loser|lose volume|demand.?side|kisunla|donanemab|competitor|autoinjector|fill[- ]finish/i.test(
    analysis,
  );
const q3Watch = /by Q3 2026/i.test(analysis);
const hasEventDate = /\b(20\d{2}-\d{2}-\d{2}|july\s+\d{1,2},?\s*2026|\d{1,2}\s+july\s+2026)\b/i.test(
  analysis,
);

const validation = validateAnalysisWithSeverity(analysis, {
  tickerCount: signal.tickers.length,
  tickers: signal.tickers,
  headline: signal.headline,
  commercialAvailabilityAt: signal.commercialAvailabilityAt,
});

const checks: Array<[string, boolean]> = [
  ["primary measured moves cited (not blank missing)", !missingPrimary],
  ["if Priced in, has measured %", !pricedIn || hasPct],
  ["explicit event date in briefing", hasEventDate],
  ["no Watch on BIIB primary", !watchPrimary],
  ["no Watch on immaterial CVS", !watchCvs],
  ["no Watch on immaterial UNH", !watchUnh],
  ["no directional BIIB conclusion line", !dirPrimary],
  ["network/loser-or-competitor language present", mentionsLoser],
  ["no unrealistic by Q3 2026 watch after late Aug launch", !q3Watch],
  ["validator not reject", validation.nextAction !== "reject"],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  if (!ok) failed += 1;
}
console.log("\nValidator:", validation.nextAction, {
  repairable: validation.repairableErrors,
  warnings: validation.warnings,
  fatal: validation.fatalErrors,
});

if (failed > 0) {
  console.error(`\n${failed} checklist item(s) failed`);
  process.exit(1);
}
console.log("\nAll checklist items passed");
