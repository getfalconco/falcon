import path from "node:path";

/**
 * Absolute path to `<repo>/apps/desktop/data`, resolved correctly whether the
 * process cwd is the repo root (scripts) or `apps/desktop` (the Electron app).
 *
 * The old resolver always appended `apps/desktop`, so running from inside
 * apps/desktop produced the doubled `apps/desktop/apps/desktop/data/…` path.
 */
function desktopDataDir(): string {
  const cwd = process.cwd();
  const segs = cwd.split(/[\\/]+/);
  const alreadyInDesktop =
    segs[segs.length - 1] === "desktop" && segs[segs.length - 2] === "apps";
  const base = alreadyInDesktop ? cwd : path.resolve(cwd, "apps", "desktop");
  return path.join(base, "data");
}

/**
 * Directory where daily material-event JSON files + the seen-article index live.
 * Env-driven so the desktop app and the headless worker can point at the same
 * (or a host-appropriate) location.
 */
export function resolveEventsDataDir(): string {
  const fromEnv = process.env.FALCON_EVENTS_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;

  return path.join(desktopDataDir(), "events");
}

/** Path to the relationship graph the poller derives its seeded tickers from. */
export function resolveGraphPath(): string {
  const fromEnv = process.env.FALCON_GRAPH_PATH?.trim();
  if (fromEnv) return fromEnv;

  return path.join(desktopDataDir(), "graph.json");
}

export function seenArticlesPath(dataDir: string): string {
  return path.join(dataDir, "seen-article-ids.json");
}

export function dailyEventsPath(dataDir: string, dateYmd: string): string {
  return path.join(dataDir, `${dateYmd}.json`);
}
