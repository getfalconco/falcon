/**
 * S1–S3 end-to-end harness: run a Screen scan over the recorded Tracker data,
 * apply the emit gate, and report the `tape_structure` messages it would put
 * into the pipeline. With `--out <dir>` the messages and the marked findings
 * are written to a Screen data dir, so a Base replay (and the Analyst) can be
 * pointed at them without touching the live install.
 *
 * The gate's own flags still apply: pass `--force-emit` to evaluate the gate
 * with `screenEmitEnabled` on for this run only (the stored config is never
 * modified). Nothing here calls a model.
 *
 * Usage:
 *   pnpm --filter @meridian/research exec tsx scripts/screen-emit-replay.ts \
 *     [--out <screen-data-dir>] [--force-emit] [--held NVDA,PFE] [--watchlist WMT]
 */

import fs from "node:fs";
import path from "node:path";
import { resolveTrackerDataDir, TrackerStore } from "../src/tracker/store.js";
import { lastCompletedTradingDay } from "../src/tracker/calendar.js";
import {
  ScreenConfigStore,
  ScreenFindingsStore,
  ScreenMessageStore,
  activeFindings,
  fileTrackerSource,
  gatherScreenInputs,
  runScreenScan,
  selectEmissions,
} from "../src/screen/index.js";

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function list(name: string): string[] {
  return (arg(name, "") ?? "")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
}

const outDir = arg("--out");
const force = process.argv.includes("--force-emit");

const trackerDir = resolveTrackerDataDir();
const store = new TrackerStore(trackerDir);
const source = fileTrackerSource(store, () =>
  fs
    .readdirSync(path.join(trackerDir, "state"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, "")),
);

const configStore = new ScreenConfigStore(outDir ?? undefined);
const base = configStore.load();
const config = force ? { ...base, emit: { ...base.emit, screenEmitEnabled: true } } : base;
const findingsStore = new ScreenFindingsStore(outDir ?? undefined);
const messageStore = new ScreenMessageStore(outDir ?? undefined);

const gathered = gatherScreenInputs(source);
const session = lastCompletedTradingDay(new Date());
const now = new Date().toISOString();

const scan = runScreenScan({
  session,
  now,
  trigger: "script",
  inputs: gathered.inputs,
  benchBars: gathered.benchBars,
  r2Floor: gathered.r2Floor,
  config,
  state: findingsStore.load(),
  errors: gathered.errors,
});

const active = activeFindings(scan.state, config);
console.log(
  `scan ${session}: ${scan.scan.tickers_scanned}/${scan.scan.tickers_total} tickers · new ${scan.scan.new} · continuing ${scan.scan.continuing} · ended ${scan.scan.ended} · active ${active.length}`,
);

const held = list("--held");
const watchlist = list("--watchlist");
const emit = selectEmissions({ state: scan.state, views: scan.views, session, now, held, watchlist, config });

console.log(
  `emit gate (${config.emit.screenEmitEnabled ? "on" : "OFF"}): ${emit.eligible} eligible · ${emit.messages.length} emitted · ${emit.capped} capped · cap ${config.emit.dailyEmitCap} · proximity held [${held.join(",")}] watchlist [${watchlist.join(",")}]`,
);
for (const m of emit.messages) {
  const s = m.payload.since_first;
  console.log(
    `  ${m.ticker.padEnd(5)} ${m.payload.pattern.padEnd(20)} day ${m.payload.day_count} from ${m.payload.first_session} · since_first ret ${s.ret === null ? "null" : (s.ret * 100).toFixed(2) + "%"} z ${s.residual_z_cum?.toFixed(2) ?? "null"} over ${s.sessions} · ${m.payload.read}`,
  );
}
const skipped = emit.candidates.filter((c) => c.reason && c.reason !== "not_new" && c.reason !== "already_emitted");
const byReason = new Map<string, number>();
for (const c of skipped) byReason.set(c.reason!, (byReason.get(c.reason!) ?? 0) + 1);
if (byReason.size) console.log(`  skipped: ${[...byReason].map(([r, n]) => `${r} ${n}`).join(" · ")}`);

if (outDir) {
  findingsStore.save(emit.state);
  messageStore.append(emit.messages);
  console.log(`wrote ${emit.messages.length} message(s) to ${messageStore.file}`);
  console.log(`findings: ${findingsStore.file}`);
}
