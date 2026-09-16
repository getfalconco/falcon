/**
 * Gauge replay harness — readouts on the real Tracker data without Electron
 * (spec §10 evidence, §11 calibration).
 *
 *   pnpm --filter @meridian/research exec tsx scripts/gauge-replay.ts readout NVDA [--json]
 *   pnpm --filter @meridian/research exec tsx scripts/gauge-replay.ts readout TSM --direction up --event 2026-08-21T21:00:00Z [--pricing open] [--sessions 1] [--json]
 *   pnpm --filter @meridian/research exec tsx scripts/gauge-replay.ts universe [--record]  # one line per tracked ticker (standalone); --record appends to the §10 setup ledger
 *   pnpm --filter @meridian/research exec tsx scripts/gauge-replay.ts propagation <runId> # context readouts for every OPEN target of a run
 *
 * Read-only: nothing is written (Gauge is stateless; config.json is created on
 * first load with the defaults). Data dirs: FALCON_TRACKER_DATA_DIR /
 * FALCON_BASE_DATA_DIR / FALCON_CLASSIFIER_DATA_DIR / FALCON_GAUGE_DATA_DIR /
 * FALCON_PROPAGATION_DATA_DIR, defaulting to apps/desktop/data/*.
 */

import fs from "node:fs";
import path from "node:path";
import { stableIncidentId } from "../src/analyst/requests.js";
import { lookupFromVerdicts } from "../src/base/classification.js";
import { loadBaseConfig } from "../src/base/store.js";
import { FileBackend as ClassifierFileBackend, VerdictStore } from "../src/classifier/store.js";
import { FileBackend as PropagationFileBackend, PropagationRunStore } from "../src/propagation/engine/store.js";
import { TrackerStore } from "../src/tracker/store.js";
import { ScreenConfigStore, ScreenFindingsStore, activeFindings } from "../src/screen/index.js";
import {
  GaugeConfigStore,
  GaugeSnapshotStore,
  screenSourceFrom,
  directionFromEvent,
  fileTrackerSource,
  gatherGaugeInputs,
  gauge,
  type GaugeContext,
  type GaugeReadout,
} from "../src/gauge/index.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function setup() {
  const configStore = new GaugeConfigStore();
  const config = configStore.load();
  const baseConfig = loadBaseConfig();
  const trackerStore = new TrackerStore();
  const trackerConfig = trackerStore.loadConfig();
  const stateDir = path.join(trackerStore.dataDir, "state");
  const listTickers = () => (fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : []);
  let verdictLookup;
  try {
    verdictLookup = lookupFromVerdicts(new VerdictStore(new ClassifierFileBackend()).list(), baseConfig);
  } catch {
    verdictLookup = undefined;
  }
  const tracker = fileTrackerSource(trackerStore, listTickers);
  // §4: Screen is read-only and optional — without it the setup pool narrows to
  // the instantaneous rows rather than pretending the multi-session ones failed.
  let screen = null;
  try {
    const screenConfig = new ScreenConfigStore().load();
    const findingsStore = new ScreenFindingsStore();
    screen = screenSourceFrom(() => activeFindings(findingsStore.load(), screenConfig) as never);
  } catch {
    screen = null;
  }
  return { configStore, config, baseConfig, trackerConfig, trackerStore, listTickers, verdictLookup, tracker, screen };
}

type Setup = ReturnType<typeof setup>;

function compute(s: Setup, ticker: string, now: string, context: GaugeContext | null): { readout: GaugeReadout; errors: string[] } {
  const gathered = gatherGaugeInputs(ticker, now, {
    tracker: s.tracker,
    trackerConfig: s.trackerConfig,
    screen: s.screen,
    newsLookbackSessions: s.config.setups.newsLookbackSessions,
    baseConfig: s.baseConfig,
    verdictLookup: s.verdictLookup,
    makeIncidentId: stableIncidentId,
    includeIncidents: context != null,
  });
  return { readout: gauge(gathered.inputs, s.config, context), errors: gathered.errors };
}

const DOT: Record<string, string> = { pass: "●", caution: "◐", fail: "○", n_a: "·" };

function print(readout: GaugeReadout, errors: string[]): void {
  const s = readout.summary;
  console.log(`${readout.ticker} · ${readout.mode}${readout.context ? ` (${readout.context.source}, expected ${readout.context.expected_direction ?? "unresolved"})` : ""} · quant as of ${readout.quant_as_of ?? "—"}`);
  if (!readout.tracked) {
    console.log(`  ${s.sentence}`);
    return;
  }
  console.log(`  ${readout.setup.name}  [${readout.state}]${readout.readable ? "" : " · unreadable residuals"}`);
  console.log(`  ${readout.setup.read}`);
  if (readout.missing) console.log(`  missing: ${readout.missing.detail}`);
  if (readout.state_line) console.log(`  ${readout.state_line}`);
  if (readout.readability_note) console.log(`  note: ${readout.readability_note}`);
  if (readout.setup.screen.length) console.log(`  screen: ${readout.setup.screen.map((f) => `${f.pattern} d${f.day_count}`).join(" · ")}`);
  console.log(`  evidence: ${(s.overall ?? "").toUpperCase()} — ${s.sentence}`);
  console.log(`  ${s.aligned} of ${s.evaluable} aligned · ${s.cautions} caution · ${s.fails} fail · ${s.unavailable} unavailable${s.calibrating ? " · CALIBRATING" : ""}`);
  for (const c of readout.checks) {
    console.log(`  ${DOT[c.status]} ${String(c.number)}. ${c.label.padEnd(22)} ${c.status.padEnd(7)} ${c.reason}${c.note ? `  [${c.note}]` : ""}`);
  }
  if (errors.length) console.log(`  errors: ${errors.join(" · ")}`);
}

function readout() {
  const s = setup();
  const ticker = process.argv[3];
  if (!ticker) throw new Error("usage: readout <TICKER> [--direction up|down] [--event ISO] [--pricing open|partial|priced|stale] [--sessions N] [--json]");
  const now = arg("--now") ?? new Date().toISOString();
  const direction = arg("--direction");
  const event = arg("--event");
  let context: GaugeContext | null = null;
  if (direction || event) {
    context = {
      expected_direction: direction === "up" || direction === "down" ? direction : null,
      event_ts: event ?? now,
      source: "manual",
      pricing_status: (arg("--pricing") as GaugeContext["pricing_status"]) ?? null,
      sessions_since_event: arg("--sessions") != null ? Number(arg("--sessions")) : null,
      thesis_is_scheduled_event: process.argv.includes("--thesis-is-event"),
    };
  }
  const { readout: r, errors } = compute(s, ticker, now, context);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ readout: r, errors }, null, 2));
    return;
  }
  print(r, errors);
}

function universe() {
  const s = setup();
  // §10: the outcome study needs a line per (ticker, session, setup, state) from
  // day one, so a scripted sweep can seed the ledger the host would otherwise
  // only fill as surfaces are visited. The store dedupes, so re-running is safe.
  const record = process.argv.includes("--record");
  const ledger = record ? new GaugeSnapshotStore(s.configStore.dataDir, s.config.snapshots.maxLines) : null;
  let written = 0;
  const now = arg("--now") ?? new Date().toISOString();
  const tickers = s.listTickers().sort();
  const rows: Array<{ ticker: string; readout: GaugeReadout }> = [];
  const dist: Record<string, number> = {};
  for (const t of tickers) {
    const { readout: r } = compute(s, t, now, null);
    if (ledger && ledger.record(r)) written += 1;
    rows.push({ ticker: t, readout: r });
    const k = r.tracked ? `${r.setup.key} / ${r.state}` : "untracked";
    dist[k] = (dist[k] ?? 0) + 1;
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ now, readouts: rows.map((r) => r.readout) }, null, 2));
    return;
  }
  console.log(`gauge universe · ${tickers.length} tickers · ${now} · ${Object.entries(dist).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  if (ledger) console.log(`ledger: +${written} new line${written === 1 ? "" : "s"} · ${ledger.count()} total · ${ledger.file}`);
  for (const { ticker, readout: r } of rows) {
    const st = r.checks.map((c) => DOT[c.status]).join("");
    console.log(`  ${ticker.padEnd(5)} ${st} ${r.setup.name.padEnd(20)} ${r.state.padEnd(18)} ${r.setup.read}${r.readable ? "" : " · residuals unreadable"}`);
  }
}

function propagation() {
  const s = setup();
  const runId = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null;
  const store = new PropagationRunStore(new PropagationFileBackend());
  const run = runId ? store.get(runId) : store.list({ currentOnly: true, openOnly: true, synthetic: "all" })[0] ?? null;
  if (!run) throw new Error(runId ? `run ${runId} not found` : "no current open run");
  const now = arg("--now") ?? new Date().toISOString();
  if (!process.argv.includes("--json")) console.log(`run ${run.run_id} · ${run.root_ticker} · ${run.event.type} ${run.event.direction} · ${run.event.event_ts}`);
  const out: Array<{ target: string; readout: GaugeReadout }> = [];
  for (const t of run.targets) {
    if (!t.ticker || !t.tracked || t.pricing.status !== "open" || t.stage2?.verdict === "vetoed") continue;
    const context: GaugeContext = {
      expected_direction: directionFromEvent(t.stage2?.direction ?? t.transmission.direction),
      event_ts: run.event.event_ts,
      source: "propagation_target",
      pricing_status: t.pricing.status,
      sessions_since_event: t.pricing.sessions_elapsed,
      thesis_is_scheduled_event: false,
    };
    const { readout: r, errors } = compute(s, t.ticker, now, context);
    out.push({ target: t.ticker, readout: r });
    if (!process.argv.includes("--json")) print(r, errors);
  }
  if (process.argv.includes("--json")) console.log(JSON.stringify({ run_id: run.run_id, now, targets: out }, null, 2));
  if (out.length === 0 && !process.argv.includes("--json")) console.log("  no OPEN tracked targets on this run");
}

const cmd = process.argv[2];
if (cmd === "readout") readout();
else if (cmd === "universe") universe();
else if (cmd === "propagation") propagation();
else {
  console.error("usage: gauge-replay.ts readout <TICKER> [...] | universe [--json] | propagation [runId] [--json]");
  process.exit(2);
}
