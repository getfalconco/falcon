import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * Where Falcon keeps its runtime data. In development this is the repo's
 * `apps/desktop/data` (the checked-in graph, SEC cache and engine state). In a
 * packaged build there is no repo: everything lives under the OS user-data dir
 * and is seeded from the bundle on first launch.
 *
 * Every engine in @meridian/research already honours a `FALCON_*_DATA_DIR`
 * override, so pointing them all at this root is a matter of setting those
 * env vars before any of them resolve a path (they all resolve lazily, inside
 * functions, so doing it at startup is enough).
 */
export function resolveDataRoot(): string {
  const fromEnv = process.env.FALCON_DATA_ROOT?.trim();
  if (fromEnv) return fromEnv;
  if (app.isPackaged) return path.join(app.getPath("userData"), "data");
  // out/main → apps/desktop/data, regardless of the cwd Electron was started from.
  return path.resolve(__dirname, "../../data");
}

const ENGINE_DIRS: ReadonlyArray<readonly [envKey: string, subdir: string]> = [
  ["FALCON_TRACKER_DATA_DIR", "tracker"],
  ["FALCON_BASE_DATA_DIR", "base"],
  ["FALCON_CLASSIFIER_DATA_DIR", "classifier"],
  ["FALCON_ANALYST_DATA_DIR", "analyst"],
  ["FALCON_PROPAGATION_DATA_DIR", "propagation"],
  ["FALCON_RISK_DATA_DIR", "risk"],
  ["FALCON_GAUGE_DATA_DIR", "gauge"],
  ["FALCON_SCREEN_DATA_DIR", "screen"],
  ["FALCON_QUANTLAB_DATA_DIR", "quantlab"],
  ["FALCON_EVENTS_DATA_DIR", "events"],
  ["FALCON_SIGNALS_DATA_DIR", "signals"],
  ["FALCON_RESEARCH_DATA_DIR", "research"],
  ["FALCON_RESEARCH_CACHE_DIR", "cache"],
];

/** Points every engine at the data root. Explicit env overrides still win. */
export function configureDataPaths(): string {
  const root = resolveDataRoot();
  const setDefault = (key: string, value: string) => {
    if (!process.env[key]?.trim()) process.env[key] = value;
  };
  for (const [key, subdir] of ENGINE_DIRS) setDefault(key, path.join(root, subdir));
  setDefault("FALCON_GRAPH_PATH", path.join(root, "graph.json"));
  return root;
}

/**
 * Files worth shipping rather than regenerating: the relationship graph and
 * the SEC-derived research + section cache are slow and cost API calls to
 * rebuild. Engine state (tracker, classifier, …) regenerates on its own.
 */
const SEED_ENTRIES = ["graph.json", "research", "cache"] as const;

/**
 * First launch of a packaged build: copy the bundled seed data into the data
 * root. Never overwrites — a user's own graph.json is theirs.
 */
export function seedDataRoot(root: string): void {
  if (!app.isPackaged) return;
  const seedDir = path.join(process.resourcesPath, "seed-data");
  if (!fs.existsSync(seedDir)) return;

  fs.mkdirSync(root, { recursive: true });
  for (const entry of SEED_ENTRIES) {
    const from = path.join(seedDir, entry);
    const to = path.join(root, entry);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    fs.cpSync(from, to, { recursive: true });
    console.log(`[data] seeded ${entry} → ${to}`);
  }
}
