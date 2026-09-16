/**
 * Clear a Tracker detector's latch for one or more tickers, so the next
 * evaluation treats the condition as a fresh transition and re-fires.
 *
 * Why this exists: the edge detectors (§5) fire once on the false→true
 * transition and stay latched. That is correct for suppressing repeats, but it
 * means a cluster already reported can never be re-reported — so when the
 * emitted payload shape changes (a new field, a corrected value), the standing
 * episode keeps the old message forever. Resetting the latch is the migration.
 *
 * Usage (the Tracker engine must not be running — see the guard below):
 *   pnpm --filter @meridian/research exec tsx scripts/reset-tracker-detector.ts insiderCluster PFE
 *   pnpm --filter @meridian/research exec tsx scripts/reset-tracker-detector.ts insiderCluster --all
 */

import fs from "node:fs";
import path from "node:path";
import { resolveTrackerDataDir } from "../src/tracker/store.js";
import type { TickerState } from "../src/tracker/types.js";

/** A live engine rewrites state from memory, so an edit now would be lost. */
const LIVE_WRITE_WINDOW_MS = 3 * 60_000;

const EDGE_DETECTORS = [
  "silence",
  "filingOverdue",
  "drift",
  "newsBurst",
  "insiderCluster",
] as const;
const SNAPSHOT_DETECTORS = ["gap", "volume", "unexplained"] as const;

type EdgeName = (typeof EDGE_DETECTORS)[number];
type SnapshotName = (typeof SNAPSHOT_DETECTORS)[number];
type DetectorName = EdgeName | SnapshotName;

function isEdge(name: DetectorName): name is EdgeName {
  return (EDGE_DETECTORS as readonly string[]).includes(name);
}

/**
 * The store resolves its data dir relative to cwd, which only lands correctly
 * when run from apps/desktop. A script is run from wherever, so fall back to
 * walking up for the runtime data dir.
 */
function resolveStateDir(): string | null {
  const candidate = path.join(resolveTrackerDataDir(), "state");
  if (fs.existsSync(candidate)) return candidate;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const guess = path.join(dir, "apps", "desktop", "data", "tracker", "state");
    if (fs.existsSync(guess)) return guess;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function main(): void {
  const [detectorArg, ...tickerArgs] = process.argv.slice(2);
  const all = [...EDGE_DETECTORS, ...SNAPSHOT_DETECTORS] as readonly string[];

  if (!detectorArg || tickerArgs.length === 0) {
    console.error(`usage: reset-tracker-detector <detector> <TICKER...|--all>`);
    console.error(`detectors: ${all.join(", ")}`);
    process.exit(1);
  }
  if (!all.includes(detectorArg)) {
    console.error(`unknown detector "${detectorArg}" — expected one of: ${all.join(", ")}`);
    process.exit(1);
  }
  const detector = detectorArg as DetectorName;

  const stateDir = resolveStateDir();
  if (!stateDir) {
    console.error(
      `no tracker state found — looked at ${resolveTrackerDataDir()} and walked up from ${process.cwd()}.\n` +
        `Set FALCON_TRACKER_DATA_DIR to point at it.`,
    );
    process.exit(1);
  }

  const files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".json"));
  const wanted = tickerArgs.includes("--all")
    ? files
    : tickerArgs.map((t) => `${t.trim().toUpperCase()}.json`);

  // Refuse to run against a live engine: it holds the authoritative copy in
  // memory and would overwrite anything written here on its next save.
  const newest = Math.max(
    ...files.map((f) => fs.statSync(path.join(stateDir, f)).mtimeMs),
    0,
  );
  const ageMs = Date.now() - newest;
  if (ageMs < LIVE_WRITE_WINDOW_MS) {
    console.error(
      `tracker state was written ${Math.round(ageMs / 1000)}s ago — the engine looks live.\n` +
        `Stop the desktop app first; edits made now would be overwritten from memory.`,
    );
    process.exit(1);
  }

  let changed = 0;
  for (const file of wanted) {
    const full = path.join(stateDir, file);
    if (!fs.existsSync(full)) {
      console.warn(`  skip ${file} — no such state file`);
      continue;
    }
    const state = JSON.parse(fs.readFileSync(full, "utf8")) as TickerState;
    const before = JSON.stringify(state.detectors[detector]);

    if (isEdge(detector)) {
      const next = { active: false, lastFiredAt: null, lastFiredValue: null, falseSinceDay: null };
      state.detectors[detector] =
        detector === "insiderCluster" ? { ...next, lastClusterInsiders: [] } : next;
    } else {
      state.detectors[detector] = { lastFiredDay: null, lastFiredValue: null };
    }

    const after = JSON.stringify(state.detectors[detector]);
    if (before === after) {
      console.log(`  ${state.ticker} ${detector}: already clear`);
      continue;
    }
    fs.writeFileSync(full, JSON.stringify(state, null, 1), "utf8");
    console.log(`  ${state.ticker} ${detector}: ${before} -> cleared`);
    changed += 1;
  }

  console.log(
    `\n${changed} ticker(s) reset. The detector re-evaluates on the next cycle and ` +
      `re-fires if the condition still holds.`,
  );
}

main();
