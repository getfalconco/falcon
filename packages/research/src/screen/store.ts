/**
 * Screen persistence — plain JSON under `apps/desktop/data/screen/` (override
 * with `FALCON_SCREEN_DATA_DIR`): `config.json` (every §9 knob, written with
 * the defaults on first run) and `findings.json` (the findings + scan
 * history, pruned to `retentionDays`).
 */

import fs from "node:fs";
import path from "node:path";
import { resolveDesktopDataDir } from "../tracker/store.js";
import { DEFAULT_SCREEN_CONFIG, mergeScreenConfig, type ScreenConfig } from "./config.js";
import { emptyStoreState } from "./lifecycle.js";
import { SCREEN_SCHEMA_VERSION, type ScreenFinding, type ScreenScan, type ScreenStoreState, type TapeStructureMessage } from "./types.js";

export function resolveScreenDataDir(): string {
  const fromEnv = process.env.FALCON_SCREEN_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(resolveDesktopDataDir(), "screen");
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

export class ScreenConfigStore {
  constructor(private readonly dir: string = resolveScreenDataDir()) {}

  get dataDir(): string {
    return this.dir;
  }

  get configFile(): string {
    return path.join(this.dir, "config.json");
  }

  /** Reads config.json, writing the defaults out on first run. */
  load(): ScreenConfig {
    const stored = readJson<Partial<ScreenConfig>>(this.configFile);
    if (!stored) {
      writeJsonAtomic(this.configFile, DEFAULT_SCREEN_CONFIG);
      return mergeScreenConfig(null);
    }
    return mergeScreenConfig(stored);
  }

  save(config: ScreenConfig): void {
    writeJsonAtomic(this.configFile, config);
  }
}

function isFinding(value: unknown): value is ScreenFinding {
  const f = value as ScreenFinding;
  return Boolean(f) && typeof f.id === "string" && typeof f.ticker === "string" && typeof f.pattern === "string" && Array.isArray(f.sessions);
}

function isScan(value: unknown): value is ScreenScan {
  const s = value as ScreenScan;
  return Boolean(s) && typeof s.session === "string" && typeof s.scanned_at === "string";
}

/**
 * S1: the append-only log of `tape_structure` messages Screen has emitted.
 * Base reads it to fold the messages into its replay — the same shape as the
 * Tracker's messages.jsonl so the two streams merge by timestamp.
 */
export class ScreenMessageStore {
  constructor(private readonly dir: string = resolveScreenDataDir()) {}

  get file(): string {
    return path.join(this.dir, "emitted.jsonl");
  }

  append(messages: TapeStructureMessage[]): void {
    if (messages.length === 0) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file, messages.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
  }

  /** Every emitted message, oldest first; ids are deduped (a re-run cannot double-count). */
  read(options?: { limit?: number; ticker?: string }): TapeStructureMessage[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const ticker = options?.ticker?.toUpperCase();
    const byId = new Map<string, TapeStructureMessage>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as TapeStructureMessage;
        if (!m || m.type !== "tape_structure" || typeof m.id !== "string") continue;
        if (ticker && m.ticker.toUpperCase() !== ticker) continue;
        byId.set(m.id, m);
      } catch {
        /* skip corrupt line */
      }
    }
    const all = [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
    return options?.limit ? all.slice(-options.limit) : all;
  }

  count(): number {
    return this.read().length;
  }
}

export class ScreenFindingsStore {
  private cache: ScreenStoreState | null = null;

  constructor(private readonly dir: string = resolveScreenDataDir()) {}

  get file(): string {
    return path.join(this.dir, "findings.json");
  }

  load(): ScreenStoreState {
    if (!this.cache) {
      const stored = readJson<Partial<ScreenStoreState>>(this.file);
      this.cache = stored
        ? {
            schema_version: SCREEN_SCHEMA_VERSION,
            findings: Array.isArray(stored.findings) ? stored.findings.filter(isFinding) : [],
            scans: Array.isArray(stored.scans) ? stored.scans.filter(isScan) : [],
          }
        : emptyStoreState();
    }
    return this.cache;
  }

  save(state: ScreenStoreState): void {
    this.cache = state;
    writeJsonAtomic(this.file, state);
  }

  /** Newest scan (by session), or null before the first one. */
  lastScan(): ScreenScan | null {
    const scans = this.load().scans;
    return scans.length > 0 ? scans[scans.length - 1] : null;
  }

  /** Forget the in-memory copy (a second writer may have touched the file). */
  reload(): void {
    this.cache = null;
  }
}
