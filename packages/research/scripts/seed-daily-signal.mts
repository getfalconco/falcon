import { readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateDailyTopSignal,
  getDailySignalDateKey,
  packSignalInsight,
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
    if (key) process.env[key] = value;
  }
}

const forceRefresh = process.argv.includes("--force");
const signalDate = getDailySignalDateKey();
const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

async function deleteExistingSignal(): Promise<void> {
  const res = await fetch(
    `${url}/rest/v1/daily_top_signals?signal_date=eq.${signalDate}`,
    {
      method: "DELETE",
      headers: {
        apikey: key!,
        Authorization: `Bearer ${key}`,
        "User-Agent": "MeridianDesktop/1.0",
      },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn("Supabase delete warning:", res.status, text.slice(0, 200));
  } else {
    console.log("Deleted existing signal for", signalDate);
  }
}

function clearLocalDesktopCache(): void {
  const appData =
    process.env.APPDATA ??
    path.join(process.env.USERPROFILE ?? "", "AppData", "Roaming");
  const cacheFile = path.join(appData, "desktop", "cache", "daily-signals", `${signalDate}.json`);
  if (existsSync(cacheFile)) {
    try {
      unlinkSync(cacheFile);
      console.log("Cleared local cache:", cacheFile);
    } catch (err) {
      console.warn("Could not clear local cache:", err);
    }
  }
}

if (forceRefresh) {
  await deleteExistingSignal();
  clearLocalDesktopCache();
}

console.log(forceRefresh ? "Regenerating" : "Generating", "signal for", signalDate, "...");
console.log("(pipeline retries internally — expect several minutes with sonar-deep-research)");

let signal;
try {
  signal = await generateDailyTopSignal(signalDate);
} catch (err) {
  console.error("Generation failed (empty day forbidden):", err);
  process.exit(1);
}

const body: Record<string, unknown> = {
  signal_date: signalDate,
  id: signal.id,
  headline: signal.headline,
  insight: packSignalInsight(signal.insight, signal.mechanism, signal.intelligence),
  tickers: signal.tickers,
  source_urls: signal.sourceUrls ?? [],
  generated_at: new Date().toISOString(),
};
if (signal.mechanism) body.mechanism = signal.mechanism;

console.log("tickers:", signal.tickers.length, "sources:", signal.sourceUrls?.length ?? 0);
console.log("insight chars:", signal.insight.length);
console.log("recent:", signal.intelligence?.recent.headline?.slice(0, 80));
console.log("upcoming:", signal.intelligence?.upcoming.headline?.slice(0, 80));

async function upsertSignal(body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${url}/rest/v1/daily_top_signals`, {
    method: "POST",
    headers: {
      apikey: key!,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
      "User-Agent": "MeridianDesktop/1.0",
    },
    body: JSON.stringify(body),
  });

  if (res.ok) return true;

  const text = await res.text();
  if (body.mechanism && text.includes("mechanism")) {
    const { mechanism: _removed, ...fallback } = body;
    return upsertSignal(fallback);
  }

  console.error("Supabase upsert failed:", res.status, text);
  return false;
}

if (!(await upsertSignal(body))) process.exit(1);

console.log("Saved to Supabase:", signal.headline);
