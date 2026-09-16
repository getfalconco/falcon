import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dailySignalUserPrompt,
  DAILY_SIGNAL_PROMPT_VERSION,
  DAILY_SIGNAL_SYSTEM_PROMPT,
} from "../src/dailySignal/prompts.js";
import { getDailySignalDateKey } from "../src/dailySignal/generateDailyTopSignal.js";
import {
  SIGNAL_DEEP_ANALYSIS_PROMPT,
  SIGNAL_DEEP_ANALYSIS_PROMPT_VERSION,
  signalDeepAnalysisUserPrompt,
} from "../src/dailySignal/deepAnalysis.js";
import { getConfig } from "../src/config.js";
import { logDailySignalPrompt } from "../src/dailySignal/logPrompt.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envPath = path.join(root, "apps/desktop/.env");

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i === -1) continue;
    const key = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim();
    if (key) process.env[key] = value;
  }
}

const config = getConfig();
const signalDate = getDailySignalDateKey();
const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

let signal = {
  headline: "[example headline]",
  insight: "[example insight]",
  tickers: [{ symbol: "KTOS", direction: "mixed" as const }],
  signalDate,
  sourceUrls: ["https://example.com/source"],
};

if (url && key) {
  const res = await fetch(
    `${url}/rest/v1/daily_top_signals?signal_date=eq.${signalDate}&select=*&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (res.ok) {
    const rows = (await res.json()) as Array<{
      headline: string;
      insight: string;
      tickers: typeof signal.tickers;
      source_urls?: string[];
    }>;
    const row = rows[0];
    if (row) {
      signal = {
        headline: row.headline,
        insight: row.insight,
        tickers: row.tickers ?? [],
        signalDate,
        sourceUrls: row.source_urls ?? [],
      };
    }
  }
}

console.log("=== Meridian daily signal prompt audit ===");
console.log("signal date:", signalDate);
console.log("discovery model:", config.discoveryModel);
console.log(
  "analysis model:",
  process.env.PERPLEXITY_DAILY_SIGNAL_MODEL?.trim() || config.perplexityDeepModel,
);
console.log("analysis max tokens:", config.signalAnalysisMaxTokens);
console.log("");

logDailySignalPrompt({
  phase: "discovery",
  version: DAILY_SIGNAL_PROMPT_VERSION,
  model: config.discoveryModel,
  system: DAILY_SIGNAL_SYSTEM_PROMPT,
  user: dailySignalUserPrompt(signalDate),
});

console.log("");

logDailySignalPrompt({
  phase: "analysis",
  version: SIGNAL_DEEP_ANALYSIS_PROMPT_VERSION,
  model: process.env.PERPLEXITY_DAILY_SIGNAL_MODEL?.trim() || config.perplexityDeepModel,
  system: SIGNAL_DEEP_ANALYSIS_PROMPT,
  user: signalDeepAnalysisUserPrompt({
    headline: signal.headline,
    insight: signal.insight,
    tickers: signal.tickers,
    signalDate,
    researchContext:
      signal.sourceUrls.length > 0
        ? signal.sourceUrls.map((u, i) => `${i + 1}. ${u}`).join("\n")
        : undefined,
  }),
});
