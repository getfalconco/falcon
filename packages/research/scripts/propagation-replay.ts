/**
 * Propagation replay harness (spec §12 step 3 / §10 rubric) — three subcommands.
 *
 *   list      Replay Base over the recorded Tracker stream and list the
 *             incidents that qualify for Propagation (routed rows + band-
 *             qualified candidates) with their best event and a stage-1
 *             preview (targets / open / priced / untracked). No model call.
 *
 *   dump      Write the qualifying incidents (with their Classifier verdicts
 *             and the resolved best event) as recorded-request fixture JSON
 *             files for the test suite / rubric.
 *
 *   generate  Replay-driven generation: run stage-1 (+ stage-2 when
 *             --stage2 and within Base's daily budget) over the qualifying
 *             incidents that have no run yet and persist the runs to the
 *             propagation store on disk — the rubric batch. --stage2 spends
 *             Anthropic quota.
 *
 * Usage:
 *   pnpm --filter @meridian/research exec tsx scripts/propagation-replay.ts list [--limit 3000]
 *   pnpm --filter @meridian/research exec tsx scripts/propagation-replay.ts dump --out <dir> [--ticker WMT]
 *   pnpm --filter @meridian/research exec tsx scripts/propagation-replay.ts generate [--max 10] [--ticker WMT] [--stage2] [--dry]
 *
 * Data dirs: FALCON_TRACKER_DATA_DIR / FALCON_BASE_DATA_DIR /
 * FALCON_CLASSIFIER_DATA_DIR / FALCON_PROPAGATION_DATA_DIR, defaulting to
 * apps/desktop/data/<engine>. The graph is read from apps/desktop/data/graph.json
 * (override with FALCON_GRAPH_PATH).
 */

import fs from "node:fs";
import path from "node:path";
import { loadBaseConfig } from "../src/base/store.js";
import { consumeBudget, lookupFromVerdicts, type BudgetLedger } from "../src/base/classification.js";
import {
  addDueAt,
  earningsCalendarFromMessages,
  mergeCalendars,
  withPreEarningsPreviewCap,
  type EarningsCalendar,
} from "../src/base/pre-earnings-preview.js";
import { replayBase } from "../src/base/replay.js";
import { resolveDesktopDataDir, resolveTrackerDataDir, TrackerStore } from "../src/tracker/store.js";
import type { TrackerMessage, TickerState, DailyBar } from "../src/tracker/types.js";
import { FileBackend as ClassifierFileBackend, VerdictStore } from "../src/classifier/store.js";
import { stableIncidentId } from "../src/analyst/requests.js";
import {
  FileBackend,
  PropagationConfigStore,
  PropagationRunStore,
  PropagationService,
  anthropicConfigured,
  anthropicModelCaller,
  buildPropagationRequests,
  loadGraphIndexSync,
  orderByPriority,
  propagationBudgetRemaining,
  type QuantSource,
  type TargetQuantSnapshot,
} from "../src/propagation/engine/index.js";

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

/** Quant source over the Tracker's persisted state files (no live quote: last close). */
function fileQuantSource(store: TrackerStore): QuantSource {
  const bench = store.loadBenchmarkBars();
  const cache = new Map<string, TickerState | null>();
  const state = (t: string) => {
    if (!cache.has(t)) cache.set(t, store.loadTickerState(t));
    return cache.get(t) ?? null;
  };
  return {
    isTracked: (t) => state(t.toUpperCase()) !== null,
    snapshot: async (t): Promise<TargetQuantSnapshot | null> => {
      const s = state(t.toUpperCase());
      if (!s) return null;
      const last: DailyBar | undefined = s.bars[s.bars.length - 1];
      return {
        ticker: s.ticker,
        bars: s.bars,
        benchBars: bench.bars,
        beta: s.quant?.beta_90d ?? null,
        r2: s.quant?.r_squared ?? null,
        vol30: s.quant?.daily_vol_30d ?? null,
        lastPrice: last?.c ?? null,
        lastPriceTs: last ? `${last.d}T20:00:00.000Z` : null,
        benchLastPrice: null,
      };
    },
  };
}

function setup() {
  const baseConfig = loadBaseConfig();
  const configStore = new PropagationConfigStore();
  const config = configStore.load();
  const runStore = new PropagationRunStore(new FileBackend(configStore.dataDir));
  const verdicts = new VerdictStore(new ClassifierFileBackend());
  const rawLookup = lookupFromVerdicts(verdicts.list(), baseConfig);
  const graphPath = process.env.FALCON_GRAPH_PATH?.trim() || path.join(resolveDesktopDataDir(), "graph.json");
  const graph = loadGraphIndexSync(graphPath);
  const trackerStore = new TrackerStore();
  const quant = fileQuantSource(trackerStore);
  const now = new Date().toISOString();
  const messages = readMessages();
  // Pre-earnings preview cap: Tracker scheduledEarnings ledger + the stream's scheduled_event messages.
  const calendar: EarningsCalendar = new Map();
  for (const file of fs.readdirSync(path.join(trackerStore.dataDir, "state"))) {
    if (!file.endsWith(".json")) continue;
    const state = trackerStore.loadTickerState(file.replace(/\.json$/, ""));
    for (const s of state?.scheduledEarnings ?? []) if (s.confirmed) addDueAt(calendar, state!.ticker, s.dueAt);
  }
  const verdictLookup = withPreEarningsPreviewCap(rawLookup, mergeCalendars(earningsCalendarFromMessages(messages), calendar), baseConfig);
  const replay = replayBase(messages, { config: baseConfig, now, verdictLookup: rawLookup, earningsCalendar: calendar, makeIncidentId: stableIncidentId });
  const built = buildPropagationRequests(replay.incidents, {
    verdictLookup,
    latestRun: (id) => runStore.latestFor(id),
    now,
    baseConfig,
    config,
  });
  return { baseConfig, configStore, config, runStore, graph, quant, now, messages, replay, built, dataDir: configStore.dataDir };
}

async function list() {
  const s = setup();
  const ticker = arg("--ticker")?.toUpperCase() ?? null;
  console.log(`messages ${s.messages.length} · incidents ${s.replay.incidents.length} · qualifying requests ${s.built.requests.length} (already produced ${s.built.already_produced}, updates ${s.built.updates}, no event ${s.built.no_event}, below band ${s.built.below_band})`);
  console.log(`graph ${s.graph.version.generatedAt} pv${s.graph.version.pipelineVersion} · ${s.graph.edges.length} edges`);
  const svc = new PropagationService({ config: s.config, store: new PropagationRunStore(), graph: () => s.graph, quant: s.quant, callModel: null, now: () => s.now });
  for (const r of orderByPriority(s.built.requests)) {
    if (ticker && r.root_ticker !== ticker) continue;
    const out = await svc.run(r, { stage2: false, stage2SkipReason: "list" });
    const run = out.run;
    console.log(
      `${r.root_ticker.padEnd(5)} ${r.incident.priority_band} ${r.incident.window_start} · ${r.event.type}/${r.event.direction}/${r.event.materiality} via ${r.event.source} · "${r.event.label}" · rules ${r.trigger_rules.join(",")}` +
        ` → reachable ${run.reachable} · targets ${run.summary.targets} · open ${run.summary.open} · partial ${run.summary.partial} · priced ${run.summary.priced} · untracked ${run.summary.untracked} · overflow ${run.overflow} · non-transmitting ${run.non_transmitting}${run.summary.no_edge ? " · NO EDGE" : ""}`,
    );
  }
}

function dump() {
  const s = setup();
  const out = arg("--out");
  if (!out) throw new Error("--out <dir> is required");
  const ticker = arg("--ticker")?.toUpperCase() ?? null;
  fs.mkdirSync(out, { recursive: true });
  let n = 0;
  for (const r of s.built.requests) {
    if (ticker && r.root_ticker !== ticker) continue;
    const file = path.join(out, `${r.root_ticker.toLowerCase()}-${r.event.type}-${r.incident.window_start.slice(0, 10)}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          recorded_at: s.now,
          request: r,
          graph_version: s.graph.version,
        },
        null,
        1,
      ),
      "utf8",
    );
    n += 1;
    console.log(`wrote ${file}`);
  }
  console.log(`${n} request fixture(s)`);
}

async function generate() {
  const s = setup();
  const max = Number(arg("--max", "10"));
  const ticker = arg("--ticker")?.toUpperCase() ?? null;
  const dry = flag("--dry");
  const wantStage2 = flag("--stage2");
  const budgetFile = path.join(s.dataDir, "budget.json");
  let budget: BudgetLedger | null = null;
  try {
    budget = JSON.parse(fs.readFileSync(budgetFile, "utf8")) as BudgetLedger;
  } catch {
    budget = null;
  }
  const remaining = propagationBudgetRemaining(budget, s.now, s.baseConfig);
  const callModel = wantStage2 && anthropicConfigured() ? anthropicModelCaller : null;
  if (wantStage2 && !callModel) console.warn("--stage2 requested but ANTHROPIC_API_KEY is not set — stage-1 only");
  const svc = new PropagationService({ config: s.config, store: s.runStore, graph: () => s.graph, quant: s.quant, callModel, now: () => new Date().toISOString() });
  const queue = orderByPriority(s.built.requests).filter((r) => !ticker || r.root_ticker === ticker).slice(0, max);
  console.log(`${queue.length} request(s) to run · stage-2 ${callModel ? "on" : "off"} · budget remaining ${remaining}`);
  let used = 0;
  for (const r of queue) {
    const stage2 = Boolean(callModel) && used < remaining;
    if (dry) {
      console.log(`[dry] ${r.root_ticker} ${r.event.type}/${r.event.direction} "${r.event.label}" stage2=${stage2}`);
      continue;
    }
    const out = await svc.run(r, { stage2, stage2SkipReason: stage2 ? undefined : callModel ? "daily budget exhausted" : "stage-2 off" });
    if (out.stage2_called) used += 1;
    const run = out.run;
    console.log(
      `${r.root_ticker} ${run.status} · targets ${run.summary.targets} · open ${run.summary.open} · priced ${run.summary.priced} · untracked ${run.summary.untracked} · vetoed ${run.summary.vetoed}${run.stage2?.failure_reason ? ` · stage2 failed: ${run.stage2.failure_reason}` : ""}${run.stage2?.skipped_reason ? ` · stage2 skipped: ${run.stage2.skipped_reason}` : ""}`,
    );
  }
  if (!dry && used > 0) {
    fs.writeFileSync(budgetFile, JSON.stringify(consumeBudget(budget, s.now, used), null, 1), "utf8");
  }
  console.log(`done · stage-2 calls ${used} · runs in store ${s.runStore.size()}`);
}

/**
 * seed — the spec's synthetic NVDA earnings fixture (§12 step 3) run against
 * the real graph and the real Tracker state, persisted to the store so the
 * Shift+P view has a full ripple to render before the first live trigger.
 * Stage-1 only; labelled as a fixture in its trigger rules.
 */
async function seed() {
  const s = setup();
  const { requestFixture } = await import("../src/propagation/engine/test-fixtures.js");
  const request = requestFixture({
    request_id: "pr-fixture-nvda-earnings-synthetic",
    incident_id: "inc-fixture-nvda-earnings",
    trigger_rules: ["fixture:synthetic_nvda_earnings"],
    synthetic: true,
  });
  const svc = new PropagationService({ config: s.config, store: s.runStore, graph: () => s.graph, quant: s.quant, callModel: null, now: () => new Date().toISOString() });
  const out = await svc.run(request, { stage2: false, stage2SkipReason: "fixture seed — stage-1 only" });
  const run = out.run;
  console.log(
    `${run.root_ticker} ${run.status} (${out.source}) · reachable ${run.reachable} · targets ${run.summary.targets} · open ${run.summary.open} · partial ${run.summary.partial} · priced ${run.summary.priced} · untracked ${run.summary.untracked} · overflow ${run.overflow}`,
  );
  for (const t of run.targets) {
    console.log(`  ${(t.ticker ?? t.label).padEnd(28)} ${t.relationship.role.padEnd(14)} ${t.relationship.tier.padEnd(9)} ${t.transmission.tier.padEnd(8)} ${t.transmission.direction.padEnd(8)} ${t.pricing.status.padEnd(8)} ${t.pricing.realized_resid_pct == null ? "" : (t.pricing.realized_resid_pct * 100).toFixed(2) + "%"}`);
  }
}

const cmd = process.argv[2];
if (cmd === "list") void list();
else if (cmd === "dump") dump();
else if (cmd === "generate") void generate();
else if (cmd === "seed") void seed();
else {
  console.error("usage: propagation-replay.ts list|dump|generate|seed [options]");
  process.exit(1);
}
