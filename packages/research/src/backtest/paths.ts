import path from "node:path";

/** Same desktop-aware resolution as news/event-paths.ts desktopDataDir. */
function desktopDataDir(): string {
  const cwd = process.cwd();
  const segs = cwd.split(/[\\/]+/);
  const alreadyInDesktop = segs[segs.length - 1] === "desktop" && segs[segs.length - 2] === "apps";
  const base = alreadyInDesktop ? cwd : path.resolve(cwd, "apps", "desktop");
  return path.join(base, "data");
}

export function resolveBacktestDataDir(): string {
  const fromEnv = process.env.FALCON_BACKTEST_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(desktopDataDir(), "backtest");
}
