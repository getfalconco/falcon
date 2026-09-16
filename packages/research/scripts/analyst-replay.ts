/**
 * Analyst replay harness (spec §12 / §14 step 5) — three subcommands.
 *
 *   list      Replay Base over the recorded Tracker stream and list the
 *             incidents routed to `destination: analyst`, with their
 *             reaction_state and what the assembled prompt would carry.
 *             No model call.
 *
 *   dump      Write the analyst-routed incidents (with their Classifier
 *             verdicts) as fixture JSON files for the test suite / rubric.
 *
 *   generate  Replay-driven generation: run the live model over the
 *             analyst-routed incidents that have no output yet (within
 *             Base's daily budget) and persist the outputs to the analyst
 *             store on disk — the first rubric batch. Spends Anthropic quota.
 *
 * Usage:
 *   pnpm --filter @meridian/research exec tsx scripts/analyst-replay.ts list [--limit 3000]
 *   pnpm --filter @meridian/research exec tsx scripts/analyst-replay.ts dump --out <dir> [--ticker WMT]
 *   pnpm --filter @meridian/research exec tsx scripts/analyst-replay.ts generate [--max 10] [--ticker WMT] [--dry]
 *
 * Data dirs: FALCON_TRACKER_DATA_DIR / FALCON_BASE_DATA_DIR /
 * FALCON_CLASSIFIER_DATA_DIR / FALCON_ANALYST_DATA_DIR, defaulting to
 * apps/desktop/data/<engine>.
 */

import fs from "node:fs";
import path from "node:path";
import { loadBaseConfig } from "../src/base/store.js";
import { lookupFromVerdicts } from "../src/base/classification.js";
import { replayBase } from "../src/base/replay.js";
import { resolveTrackerDataDir } from "../src/tracker/store.js";
import type { TrackerMessage } from "../src/tracker/types.js";
import { FileBackend as ClassifierFileBackend, VerdictStore } from "../src/classifier/store.js";
import { ScreenMessageStore } from "../src/screen/store.js";
import {
  AnalystConfigStore,
  AnalystOutputStore,
  AnalystService,
  FileBackend as AnalystFileBackend,
  analystBudgetRemaining,
  anthropicConfigured,
  anthropicModelCaller,
  applyAnalystBudget,
  assembleInput,
  buildAnalystPrompt,
  buildAnalystRequests,
  analystKindOf,
  collectVerdicts,
  excludedCount,
  promptVersionFor,
  stableIncidentId,
} from "../src/analyst/index.js";
import { consumeBudget, type BudgetLedger } from "../src/base/classification.js";

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

function readMessages(): TrackerMessage[] {
  const file = path.join(resolveTrackerDataDir(), "messages.jsonl");
  const raw = fs.readFileSync(file, "utf8");
  const out: TrackerMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TrackerMessage);
    } catch {
      /* skip corrupt line */
    }
  }
  out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const limit = Number(arg("--limit", "0"));
  return limit > 0 ? out.slice(-limit) : out;
}

function setup() {
  const baseConfig = loadBaseConfig();
  const analystConfigStore = new AnalystConfigStore();
  const analystConfig = analystConfigStore.load();
  const verdictStore = new VerdictStore(new ClassifierFileBackend());
  const verdictLookup = lookupFromVerdicts(verdictStore.list(), baseConfig);
  // S2: Screen's emitted structures are part of the stream Base coordinates.
  let screenMessages: ReturnType<ScreenMessageStore["read"]> = [];
  try {
    screenMessages = new ScreenMessageStore().read({ limit: 500 });
  } catch {
    screenMessages = [];
  }
  const messages = [...readMessages(), ...screenMessages].sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
  );
  const now = new Date().toISOString();
  const replay = replayBase(messages, { config: baseConfig, now, verdictLookup, makeIncidentId: stableIncidentId });
  const analyst = replay.incidents.filter((r) => r.routing.destinations.some((d) => d.destination === "analyst"));
  const ticker = arg("--ticker")?.toUpperCase() ?? null;
  const selected = ticker ? analyst.filter((r) => r.incident.ticker === ticker) : analyst;
  return { baseConfig, analystConfig, analystConfigStore, verdictLookup, messages, now, replay, analyst, selected };
}

function list(): void {
  const s = setup();
  console.log(`messages ${s.messages.length} → incidents ${s.replay.incidents.length} · analyst-routed ${s.analyst.length} · screen emits ${s.messages.filter((m) => m.type === "tape_structure").length}`);
  for (const { incident, routing } of s.selected) {
    const verdicts = collectVerdicts(incident, s.verdictLookup);
    const kind = analystKindOf(incident, routing);
    const input = assembleInput(incident, verdicts, kind, s.analystConfig);
    const prompt = buildAnalystPrompt(input, promptVersionFor(kind, s.analystConfig));
    const r = input.reaction_state;
    const rules = routing.destinations.find((d) => d.destination === "analyst")?.rules.join(",") ?? "";
    console.log(
      `${incident.ticker.padEnd(5)} ${incident.incident_id.slice(0, 8)} ${incident.priority_band}/${String(incident.priority).padStart(2)} ` +
        `${kind.padEnd(16)} ${incident.messages.length.toString().padStart(3)} msgs · ${Object.keys(verdicts).length.toString().padStart(2)} verdicts · ` +
        `[${rules}] · ${r.basis} z=${r.realized_z?.toFixed(2) ?? "null"} cause=${r.best_cause ? `${r.best_cause.event_type}/${r.best_cause.materiality}` : "none"} ` +
        `${r.comparison} → ${r.edge_default} · news ${input.news.length}+${excludedCount(input)} · prompt ${prompt.user.length} chars`,
    );
  }
}

function dump(): void {
  const s = setup();
  const outDir = arg("--out", path.join(process.cwd(), "analyst-fixtures"))!;
  fs.mkdirSync(outDir, { recursive: true });
  for (const { incident, routing } of s.selected) {
    const verdicts = collectVerdicts(incident, s.verdictLookup);
    const file = path.join(outDir, `${incident.ticker.toLowerCase()}-${incident.incident_id.slice(0, 8)}.json`);
    fs.writeFileSync(file, JSON.stringify({ recorded_at: s.now.slice(0, 10), incident, routing, verdicts }, null, 1) + "\n");
    console.log("wrote", file);
  }
}

async function generate(): Promise<void> {
  const s = setup();
  const dry = flag("--dry");
  if (!dry && !anthropicConfigured()) {
    console.error("ANTHROPIC_API_KEY is not set");
    process.exit(1);
  }
  const store = new AnalystOutputStore(new AnalystFileBackend(s.analystConfigStore.dataDir));
  const budgetFile = path.join(s.analystConfigStore.dataDir, "budget.json");
  let budget: BudgetLedger | null = null;
  try {
    budget = JSON.parse(fs.readFileSync(budgetFile, "utf8")) as BudgetLedger;
  } catch {
    budget = null;
  }
  const built = buildAnalystRequests(s.selected, {
    verdictLookup: s.verdictLookup,
    latestOutput: (id) => store.latestFor(id),
    now: s.now,
  });
  const eligible = built.requests.filter((r) => !store.attemptsFor(r.request_id)?.permanent_failed);
  const remaining = Math.min(analystBudgetRemaining(budget, s.now, s.baseConfig), Number(arg("--max", "50")));
  const { dispatch, deferred } = applyAnalystBudget(eligible, remaining);
  console.log(
    `analyst-routed ${s.selected.length} · requests ${built.requests.length} (${built.already_produced} already produced, ${built.updates} updates) · dispatch ${dispatch.length} · deferred ${deferred.length} · budget left ${remaining}`,
  );
  if (dry || dispatch.length === 0) return;

  const service = new AnalystService({
    config: s.analystConfig,
    store,
    callModel: anthropicModelCaller,
    onOutput: (outcome, request) => {
      const o = outcome.output;
      console.log(
        `  ${request.incident.ticker.padEnd(5)} ${outcome.source.padEnd(10)} ${o.status} cause=${o.cause} edge=${o.edge_status}` +
          `${o.edge_deviation ? " (deviation)" : ""}${o.grounding_failed ? " (grounding_failed)" : ""} · ${outcome.attempts} att · ${(outcome.latency_ms / 1000).toFixed(1)}s` +
          (o.status === "ok" ? `\n        ${o.cause_summary}\n        → ${o.watch_trigger ?? "(no trigger)"}` : `\n        ${o.failure_reason}`),
      );
    },
  });
  const results = await service.analyzeBatch(dispatch);
  let consumed = 0;
  for (const r of results) {
    if (r.error) {
      console.error("  error:", r.error);
      continue;
    }
    const src = r.outcome!.source;
    if (src === "model" || src === "downgraded" || src === "failed") consumed += 1;
  }
  budget = consumeBudget(budget, s.now, consumed);
  fs.mkdirSync(path.dirname(budgetFile), { recursive: true });
  fs.writeFileSync(budgetFile, JSON.stringify(budget, null, 1), "utf8");
  const m = service.getMetrics();
  console.log(
    `done · ok ${m.outputs_ok} · failed ${m.outputs_failed} · grounding_failed ${m.grounding_failed} · deviations ${m.edge_deviations} · tokens ${m.input_tokens}/${m.output_tokens} · store ${store.size()} · budget used ${budget.used}`,
  );
}

const cmd = process.argv[2];
if (cmd === "list") list();
else if (cmd === "dump") dump();
else if (cmd === "generate") void generate();
else {
  console.error("usage: analyst-replay.ts <list|dump|generate> [--limit N] [--ticker T] [--out DIR] [--max N] [--dry]");
  process.exit(1);
}
