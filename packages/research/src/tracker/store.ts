/**
 * Tracker persistence (§6): quant state, seen-article ids, filing history,
 * news-rate baselines, detector states, and channel health survive restarts.
 * Plain JSON files under the desktop runtime data dir — no local SQL DB.
 */

import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
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

/**
 * The message log is append-only and grows without bound — on the engine
 * service it passed a hundred megabytes in two weeks — and every reader used
 * to `readFileSync` the whole of it, split it into lines and parse from the
 * end. Risk asks per ticker, so one recompute read the file two hundred
 * times; boot alone held three copies of it. On a container with a memory
 * cap that was the whole outage: the process was killed ninety seconds after
 * every start, with nothing in the logs, because an OOM kill leaves no stack.
 *
 * Now the store keeps the newest TAIL_KEEP messages in memory, loads them
 * once from at most TAIL_BYTES of the file's end, and on every later read
 * folds in only the bytes appended since — so a second store instance (Risk
 * and Screen build their own) sees what the engine's instance wrote. Counting
 * lines streams the file in fixed chunks and never holds it.
 */
const TAIL_KEEP = 20_000;
const TAIL_BYTES = 32 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;

/** Newline bytes in [0, size) — the persisted message count — read in fixed chunks. */
function countLines(file: string, size: number): number {
  if (size === 0) return 0;
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, size));
    let count = 0;
    let pos = 0;
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) if (buf[i] === 0x0a) count += 1;
      pos += n;
    }
    // A last line without its newline is still a line.
    return count;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse the complete lines in [start, end). Returns how many bytes were
 * consumed — up to the last newline, so a line another writer is still
 * appending is left for the next read rather than parsed in half.
 */
function readLines(
  file: string,
  start: number,
  end: number,
  dropFirstPartial: boolean,
): { messages: TrackerMessage[]; lines: number; consumed: number } {
  const messages: TrackerMessage[] = [];
  let lines = 0;
  if (end <= start) return { messages, lines, consumed: 0 };
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, end - start));
    const decoder = new StringDecoder("utf8");
    let carry = "";
    let pos = start;
    let consumed = 0;
    let first = dropFirstPartial;
    while (pos < end) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + decoder.write(buf.subarray(0, n));
      const parts = text.split("\n");
      carry = parts.pop() ?? "";
      for (const part of parts) {
        if (first) {
          // Started mid-line: the fragment before the first newline is not a message.
          first = false;
          continue;
        }
        lines += 1;
        const line = part.trim();
        if (!line) continue;
        try {
          messages.push(JSON.parse(line) as TrackerMessage);
        } catch {
          /* skip corrupt line */
        }
      }
      // Everything up to and including the last newline seen so far.
      consumed = pos - start - Buffer.byteLength(carry, "utf8");
    }
    return { messages, lines, consumed };
  } finally {
    fs.closeSync(fd);
  }
}

export class TrackerStore {
  constructor(private readonly dir: string = resolveTrackerDataDir()) {}

  /** Newest messages last; null until first touched. */
  private tail: TrackerMessage[] | null = null;
  /** Bytes of the log already folded into `tail`. */
  private tailOffset = 0;
  /** Lines in the whole log, including everything older than the tail. */
  private lineCount = 0;

  private messagesFile(): string {
    return path.join(this.dir, "messages.jsonl");
  }

  /** Bring the in-memory tail up to date with the file, reading only what is new. */
  private syncTail(): TrackerMessage[] {
    const file = this.messagesFile();
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      this.tail = [];
      this.tailOffset = 0;
      this.lineCount = 0;
      return this.tail;
    }
    if (this.tail && size === this.tailOffset) return this.tail;

    if (!this.tail || size < this.tailOffset) {
      // First touch, or the file was rewritten under us: rebuild from the end.
      this.lineCount = countLines(file, size);
      const start = Math.max(0, size - TAIL_BYTES);
      const { messages, consumed } = readLines(file, start, size, start > 0);
      this.tail = messages.length > TAIL_KEEP ? messages.slice(-TAIL_KEEP) : messages;
      this.tailOffset = start + consumed;
      return this.tail;
    }

    // Grew: fold in the appended bytes only.
    const { messages, lines, consumed } = readLines(file, this.tailOffset, size, false);
    this.lineCount += lines;
    this.tailOffset += consumed;
    if (messages.length > 0) {
      this.tail.push(...messages);
      if (this.tail.length > TAIL_KEEP) this.tail.splice(0, this.tail.length - TAIL_KEEP);
    }
    return this.tail;
  }

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
    const file = this.messagesFile();
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, `${JSON.stringify(message)}\n`, "utf8");
    // The next read folds the new line in from the file, same as it would
    // for a line another store instance wrote.
  }

  /**
   * Total persisted messages + the newest timestamp, so a restarted engine's
   * "emitted" counter agrees with the stream it shows (the counter was
   * previously in-memory only and read 0 after every restart).
   */
  messageStats(): { count: number; lastAt: string | null } {
    const tail = this.syncTail();
    return { count: this.lineCount, lastAt: tail[tail.length - 1]?.timestamp ?? null };
  }

  /**
   * Most recent messages, newest first — from the in-memory tail, so at most
   * the newest TAIL_KEEP across all tickers. A ticker whose last message is
   * older than that reads as quiet, which is the honest answer at that depth.
   */
  readMessages(options?: { limit?: number; ticker?: string }): TrackerMessage[] {
    const tail = this.syncTail();
    const limit = options?.limit ?? 200;
    const ticker = options?.ticker?.toUpperCase();
    const out: TrackerMessage[] = [];
    for (let i = tail.length - 1; i >= 0 && out.length < limit; i--) {
      const msg = tail[i];
      if (ticker && msg.ticker !== ticker) continue;
      out.push(msg);
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
