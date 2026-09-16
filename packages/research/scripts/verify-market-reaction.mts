/**
 * Verify deterministic market-reaction fetch for BIIB + connected names.
 * Loads secrets from apps/desktop/.env.local (gitignored) then apps/desktop/.env.
 *
 * Usage: npx tsx packages/research/scripts/verify-market-reaction.mts
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applySecondOrderTickerGates,
  buildMarketReactionBundles,
  fetchPriceMoveSinceEvent,
} from "../src/dailySignal/secondOrderEdge.js";

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
loadEnvFile(path.join(root, "apps/desktop/.env"), true);
loadEnvFile(path.join(root, "apps/desktop/.env.local"), true);

const EVENT_DATE = process.env.VERIFY_EVENT_DATE ?? "2026-07-13";
const PRIMARY = "BIIB";
const CONNECTED = (process.env.VERIFY_CONNECTED ?? "CVS,UNH,AMGN,LLY")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

console.log("MASSIVE_API_KEY set:", Boolean(process.env.MASSIVE_API_KEY?.trim()));
console.log("event date:", EVENT_DATE);
console.log("symbols:", [PRIMARY, ...CONNECTED].join(", "));

const eventDate = new Date(`${EVENT_DATE}T16:00:00.000Z`);
const primaryMoves = await fetchPriceMoveSinceEvent(PRIMARY, eventDate);
console.log("\n=== Primary", PRIMARY, "===");
console.log(JSON.stringify(primaryMoves, null, 2));

const bundles = await buildMarketReactionBundles({
  primarySymbol: PRIMARY,
  edgeSymbols: CONNECTED,
  eventAt: EVENT_DATE,
});
console.log("\n=== Market reaction bundles ===");
for (const b of bundles) {
  console.log(
    `${b.ticker}: eventDay=${b.eventDayMovePct?.toFixed(2) ?? "n/a"}% nextDay=${b.nextDayMovePct?.toFixed(2) ?? "n/a"}% since=${b.sinceEventMovePct?.toFixed(2) ?? "n/a"}% priced=${b.pricedSinceEvent} src=${b.dataSource ?? "n/a"} missing=${b.missingData.join("|") || "none"}`,
  );
}

const gated = applySecondOrderTickerGates(
  [
    {
      symbol: PRIMARY,
      direction: "positive",
      role: "primary_context",
      mechanism: "headline approval / launch",
    },
    ...CONNECTED.map((symbol) => ({
      symbol,
      direction: "negative" as const,
      role: "connected_edge" as const,
      materiality:
        symbol === "CVS" || symbol === "UNH"
          ? ("immaterial" as const)
          : ("material" as const),
      mechanism:
        symbol === "CVS" || symbol === "UNH"
          ? "one-drug pharmacy/PBM scale"
          : "competitive or demand-side network exposure",
    })),
  ],
  bundles,
);

console.log("\n=== Gate outcome ===");
console.log({
  outcome: gated.outcome,
  primaryPricedIn: gated.primaryPricedIn,
  priceDataMissing: gated.priceDataMissing,
  dropped: gated.dropped,
});

const measured = bundles.filter((b) => b.sinceEventMovePct != null || b.eventDayMovePct != null);
if (measured.length === 0) {
  console.error("\nFAIL: no measured price moves — check MASSIVE_API_KEY / Yahoo fallback");
  process.exit(1);
}

if (gated.outcome === "price_data_missing") {
  console.error("\nFAIL: gate outcome is price_data_missing despite measured bundles");
  process.exit(1);
}

const biib = bundles.find((b) => b.ticker === "BIIB");
if (biib?.eventDayMovePct != null) {
  console.log(
    `\nBIIB event-day move: ${biib.eventDayMovePct.toFixed(2)}% (expected ~+5% on 2026-07-13 approval day)`,
  );
}
if (biib?.nextDayMovePct != null) {
  console.log(
    `BIIB next-day move: ${biib.nextDayMovePct.toFixed(2)}% (expected large reversal next session — verify manually)`,
  );
}

// Soft band check for the known approval-day pop
if (biib?.eventDayMovePct != null) {
  const day = biib.eventDayMovePct;
  if (day < 2.5) {
    console.warn(
      `WARN: BIIB event-day move ${day.toFixed(2)}% is below +2.5% — confirm VERIFY_EVENT_DATE matches approval session`,
    );
  } else {
    console.log("OK: BIIB event-day move clears +2.5% priced threshold");
  }
}

console.log("\nPASS: price fetch returned measured moves; gate outcome =", gated.outcome);
