import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPerplexityHealth,
  generateDailyTopSignal,
  getDailySignalDateKey,
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
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const health = await checkPerplexityHealth();
console.log("perplexity health:", health);

const date = getDailySignalDateKey();
console.log("signal date:", date);

try {
  const signal = await generateDailyTopSignal(date);
  console.log("generated:", JSON.stringify(signal, null, 2));
} catch (err) {
  console.error("generate failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
