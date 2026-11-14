/**
 * Dry run of the event detectors (src/detectors): prints the events found in
 * a window as JSON on stdout, the run log on stderr. Reads EDGAR (and Claude
 * for the LLM classes); writes nothing but the local HTTP cache.
 *
 *   pnpm --filter @falcon/engine exec node --import tsx scripts/detect.ts --days 7 --types insider_cluster,distress_nt
 *
 * Flags:
 *   --days N         window = the last N days up to now (default 1)
 *   --since ISO      window start (overrides --days)
 *   --until ISO      window end (default now)
 *   --types a,b      event types to run (default: all registered)
 *   --budget USD     LLM budget for the run (default 0.5)
 *   --out FILE       also write the JSON to FILE
 *   --summary        print counts and titles instead of the full JSON
 */

import fs from "node:fs";
import { DETECTORS, detectAll } from "../src/detectors/index.ts";
import type { EventType } from "../src/detectors/types.ts";
import { llmUsage } from "../src/detectors/llm.ts";
import { poolStats } from "../src/feed/sec-pool.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const until = arg("until") ? new Date(arg("until")!) : new Date();
const days = Number(arg("days") ?? 1);
const since = arg("since") ? new Date(arg("since")!) : new Date(until.getTime() - days * 86_400_000);
const types = arg("types")?.split(",").map((s) => s.trim()).filter(Boolean) as EventType[] | undefined;
const budget = Number(arg("budget") ?? 0.5);

const detectors = types ? DETECTORS.filter((d) => d.eventTypes.some((t) => types.includes(t))) : DETECTORS;
if (types) {
  const known = new Set(DETECTORS.flatMap((d) => d.eventTypes));
  const unknown = types.filter((t) => !known.has(t));
  if (unknown.length) {
    console.error(`unknown types: ${unknown.join(", ")} (known: ${[...known].join(", ")})`);
    process.exit(2);
  }
}

const t0 = Date.now();
const log = (line: string) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
log(`window ${since.toISOString()} .. ${until.toISOString()}, detectors: ${detectors.map((d) => d.eventTypes.join("/")).join(", ")}`);
const events = (await detectAll({ since, until, llmBudgetUsd: budget, dryRun: true, log }, detectors)).filter((e) => !types || types.includes(e.eventType));
const u = llmUsage();
log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${events.length} events; LLM ${u.calls} calls, ${u.inputTokens} in / ${u.outputTokens} out tokens, $${u.costUsd.toFixed(4)}${u.skipped ? ` (${u.skipped} calls skipped: no key or budget spent)` : ""}; SEC bulk reads ${poolStats.network} from the network, ${poolStats.cached} from the cache`);

const json = JSON.stringify(events, null, 2);
const out = arg("out");
if (out) fs.writeFileSync(out, json);
if (process.argv.includes("--summary")) {
  const by = new Map<string, typeof events>();
  for (const e of events) by.set(e.eventType, [...(by.get(e.eventType) ?? []), e]);
  for (const [t, es] of by) {
    console.log(`\n${t}: ${es.length}`);
    for (const e of es) {
      const watch = e.watchOnlyReasons.length ? ` [watch: ${e.watchOnlyReasons.join("; ")}]` : "";
      console.log(`  ${e.acceptedAt} ${e.ticker ?? "-"} ${e.title}${watch}\n      ${e.sources[0]?.url ?? ""}`);
    }
  }
} else console.log(json);
