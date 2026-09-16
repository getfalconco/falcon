/**
 * Risk Engine replay harness — compute a snapshot on the real data without
 * Electron (spec §9 calibration, §10 evidence).
 *
 *   pnpm --filter @meridian/research exec tsx scripts/risk-replay.ts snapshot [--positions NVDA:10,CEG:5:1200] [--cash 5000] [--json]
 *   pnpm --filter @meridian/research exec tsx scripts/risk-replay.ts history [--limit 50]
 *
 * `snapshot` reads the account from --positions/--cash (TICKER:SHARES[:COST_USD];
 * priced at Tracker's last price, cost basis when untracked) or, without them, from data/risk/account.json
 * (the renderer's last push). Read-only: nothing is written to the snapshot
 * store — the desktop host owns it.
 *
 * Data dirs: FALCON_TRACKER_DATA_DIR / FALCON_BASE_DATA_DIR /
 * FALCON_CLASSIFIER_DATA_DIR / FALCON_RISK_DATA_DIR, defaulting to
 * apps/desktop/data/*; graph from FALCON_GRAPH_PATH or apps/desktop/data/graph.json.
 */

import fs from "node:fs";
import path from "node:path";
import { loadBaseConfig } from "../src/base/store.js";
import { lookupFromVerdicts } from "../src/base/classification.js";
import { FileBackend as ClassifierFileBackend, VerdictStore } from "../src/classifier/store.js";
import { stableIncidentId } from "../src/analyst/requests.js";
import { loadGraphIndexSync } from "../src/propagation/engine/graph.js";
import { resolveDesktopDataDir, TrackerStore } from "../src/tracker/store.js";
import {
  RISK_COMPONENT_KEYS,
  RiskAccountStore,
  RiskConfigStore,
  RiskSnapshotStore,
  computeRiskSnapshot,
  computeTriggerKeys,
  fileTrackerSource,
  gatherRiskInputs,
  type RiskAccountInput,
} from "../src/risk/index.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function parsePositions(spec: string): RiskAccountInput["positions"] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [ticker, shares, cost] = s.split(":");
      const n = Number(shares ?? "1");
      const c = cost == null ? 0 : Number(cost);
      if (!ticker || !Number.isFinite(n) || !Number.isFinite(c)) throw new Error(`bad position "${s}" (expected TICKER:SHARES[:COST_USD])`);
      return { ticker: ticker.toUpperCase(), shares: n, cost_usd: c, market_value: null };
    });
}

function setup() {
  const configStore = new RiskConfigStore();
  const config = configStore.load();
  const baseConfig = loadBaseConfig();
  const trackerStore = new TrackerStore();
  const stateDir = path.join(trackerStore.dataDir, "state");
  const listTickers = () => (fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : []);
  const graphPath = process.env.FALCON_GRAPH_PATH?.trim() || path.join(resolveDesktopDataDir(), "graph.json");
  const graph = fs.existsSync(graphPath) ? loadGraphIndexSync(graphPath) : null;
  let verdictLookup;
  try {
    verdictLookup = lookupFromVerdicts(new VerdictStore(new ClassifierFileBackend()).list(), baseConfig);
  } catch {
    verdictLookup = undefined;
  }
  return { configStore, config, baseConfig, trackerStore, listTickers, graph, graphPath, verdictLookup };
}

function snapshot() {
  const s = setup();
  const positionsArg = arg("--positions");
  const cashArg = arg("--cash");
  let account: RiskAccountInput;
  if (positionsArg) {
    account = { account: "paper", cash: Number(cashArg ?? "0") || 0, positions: parsePositions(positionsArg), as_of: new Date().toISOString() };
  } else {
    const stored = new RiskAccountStore(s.configStore.dataDir).load();
    if (!stored) throw new Error("no --positions given and data/risk/account.json not found (the desktop renderer writes it on first push)");
    account = stored;
  }
  const now = new Date().toISOString();
  const gathered = gatherRiskInputs(account, now, {
    tracker: fileTrackerSource(s.trackerStore, s.listTickers),
    graph: s.graph,
    baseConfig: s.baseConfig,
    verdictLookup: s.verdictLookup,
    makeIncidentId: stableIncidentId,
  });
  const snap = computeRiskSnapshot(gathered.inputs, s.config, { trigger: ["manual"] });
  const keys = computeTriggerKeys({ held: gathered.held, closeDay: gathered.closeDay, live: gathered.inputs.live, horizonSessions: s.config.event.earnings.horizonSessions });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ snapshot: snap, keys, errors: gathered.errors }, null, 2));
    return;
  }
  console.log(`graph ${s.graph ? `${s.graph.version.generatedAt} pv${s.graph.version.pipelineVersion} · ${s.graph.edges.length} edges` : "none"} (${s.graphPath})`);
  console.log(`tracker ${s.trackerStore.dataDir} · universe ${s.listTickers().length} · SPY vol ${gathered.inputs.spy_daily_vol == null ? "null" : (gathered.inputs.spy_daily_vol * 100).toFixed(3) + "%"} · median vol ${gathered.inputs.universe_median_vol == null ? "null" : (gathered.inputs.universe_median_vol * 100).toFixed(3) + "%"}`);
  console.log(`account cash ${account.cash} · held ${gathered.held.join(", ") || "—"} · invested ${(snap.invested_fraction * 100).toFixed(1)}%`);
  for (const w of snap.weights) {
    const q = gathered.inputs.quant[w.ticker];
    console.log(`  ${w.ticker.padEnd(5)} w ${(w.weight * 100).toFixed(1).padStart(5)}% · mv ${w.market_value.toFixed(0).padStart(8)} · β ${q?.beta?.toFixed(2) ?? "null"} · vol ${q?.daily_vol == null ? "null" : (q.daily_vol * 100).toFixed(2) + "%"} · rhythm ${q?.earnings_rhythm == null ? "null" : (q.earnings_rhythm * 100).toFixed(1) + "%"} · px ${q?.last_price ?? "null"}`);
  }
  console.log(`live: incidents ${gathered.inputs.live.open_incidents.map((i) => `${i.ticker}:${i.band}`).join(",") || "—"} · anomalies ${gathered.inputs.live.anomalies.map((a) => `${a.ticker}:${a.kind}`).join(",") || "—"} · earnings ${gathered.inputs.live.earnings.map((e) => `${e.ticker}:${e.sessions_until}s`).join(",") || "—"}`);
  if (snap.empty) {
    console.log("snapshot: EMPTY (no positions)");
    return;
  }
  console.log(`\nSCORE ${snap.score} · ${snap.band?.toUpperCase()} · driver ${snap.driver?.component}: "${snap.driver?.sentence}"`);
  for (const k of RISK_COMPONENT_KEYS) {
    const c = snap.components![k];
    const w = snap.blend_weights[k];
    let detail = "";
    if (k === "concentration") detail = `HHI ${snap.components!.concentration.hhi}`;
    if (k === "market") detail = `β_eff ${snap.components!.market.beta_eff}`;
    if (k === "volatility") detail = `σ_p ${snap.components!.volatility.port_vol_daily_pct}%/day`;
    if (k === "network") detail = `linked ${snap.components!.network.linked_fraction} · pairs ${snap.components!.network.pair_count} · top ${snap.components!.network.top_links.map((l) => `${l.a}-${l.b}(${l.via},${l.tier})`).join(",") || "—"}`;
    if (k === "event") detail = `raw ${snap.components!.event.raw} · ${snap.components!.event.contributors.map((e) => `${e.ticker}:${e.kind}:${e.detail}`).join(",") || "—"}`;
    if (k === "sharpe") {
      const s = snap.components!.sharpe;
      detail =
        s.sharpe == null
          ? `no ratio (${s.sessions} aligned sessions, rf ${s.risk_free_pct}%) — out of the blend`
          : `Sharpe ${s.sharpe} over ${s.sessions} sessions · ret ${s.ann_return_pct}%/yr · vol ${s.ann_vol_pct}%/yr · rf ${s.risk_free_pct}%${s.excluded.length ? ` · excluded ${s.excluded.join(",")}` : ""}`;
    }
    if (c.score == null) {
      console.log(`  ${k.padEnd(14)}   — ×  —  =    — · ${detail}`);
      continue;
    }
    console.log(`  ${k.padEnd(14)} ${String(c.score).padStart(3)} × ${w.toFixed(2)} = ${(c.score * w).toFixed(1).padStart(5)} · ${detail}`);
  }
  console.log(`degraded: ${snap.degraded.map((d) => `${d.ticker}.${d.field}→${d.substitute}`).join(", ") || "none"}`);
  console.log(`keys: close ${keys.close} · bands ${keys.bands} · horizon ${keys.horizon || "—"}`);
  if (gathered.errors.length) console.log(`errors: ${gathered.errors.join(" · ")}`);
}

function history() {
  const s = setup();
  const store = new RiskSnapshotStore(s.configStore.dataDir, s.config.historyRetentionDays);
  const limit = Number(arg("--limit") ?? "50");
  const items = store.history(limit);
  console.log(`${store.count()} snapshots in ${store.file}`);
  for (const h of items) console.log(`${h.computed_at} · ${h.empty ? "empty" : `${h.score} ${h.band} · ${h.driver_component}: ${h.driver_sentence}`} · ${h.trigger.join("+")}`);
}

const cmd = process.argv[2];
if (cmd === "snapshot") snapshot();
else if (cmd === "history") history();
else {
  console.error("usage: risk-replay.ts snapshot [--positions NVDA:10,CEG:5:1200] [--cash 5000] [--json] | history [--limit 50]");
  process.exit(1);
}
