/**
 * Gauge persistence: `config.json`, plus the v2 §10 setup ledger. The engine
 * itself stays stateless (compute-on-read) — the ledger is an append-only
 * record of what was said, so that in three months "what happened after we said
 * COILED" is a question with data behind it. Nothing reads it back into a
 * readout. Both files live under `apps/desktop/data/gauge/`
 * (override with `FALCON_GAUGE_DATA_DIR`).
 */

import fs from "node:fs";
import path from "node:path";
import { resolveDesktopDataDir } from "../tracker/store.js";
import { DEFAULT_GAUGE_CONFIG, mergeGaugeConfig, type GaugeConfig } from "./config.js";
import { GAUGE_SCHEMA_VERSION, type GaugeReadout, type GaugeSnapshot } from "./types.js";

export function resolveGaugeDataDir(): string {
  const fromEnv = process.env.FALCON_GAUGE_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(resolveDesktopDataDir(), "gauge");
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

export class GaugeConfigStore {
  constructor(private readonly dir: string = resolveGaugeDataDir()) {}

  get dataDir(): string {
    return this.dir;
  }

  get configFile(): string {
    return path.join(this.dir, "config.json");
  }

  /** Reads config.json, writing the defaults out on first run. */
  load(): GaugeConfig {
    const stored = readJson<Partial<GaugeConfig>>(this.configFile);
    if (!stored) {
      writeJsonAtomic(this.configFile, DEFAULT_GAUGE_CONFIG);
      return mergeGaugeConfig(null);
    }
    return mergeGaugeConfig(stored);
  }

  save(config: GaugeConfig): void {
    writeJsonAtomic(this.configFile, config);
  }
}

// ---------------------------------------------------------------------------
// §10 setup ledger
// ---------------------------------------------------------------------------

/**
 * The line the outcome study needs: what we said, about which name, on which
 * session — plus the few numbers it has to normalise by. Context readouts are
 * never snapshotted: they describe somebody's thesis, not the tape.
 */
export function toSnapshot(readout: GaugeReadout): GaugeSnapshot | null {
  if (!readout.tracked || readout.mode !== "standalone") return null;
  const session = readout.quant_as_of;
  if (!session) return null;
  const v = readout.setup.values;
  return {
    schema_version: GAUGE_SCHEMA_VERSION,
    session,
    at: readout.computed_at,
    ticker: readout.ticker,
    setup: readout.setup.key,
    state: readout.state,
    direction: readout.setup.direction,
    readable: readout.readable,
    values: {
      vol_regime: v.vol_regime ?? null,
      volume_ratio: v.volume_ratio ?? null,
      stretch_z: v.stretch_z ?? null,
      event_sessions: v.event_sessions ?? null,
      day_count: v.day_count ?? v.compression_days ?? null,
    },
  };
}

/** One ledger line per (ticker, session, setup, state) — a re-read is not an event. */
export function snapshotKey(s: GaugeSnapshot): string {
  return `${s.ticker}|${s.session}|${s.setup}|${s.state}`;
}

/**
 * Append-only JSONL. Deduped against the keys already on disk so a panel that
 * recomputes ten times a session still writes one line, and trimmed from the
 * front when it grows past `maxLines`.
 */
export class GaugeSnapshotStore {
  private keys: Set<string> | null = null;

  constructor(
    private readonly dir: string = resolveGaugeDataDir(),
    private readonly maxLines: number = DEFAULT_GAUGE_CONFIG.snapshots.maxLines,
  ) {}

  get file(): string {
    return path.join(this.dir, "snapshots.jsonl");
  }

  private lines(): string[] {
    try {
      return fs.readFileSync(this.file, "utf8").split("\n").filter((l) => l.trim().length > 0);
    } catch {
      return [];
    }
  }

  private loadKeys(): Set<string> {
    if (!this.keys) {
      const keys = new Set<string>();
      for (const line of this.lines()) {
        try {
          keys.add(snapshotKey(JSON.parse(line) as GaugeSnapshot));
        } catch {
          /* a torn line is not worth failing a readout over */
        }
      }
      this.keys = keys;
    }
    return this.keys;
  }

  /** Returns the line written, or null when it was a duplicate / not snapshottable. */
  record(readout: GaugeReadout): GaugeSnapshot | null {
    const snapshot = toSnapshot(readout);
    if (!snapshot) return null;
    const key = snapshotKey(snapshot);
    const keys = this.loadKeys();
    if (keys.has(key)) return null;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(snapshot)}\n`, "utf8");
    keys.add(key);
    this.trim();
    return snapshot;
  }

  private trim(): void {
    const lines = this.lines();
    if (lines.length <= this.maxLines) return;
    const kept = lines.slice(lines.length - this.maxLines);
    fs.writeFileSync(this.file, `${kept.join("\n")}\n`, "utf8");
    this.keys = null;
  }

  /** Newest last. */
  list(limit = 500): GaugeSnapshot[] {
    const lines = this.lines();
    const out: GaugeSnapshot[] = [];
    for (const line of lines.slice(Math.max(0, lines.length - limit))) {
      try {
        out.push(JSON.parse(line) as GaugeSnapshot);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  count(): number {
    return this.lines().length;
  }
}
