/**
 * Screen replay harness — run the daily scan on the real Tracker data without
 * Electron (spec §10 evidence, §11 calibration).
 *
 *   pnpm --filter @meridian/research exec tsx scripts/screen-replay.ts scan [--session YYYY-MM-DD] [--write] [--json]
 *   pnpm --filter @meridian/research exec tsx scripts/screen-replay.ts list
 *   pnpm --filter @meridian/research exec tsx scripts/screen-replay.ts views [--ticker NVDA]
 *   pnpm --filter @meridian/research exec tsx scripts/screen-replay.ts history [--session YYYY-MM-DD] [--write]
 *
 * `scan` evaluates the last completed session (or --session) and prints the
 * evaluations; it writes findings.json only with --write — the desktop host
 * owns the store. `history` replays every session from --session forward,
 * building the lifecycle on a scratch state (prints day counts). `views` dumps
 * the series view per ticker.
 *
 * Data dirs: FALCON_TRACKER_DATA_DIR / FALCON_SCREEN_DATA_DIR, defaulting to
 * apps/desktop/data/{tracker,screen}.
 */

import fs from "node:fs";
import path from "node:path";
import { lastCompletedTradingDay, nextTradingDay, previousTradingDay } from "../src/tracker/calendar.js";
import { TrackerStore } from "../src/tracker/store.js";
import {
  ScreenConfigStore,
  ScreenFindingsStore,
  activeFindings,
  emptyStoreState,
  endedFindings,
  evaluateTicker,
  fileTrackerSource,
  gatherScreenInputs,
  runScreenScan,
  type ScreenFinding,
  type ScreenStoreState,
} from "../src/screen/index.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function setup() {
  const configStore = new ScreenConfigStore();
  const config = configStore.load();
  const findingsStore = new ScreenFindingsStore(configStore.dataDir);
  const trackerStore = new TrackerStore();
  const stateDir = path.join(trackerStore.dataDir, "state");
  const listTickers = () => (fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : []);
  const source = fileTrackerSource(trackerStore, listTickers);
  return { configStore, config, findingsStore, trackerStore, source };
}

function fmtFinding(f: ScreenFinding): string {
  const mods = f.modifiers.length ? ` · ${f.modifiers.join(",")}` : "";
  const ended = f.ended_at ? ` · ended ${f.ended_at} (${f.ended_reason})` : "";
  return `${f.ticker.padEnd(6)} ${f.pattern.padEnd(20)} ${f.state.padEnd(10)} day ${String(f.day_count).padStart(2)}  ${f.first_session}→${f.last_evaluated}${mods}${ended}\n         ${f.read}`;
}

function scan() {
  const s = setup();
  const now = new Date();
  const session = arg("--session") ?? lastCompletedTradingDay(now);
  const gathered = gatherScreenInputs(s.source);
  const state = s.findingsStore.load();
  const result = runScreenScan({ session, now: now.toISOString(), trigger: "script", inputs: gathered.inputs, benchBars: gathered.benchBars, r2Floor: gathered.r2Floor, config: s.config, state, errors: gathered.errors });
  if (flag("--json")) {
    console.log(JSON.stringify({ scan: result.scan, findings: result.state.findings, evaluations: result.evaluations }, null, 2));
  } else {
    console.log(`screen scan ${session} · ${result.scan.tickers_scanned}/${result.scan.tickers_total} tickers · ${result.scan.evaluations} evaluations · new ${result.scan.new} · continuing ${result.scan.continuing} · ended ${result.scan.ended} · degraded ${result.scan.degraded.length} · errors ${result.scan.errors.length}`);
    console.log(`r² floor ${gathered.r2Floor} · benchmark bars ${gathered.benchBars.length} · data ${s.configStore.dataDir}`);
    const present = result.evaluations.filter((e) => e.status === "present");
    console.log(`\npresent (${present.length}):`);
    for (const e of present) console.log(`  ${e.ticker.padEnd(6)} ${e.pattern.padEnd(20)} ${e.read}`);
    const near = result.evaluations.filter((e) => e.status === "absent");
    console.log(`\nabsent (${near.length}) — closest by pattern:`);
    for (const pattern of ["quiet_accumulation", "compression", "independent_tape", "insider_divergence"] as const) {
      const rows = near.filter((e) => e.pattern === pattern);
      const keyed = rows.map((e) => ({ e, k: nearMissScore(e.values) })).sort((a, b) => b.k - a.k).slice(0, 5);
      console.log(`  ${pattern}:`);
      for (const { e } of keyed) console.log(`    ${e.ticker.padEnd(6)} ${summarize(e.values)}`);
    }
    console.log(`\ndegraded (${result.scan.degraded.length}):`);
    for (const d of result.scan.degraded) console.log(`  ${d.ticker.padEnd(6)} ${String(d.pattern).padEnd(20)} ${d.reason}`);
    if (result.scan.errors.length) console.log(`\nerrors:\n  ${result.scan.errors.join("\n  ")}`);
    console.log(`\nfindings after scan: active ${activeFindings(result.state, s.config).length} · ended ${endedFindings(result.state).length}`);
    for (const f of activeFindings(result.state, s.config)) console.log(fmtFinding(f));
  }
  if (flag("--write")) {
    s.findingsStore.save(result.state);
    console.log(`\nwrote ${s.findingsStore.file}`);
  }
}

function nearMissScore(values: Record<string, unknown>): number {
  const n = (k: string) => (typeof values[k] === "number" ? (values[k] as number) : 0);
  if ("net_residual_z" in values) return n("sessions_qualifying") + Math.min(n("net_residual_z"), 3);
  if ("range_ratio" in values) return (n("vol_regime") > 0 ? 1 / n("vol_regime") : 0) + (n("range_ratio") > 0 ? 1 / n("range_ratio") : 0);
  if ("momentum_20d_z" in values) return (values.cluster_active ? 5 : 0) + n("momentum_20d_z");
  return n("sessions_qualifying") + (values.news_burst_in_window ? -5 : 0) - n("momentum_5d_z");
}

function summarize(values: Record<string, unknown>): string {
  return Object.entries(values)
    .filter(([k]) => !/_min$|_max$|window|_implied$/.test(k))
    .map(([k, v]) => `${k}=${typeof v === "number" ? Number(v.toFixed(3)) : String(v)}`)
    .join(" ");
}

function list() {
  const s = setup();
  const state = s.findingsStore.load();
  const last = s.findingsStore.lastScan();
  console.log(`store ${s.findingsStore.file} · scans ${state.scans.length} · last ${last ? `${last.session} @ ${last.scanned_at}` : "—"}`);
  console.log(`active (${activeFindings(state, s.config).length}):`);
  for (const f of activeFindings(state, s.config)) console.log(fmtFinding(f));
  console.log(`ended (${endedFindings(state).length}):`);
  for (const f of endedFindings(state)) console.log(fmtFinding(f));
}

function views() {
  const s = setup();
  const session = arg("--session") ?? lastCompletedTradingDay(new Date());
  const only = arg("--ticker")?.toUpperCase() ?? null;
  const gathered = gatherScreenInputs(s.source);
  for (const input of gathered.inputs) {
    if (only && input.ticker !== only) continue;
    const { view, evaluations } = evaluateTicker(input, gathered.benchBars, session, s.config, gathered.r2Floor);
    console.log(`\n${view.ticker} as_of ${view.as_of} · ${view.history_sessions} sessions · β ${fmt(view.beta)} r² ${fmt(view.r2)} vol ${fmt(view.daily_vol, 4)} regime ${fmt(view.vol_regime)} m5 ${fmt(view.momentum_5d, 4)} m20 ${fmt(view.momentum_20d, 4)} range10 ${fmt(view.range_10s, 4)} 52wH ${fmt(view.pct_from_52w_high, 3)} 52wL ${fmt(view.pct_from_52w_low, 3)}`);
    for (const v of view.sessions) console.log(`  ${v.d}  ret ${fmt(v.ret, 4)}  bench ${fmt(v.bench_ret, 4)}  volr ${fmt(v.volume_ratio)}  resid ${fmt(v.residual_move, 4)}  z ${fmt(v.residual_z)}`);
    for (const e of evaluations) console.log(`  ${e.pattern.padEnd(20)} ${e.status.padEnd(8)} ${e.na_reason ?? e.read ?? summarize(e.values)}`);
  }
}

function fmt(v: number | null, digits = 2): string {
  return v == null ? "—" : v.toFixed(digits);
}

/** Replay sessions forward on a scratch state — the lifecycle evidence on real data. */
function history() {
  const s = setup();
  const now = new Date();
  const end = lastCompletedTradingDay(now);
  const start = arg("--session") ?? (() => {
    let d = end;
    for (let i = 0; i < 15; i++) d = previousTradingDay(d);
    return d;
  })();
  const gathered = gatherScreenInputs(s.source);
  let state: ScreenStoreState = emptyStoreState();
  let session = start;
  while (session <= end) {
    // Detector state has no history beyond its last fire: for past sessions the
    // burst gate relies on the message log alone and a cluster counts as active
    // only from the day it last fired — an approximation, flagged as such.
    const inputs = gathered.inputs.map((i) => ({
      ...i,
      news_burst: i.news_burst ? { ...i.news_burst, active: false, last_fired_at: null } : null,
      insider_cluster: i.insider_cluster ? { ...i.insider_cluster, active: i.insider_cluster.active && (i.insider_cluster.last_fired_at ?? "").slice(0, 10) <= session } : null,
    }));
    const r = runScreenScan({ session, now: `${session}T21:05:00.000Z`, trigger: "script", inputs, benchBars: gathered.benchBars, r2Floor: gathered.r2Floor, config: s.config, state, errors: gathered.errors });
    state = r.state;
    const active = activeFindings(state, s.config);
    console.log(`${session}  new ${r.scan.new} cont ${r.scan.continuing} ended ${r.scan.ended} degraded ${r.scan.degraded.length} · active ${active.length}: ${active.map((f) => `${f.ticker}/${f.pattern}#${f.day_count}`).join(" ")}`);
    session = nextTradingDay(session);
  }
  console.log("\nfinal:");
  for (const f of activeFindings(state, s.config)) console.log(fmtFinding(f));
  for (const f of endedFindings(state)) console.log(fmtFinding(f));
  if (flag("--write")) {
    s.findingsStore.save(state);
    console.log(`\nwrote ${s.findingsStore.file}`);
  }
}


const cmd = process.argv[2] ?? "scan";
if (cmd === "scan") scan();
else if (cmd === "list") list();
else if (cmd === "views") views();
else if (cmd === "history") history();
else {
  console.error(`unknown command "${cmd}" — use scan | list | views | history`);
  process.exit(1);
}
