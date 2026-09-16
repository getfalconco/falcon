/**
 * Quick smoke test for rolling daily intelligence generation.
 * Loads apps/desktop/.env and runs one generateDailyTopSignal call.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateDailyTopSignal,
  getDailySignalDateKey,
  getConfig,
  hasConcreteDualIntelligence,
} from "../src/index.js";

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
    // Force our fast defaults for this smoke test regardless of .env deep model.
    if (key === "DISCOVERY_RESEARCH_MODEL" || key === "DISCOVERY_SYNTHESIS_MODEL") continue;
    if (key === "PERPLEXITY_DAILY_SIGNAL_MODEL" || key === "PERPLEXITY_DEEP_MODEL") continue;
    if (key) process.env[key] = value;
  }
}

process.env.DISCOVERY_RESEARCH_MODEL = "sonar-pro";
process.env.DISCOVERY_SYNTHESIS_MODEL = "sonar-pro";
process.env.DISCOVERY_MAX_ATTEMPTS = "1";
process.env.DISCOVERY_REASONING_EFFORT = "low";
process.env.DISCOVERY_SEARCH_CONTEXT_SIZE = "medium";
process.env.DISCOVERY_MAX_TOKENS = "4000";

const cfg = getConfig();
console.log("config", {
  research: cfg.discoveryResearchModel,
  attempts: cfg.discoveryMaxAttempts,
  perplexityKey: cfg.perplexityApiKey ? `set(${cfg.perplexityApiKey.slice(0, 8)})` : "MISSING",
  openaiKey: cfg.openaiApiKey ? `set(${cfg.openaiApiKey.slice(0, 8)})` : "MISSING",
});

const date = getDailySignalDateKey();
console.log("generating for", date, "...");
const started = Date.now();

try {
  const signal = await generateDailyTopSignal(date);
  console.log("SUCCESS in", Date.now() - started, "ms");
  console.log("headline:", signal.headline.slice(0, 120));
  console.log("dual:", hasConcreteDualIntelligence(signal.intelligence));
  console.log("recent:", signal.intelligence?.recent.headline.slice(0, 100));
  console.log("upcoming:", signal.intelligence?.upcoming.headline.slice(0, 100));
  console.log("tickers:", signal.tickers.map((t) => t.symbol).join(","));
  console.log("sources:", signal.sourceUrls?.length ?? 0);
} catch (err) {
  console.error("FAILED in", Date.now() - started, "ms");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
