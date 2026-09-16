/**
 * Billing verification, from the command line.
 *
 *   ANTHROPIC_API_KEY=<key> pnpm verify-billing
 *   ANTHROPIC_API_KEY=<key> ANTHROPIC_BASE_URL=https://api.oneprovider.dev pnpm verify-billing
 *
 * Sends one identical payload to the provider twice — once to be COUNTED, once
 * to be PROCESSED — and reports whether the two agree. Both numbers come from
 * the provider, so a gap is the provider disagreeing with its own tokeniser
 * rather than with our estimate, which is the only form of this argument a
 * vendor cannot answer by disputing our arithmetic.
 *
 * The key is read from the environment and never written anywhere. One run
 * bills a single 24k-character prompt with `max_tokens: 1` — about two cents.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProbePayload, probeTokenBilling, verdictFrom } from "../packages/research/src/billing/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = Number(process.env.BILLING_PROBE_SAMPLES ?? 3);

/** Real filing text if the cache has any; otherwise representative prose. */
function corpus(): string {
  const cache = path.resolve(HERE, "..", "apps", "desktop", "data", "cache");
  try {
    const file = fs.readdirSync(cache).find((f) => f.endsWith(".txt"));
    if (file) return fs.readFileSync(path.join(cache, file), "utf8");
  } catch {
    // No cache checked out — the ratio is a ratio either way.
  }
  return (
    "We depend on a limited number of suppliers for certain components used in our " +
    "products, and in some cases a single source. Any disruption in supply could " +
    "materially and adversely affect our results of operations. We compete with " +
    "companies that have substantially greater financial and technical resources. "
  ).repeat(400);
}

function bar(ratio: number): string {
  const filled = Math.min(40, Math.round(ratio * 20));
  return "█".repeat(filled) + "░".repeat(Math.max(0, 40 - filled));
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    console.error(
      "ANTHROPIC_API_KEY is not set.\n\n" +
        "  ANTHROPIC_API_KEY=<key> pnpm verify-billing\n",
    );
    process.exit(1);
  }
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  const model = process.env.FALCON_MODEL?.trim() || "claude-sonnet-5";
  const host = baseUrl ? new URL(baseUrl).host : "api.anthropic.com";
  const { system, user } = buildProbePayload(corpus());

  console.log(`\n  host    ${host}`);
  console.log(`  model   ${model}`);
  console.log(`  payload ${(system.length + user.length).toLocaleString()} chars`);
  console.log(`  samples ${SAMPLES}\n`);

  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    process.stdout.write(`  probe ${i + 1}/${SAMPLES} … `);
    const sample = await probeTokenBilling({ baseUrl, apiKey, model, system, user });
    samples.push(sample);
    if (!sample.ok) {
      console.log(`failed — ${sample.error}`);
      continue;
    }
    const billed =
      sample.billedInputTokens +
      sample.billedCacheCreationTokens +
      sample.billedCacheReadTokens;
    console.log(
      `counted ${sample.countedInputTokens.toLocaleString()} · ` +
        `billed ${billed.toLocaleString()} · ${sample.ratio.toFixed(2)}x`,
    );
    // The cache split, broken out: the provider was writing cache on payloads
    // that never asked for it and reading almost none of it back, and a total
    // hides that entirely. `write 0` is the answer to "is it off yet".
    // Cache is a copy of the prompt prefix, so it cannot be larger than the
    // prompt. A write above the counted size is not a pricing disagreement,
    // it is an arithmetic impossibility, and it is worth naming as one.
    const overWrite =
      sample.billedCacheCreationTokens > sample.countedInputTokens
        ? ` (${(sample.billedCacheCreationTokens / sample.countedInputTokens).toFixed(2)}x the payload — impossible)`
        : "";
    console.log(
      `           input ${sample.billedInputTokens.toLocaleString()} · ` +
        `cache write ${sample.billedCacheCreationTokens.toLocaleString()} · ` +
        `cache read ${sample.billedCacheReadTokens.toLocaleString()}` +
        (sample.billedCacheCreationTokens === 0 ? "   <- cache write OFF" : overWrite),
    );
  }

  const verdict = verdictFrom(samples);
  console.log("");
  if (verdict.medianRatio == null) {
    console.log("  No usable samples — every probe failed. See the errors above.\n");
    process.exit(2);
  }

  const impossible = samples.filter(
    (s) => s.ok && s.billedCacheCreationTokens > s.countedInputTokens,
  );
  if (impossible.length > 0) {
    console.log(
      `  ${impossible.length} probe(s) wrote MORE cache than the payload contains — ` +
        `cache cannot exceed the prompt it copies.`,
    );
  }
  const totalWrite = samples.reduce((n, s) => n + s.billedCacheCreationTokens, 0);
  const totalRead = samples.reduce((n, s) => n + s.billedCacheReadTokens, 0);
  console.log(
    `  cache: ${totalWrite.toLocaleString()} written, ${totalRead.toLocaleString()} read` +
      (totalWrite === 0
        ? "  — nothing written, the surcharge is gone"
        : totalRead === 0
          ? "  — written and never read: still paying 1.25x for nothing"
          : ""),
  );
  console.log("");

  const r = verdict.medianRatio;
  console.log(`  1.0x  ${bar(1)}  honest`);
  console.log(`  ${r.toFixed(2)}x  ${bar(r)}  measured`);
  console.log("");

  if (!verdict.discrepancy) {
    console.log(`  PASS — ${host} bills the tokens it counts (${r.toFixed(2)}x).\n`);
    process.exit(0);
  }

  const pct = ((r - 1) * 100).toFixed(0);
  console.log(
    `  FAIL — ${host} bills ${r.toFixed(2)}x what its own count_tokens reports.\n` +
      `         That is ${pct}% more than the payload contains.\n` +
      `         Take this to the provider: the counted and billed figures are both theirs.\n`,
  );
  process.exit(3);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
