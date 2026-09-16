import path from "node:path";
import { access } from "node:fs/promises";

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      await access(p);
      return p;
    } catch {
      continue;
    }
  }
  return null;
}

export async function resolveGraphPath(): Promise<string> {
  const fromEnv = process.env.FALCON_GRAPH_PATH?.trim();
  if (fromEnv) return fromEnv;

  const cwd = process.cwd();
  const found = await firstExisting([
    path.resolve(cwd, "data", "graph.json"),
    path.resolve(cwd, "..", "..", "data", "graph.json"),
  ]);
  if (found) return found;

  return path.resolve(cwd, "data", "graph.json");
}

export function resolveEventsDir(): string {
  const fromEnv = process.env.FALCON_EVENTS_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;

  const cwd = process.cwd();
  return path.resolve(cwd, "apps", "desktop", "data", "events");
}

export function resolveSignalsDir(): string {
  const fromEnv = process.env.FALCON_SIGNALS_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;

  const cwd = process.cwd();
  return path.resolve(cwd, "data", "signals");
}
