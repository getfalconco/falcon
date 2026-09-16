/**
 * Tracker persistence (§6): quant state, seen-article ids, filing history,
 * news-rate baselines, detector states, and channel health survive restarts.
 * Plain JSON files under the desktop runtime data dir — no local SQL DB.
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TRACKER_CONFIG, mergeTrackerConfig, type TrackerConfig } from "./config.js";
import type { DailyBar, RateLimitTally, TickerState, TrackerMessage } from "./types.js";

/** Same desktop-aware resolution as backtest/paths.ts. */
function desktopDataDir(): string {
  const cwd = process.cwd();
  const segs = cwd.split(/[\\/]+/);
  const alreadyInDesktop = segs[segs.length - 1] === "desktop" && segs[segs.length - 2] === "apps";
  const base = alreadyInDesktop ? cwd : path.resolve(cwd, "apps", "desktop");
  return path.join(base, "data");
}

export function resolveTrackerDataDir(): string {
  const fromEnv = process.env.FALCON_TRACKER_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(desktopDataDir(), "tracker");
}

/** Root of the desktop runtime data dir — parent of the per-domain caches. */
export function resolveDesktopDataDir(): string {
  return desktopDataDir();
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

export class TrackerStore {
  constructor(private readonly dir: string = resolveTrackerDataDir()) {}

  get dataDir(): string {
    return this.dir;
  }

  loadConfig(): TrackerConfig {
    const file = path.join(this.dir, "config.json");
    const stored = readJson<Partial<TrackerConfig>>(file);
    if (!stored) {
      writeJsonAtomic(file, DEFAULT_TRACKER_CONFIG);
      return mergeTrackerConfig(null);
    }
    return mergeTrackerConfig(stored);
  }

  saveConfig(config: TrackerConfig): void {
    writeJsonAtomic(path.join(this.dir, "config.json"), config);
  }

  private tickerFile(ticker: string): string {
    return path.join(this.dir, "state", `${ticker.toUpperCase()}.json`);
  }

  loadTickerState(ticker: string): TickerState | null {
    return readJson<TickerState>(this.tickerFile(ticker));
  }

  saveTickerState(state: TickerState): void {
    writeJsonAtomic(this.tickerFile(state.ticker), state);
  }

  removeTickerState(ticker: string): void {
    try {
      fs.rmSync(this.tickerFile(ticker));
    } catch {
      /* already gone */
    }
  }

  loadBenchmarkBars(): { bars: DailyBar[]; asOf: string | null } {
    return (
      readJson<{ bars: DailyBar[]; asOf: string | null }>(path.join(this.dir, "spy-bars.json")) ?? {
        bars: [],
        asOf: null,
      }
    );
  }

  saveBenchmarkBars(bars: DailyBar[], asOf: string | null): void {
    writeJsonAtomic(path.join(this.dir, "spy-bars.json"), { bars, asOf });
  }

  loadRateLimits(): RateLimitTally {
    return (
      readJson<RateLimitTally>(path.join(this.dir, "rate-limits.json")) ?? {
        day: "",
        news: 0,
        calendar: 0,
        filings: 0,
        price: 0,
      }
    );
  }

  saveRateLimits(tally: RateLimitTally): void {
    writeJsonAtomic(path.join(this.dir, "rate-limits.json"), tally);
  }

  appendMessage(message: TrackerMessage): void {
    const file = path.join(this.dir, "messages.jsonl");
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, `${JSON.stringify(message)}\n`, "utf8");
  }

  /**
   * Total persisted messages + the newest timestamp, so a restarted engine's
   * "emitted" counter agrees with the stream it shows (the counter was
   * previously in-memory only and read 0 after every restart).
   */
  messageStats(): { count: number; lastAt: string | null } {
    const file = path.join(this.dir, "messages.jsonl");
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return { count: 0, lastAt: null };
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    let lastAt: string | null = null;
    for (let i = lines.length - 1; i >= 0 && lastAt == null; i--) {
      try {
        lastAt = (JSON.parse(lines[i]) as TrackerMessage).timestamp ?? null;
      } catch {
        /* skip corrupt line */
      }
    }
    return { count: lines.length, lastAt };
  }

  /** Most recent messages, newest first. */
  readMessages(options?: { limit?: number; ticker?: string }): TrackerMessage[] {
    const file = path.join(this.dir, "messages.jsonl");
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const limit = options?.limit ?? 200;
    const ticker = options?.ticker?.toUpperCase();
    const out: TrackerMessage[] = [];
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as TrackerMessage;
        if (ticker && msg.ticker !== ticker) continue;
        out.push(msg);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }
}

export function emptyTickerState(ticker: string, nowIso: string): TickerState {
  const edge = () => ({
    active: false,
    lastFiredAt: null,
    lastFiredValue: null,
    falseSinceDay: null,
  });
  const clusterEdge = () => ({ ...edge(), lastClusterInsiders: [] as string[] });
  const snapshot = () => ({ lastFiredDay: null, lastFiredValue: null });
  const health = () => ({ last_success_at: null, last_error: null });
  return {
    ticker: ticker.toUpperCase(),
    addedAt: nowIso,
    backfilledAt: null,
    insiderBackfilledAt: null,
    insiderParse: { attempted: 0, parsed: 0, kept: 0 },
    insiderScanned: [],
    cik: null,
    bars: [],
    barsAsOf: null,
    filings: [],
    insiderTxns: [],
    earnings: [],
    scheduledEarnings: [],
    scheduledEmitted: [],
    newsCounts: {},
    seenArticleIds: [],
    newsTimestamps: [],
    detectors: {
      gap: snapshot(),
      volume: snapshot(),
      unexplained: snapshot(),
      silence: edge(),
      filingOverdue: edge(),
      drift: edge(),
      newsBurst: edge(),
      insiderCluster: clusterEdge(),
    },
    health: {
      news: health(),
      filings: health(),
      calendar: health(),
      price: health(),
    },
    quant: null,
    quantAsOf: null,
    lastCloseComputedFor: null,
    lastGapCheckedFor: null,
    lastNewsPollAt: null,
    lastFilingCheckAt: null,
  };
}
