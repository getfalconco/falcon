/**
 * Quant Lab data backfill — the §4 prerequisite, run once.
 *
 *   pnpm --filter @meridian/research exec tsx scripts/quantlab-backfill.ts series [--years 5] [--tickers NVDA,AMD] [--json]
 *   pnpm --filter @meridian/research exec tsx scripts/quantlab-backfill.ts coverage [--json]
 *   pnpm --filter @meridian/research exec tsx scripts/quantlab-backfill.ts filings [--ticker NVDA] [--json]
 *
 * `series` fetches adjusted daily bars for the benchmark and every tracked
 * ticker, rebuilds the point-in-time series, and writes them under
 * `data/quantlab/series/`. It is safe to re-run: each ticker's file is
 * replaced wholesale. Tracker's own store is never written to.
 *
 * `coverage` reports what is on disk. `filings` prints the rebuilt 8-K and
 * earnings history for one ticker — the offline half of the backfill, useful
 * for checking acceptance-time attribution.
 *
 * Data dirs: FALCON_QUANTLAB_DATA_DIR / FALCON_TRACKER_DATA_DIR, defaulting to
 * apps/desktop/data/{quantlab,tracker}.
 */

import fs from "node:fs";
import path from "node:path";
import { runBackfill } from "../src/quantlab/backfill.js";
import { TradingCalendar } from "../src/quantlab/calendar.js";
import { buildEarningsHistory, buildFilingEvents } from "../src/quantlab/filings.js";
import { QuantLabConfigStore, SeriesStore } from "../src/quantlab/store.js";
import { cfgWindows } from "./quantlab-shared.js";
import { TrackerStore } from "../src/tracker/store.js";
import type { DailyBar } from "../src/tracker/types.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

function trackerTickers(store: TrackerStore): string[] {
  const dir = path.join(store.dataDir, "state");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5).toUpperCase())
      .filter((t) => t !== "SPY")
      .sort();
  } catch {
    return [];
  }
}

function setup() {
  const configStore = new QuantLabConfigStore();
  const config = configStore.load();
  const seriesStore = new SeriesStore();
  const trackerStore = new TrackerStore();
  return { config, configStore, seriesStore, trackerStore };
}

async function series(): Promise<void> {
  const { config, seriesStore, trackerStore } = setup();
  const years = Number(arg("--years") ?? config.backtest.windowYears);
  const explicit = arg("--tickers");
  const tickers = explicit
    ? explicit.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean)
    : trackerTickers(trackerStore);

  if (tickers.length === 0) {
    console.error("no tickers found — is FALCON_TRACKER_DATA_DIR pointing at a populated store?");
    process.exit(1);
  }

  console.error(
    `backfilling ${tickers.length} tickers + ${config.data.benchmark}, ${years}y, ` +
      `${config.data.fetchSpacingMs}ms spacing → ${seriesStore.seriesDir}`,
  );

  const started = Date.now();
  const summary = await runBackfill(tickers, {
    store: seriesStore,
    windows: cfgWindows(),
    benchmark: config.data.benchmark,
    years,
    fetchSpacingMs: config.data.fetchSpacingMs,
    onProgress: (done, total, ticker) => {
      if (!flag("--json")) process.stderr.write(`\r  ${done}/${total}  ${ticker.padEnd(6)}   `);
    },
  });
  if (!flag("--json")) process.stderr.write("\n");

  if (flag("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const ok = summary.outcomes.filter((o) => o.status === "ok");
  const bad = summary.outcomes.filter((o) => o.status !== "ok");
  const withGaps = ok.filter((o) => o.gaps.length > 0);
  const sessions = ok.map((o) => o.sessions).sort((a, b) => a - b);

  console.log(`\nbenchmark ${summary.benchmark}: ${summary.benchmarkSessions} sessions`);
  console.log(`ok ${ok.length} · failed ${bad.length} · with interior gaps ${withGaps.length}`);
  if (sessions.length > 0) {
    console.log(
      `sessions min/median/max: ${sessions[0]} / ${sessions[Math.floor(sessions.length / 2)]} / ${sessions[sessions.length - 1]}`,
    );
    const full = ok.filter((o) => o.sessions === sessions[sessions.length - 1]).length;
    console.log(`tickers at full depth: ${full}/${ok.length}`);
  }
  for (const o of bad) console.log(`  ${o.status.toUpperCase().padEnd(6)} ${o.ticker} ${o.error ?? ""}`);
  for (const o of withGaps) {
    const worst = o.gaps.reduce((a, b) => (b.sessions > a.sessions ? b : a));
    console.log(`  GAP    ${o.ticker.padEnd(6)} ${o.gaps.length} hole(s), worst ${worst.sessions} sessions at ${worst.from}`);
  }
  console.log(`elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

function coverage(): void {
  const { seriesStore } = setup();
  const rows = seriesStore.coverage();
  if (flag("--json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("no series on disk — run `quantlab-backfill.ts series` first");
    return;
  }
  console.log(`${rows.length} series in ${seriesStore.seriesDir}\n`);
  console.log("TICKER  SESSIONS  FROM        TO");
  for (const r of rows) {
    console.log(`${r.ticker.padEnd(7)} ${String(r.sessions).padStart(8)}  ${r.from ?? "-"}  ${r.to ?? "-"}`);
  }
}

function filings(): void {
  const { config, seriesStore, trackerStore } = setup();
  const ticker = (arg("--ticker") ?? "NVDA").toUpperCase();
  const state = trackerStore.loadTickerState(ticker);
  if (!state) {
    console.error(`no tracker state for ${ticker}`);
    process.exit(1);
  }
  const bench = seriesStore.load(config.data.benchmark);
  if (!bench) {
    console.error(`no ${config.data.benchmark} series — run \`series\` first`);
    process.exit(1);
  }
  const benchBars: DailyBar[] = bench.snapshots.map((s) => ({ d: s.d, o: s.close, h: s.close, l: s.close, c: s.close, v: s.volume }));
  const calendar = TradingCalendar.fromBars(benchBars);

  const events = buildFilingEvents(state, calendar);
  const earnings = buildEarningsHistory(state, calendar);

  if (flag("--json")) {
    console.log(JSON.stringify({ ticker, events, earnings }, null, 2));
    return;
  }
  console.log(`${ticker}: ${events.length} 8-K events, ${earnings.length} earnings releases`);
  console.log(`calendar ${calendar.first} → ${calendar.last} (${calendar.length} sessions)\n`);
  const byItem = new Map<string, number>();
  for (const e of events) for (const i of e.items) byItem.set(i, (byItem.get(i) ?? 0) + 1);
  console.log(
    "items: " +
      [...byItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([i, n]) => `${i}×${n}`).join(" "),
  );
  console.log("\nlast 12 earnings releases:");
  console.log("SESSION     AFTER_CLOSE  ACCEPTED");
  for (const e of earnings.slice(-12)) {
    console.log(`${e.session}  ${String(e.after_close).padEnd(11)}  ${e.accepted_at ?? "-"}`);
  }
}

const cmd = process.argv[2] ?? "series";
if (cmd === "series") {
  void series();
} else if (cmd === "coverage") {
  coverage();
} else if (cmd === "filings") {
  filings();
} else {
  console.error(`unknown command "${cmd}" — use series | coverage | filings`);
  process.exit(1);
}
