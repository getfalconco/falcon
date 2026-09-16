/**
 * Quant Lab persistence — plain JSON under `apps/desktop/data/quantlab/`
 * (override with `FALCON_QUANTLAB_DATA_DIR`):
 *
 *   config.json          every §11 knob, written with the defaults on first run
 *   series/<TICKER>.json the backfilled point-in-time series (regenerable, gitignored)
 *   strategies.json      every version of every strategy — nothing is edited in place
 *   results/<id>.json    one backtest report each
 *   ledger.jsonl         the live signal ledger, append-only
 *
 * Strategies are the audit trail: §5 requires every edit to create a new
 * version with a `parent_version` link, because the number of versions IS the
 * record of how much searching happened, and that is what the variant counter
 * reads. So this store appends versions and never mutates one.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveDesktopDataDir } from "../tracker/store.js";
import { DEFAULT_QUANTLAB_CONFIG, mergeQuantLabConfig, type QuantLabConfig } from "./config.js";
import type { BacktestReport, LiveSignal, QuantSeries, Strategy } from "./types.js";

export function resolveQuantLabDataDir(): string {
  const fromEnv = process.env.FALCON_QUANTLAB_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(resolveDesktopDataDir(), "quantlab");
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
  // On Windows a virus scanner or the search indexer can hold a freshly written
  // file open for a few milliseconds, and rename then throws EPERM/EBUSY. The
  // files here are large enough to be scanned, so a bare rename loses a whole
  // backtest to a transient lock.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      sleepBriefly(15 * (attempt + 1));
    }
  }
}

/** Synchronous pause — the store's callers are all synchronous. */
function sleepBriefly(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export class QuantLabConfigStore {
  constructor(private readonly dir: string = resolveQuantLabDataDir()) {}

  get dataDir(): string {
    return this.dir;
  }
  get configFile(): string {
    return path.join(this.dir, "config.json");
  }

  /** Reads config.json, writing the defaults out on first run. */
  load(): QuantLabConfig {
    const stored = readJson<Partial<QuantLabConfig>>(this.configFile);
    if (!stored) {
      writeJsonAtomic(this.configFile, DEFAULT_QUANTLAB_CONFIG);
      return mergeQuantLabConfig(null);
    }
    return mergeQuantLabConfig(stored);
  }

  save(config: QuantLabConfig): void {
    writeJsonAtomic(this.configFile, config);
  }
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

const TICKER_FILE_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export class SeriesStore {
  constructor(private readonly dir: string = resolveQuantLabDataDir()) {}

  get seriesDir(): string {
    return path.join(this.dir, "series");
  }

  private fileFor(ticker: string): string {
    const upper = ticker.trim().toUpperCase();
    // Ticker strings become filenames — refuse anything that could traverse.
    if (!TICKER_FILE_RE.test(upper)) throw new Error(`unsafe ticker for a filename: ${ticker}`);
    return path.join(this.seriesDir, `${upper}.json`);
  }

  list(): string[] {
    try {
      return fs
        .readdirSync(this.seriesDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5).toUpperCase())
        .sort();
    } catch {
      return [];
    }
  }

  load(ticker: string): QuantSeries | null {
    const parsed = readJson<QuantSeries>(this.fileFor(ticker));
    if (!parsed || !Array.isArray(parsed.snapshots)) return null;
    return parsed;
  }

  save(series: QuantSeries): void {
    writeJsonAtomic(this.fileFor(series.ticker), series);
  }

  /** Last covered session per ticker, for the status panel. */
  coverage(): Array<{ ticker: string; sessions: number; from: string | null; to: string | null }> {
    return this.list().map((ticker) => {
      const series = this.load(ticker);
      const snaps = series?.snapshots ?? [];
      return {
        ticker,
        sessions: snaps.length,
        from: snaps[0]?.d ?? null,
        to: snaps[snaps.length - 1]?.d ?? null,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Strategies (append-only version history)
// ---------------------------------------------------------------------------

type StrategyFile = { schema_version: number; strategies: Strategy[] };

export class StrategyStore {
  private cache: StrategyFile | null = null;

  constructor(private readonly dir: string = resolveQuantLabDataDir()) {}

  get file(): string {
    return path.join(this.dir, "strategies.json");
  }

  /** A second writer may have touched the file. */
  reload(): void {
    this.cache = null;
  }

  private read(): StrategyFile {
    if (this.cache) return this.cache;
    const parsed = readJson<StrategyFile>(this.file);
    const strategies = Array.isArray(parsed?.strategies) ? parsed!.strategies.filter(isStrategy) : [];
    this.cache = { schema_version: 1, strategies };
    return this.cache;
  }

  /** Every version of every strategy, oldest first. */
  all(): Strategy[] {
    return [...this.read().strategies];
  }

  /** All versions of one strategy family, ascending. */
  versions(strategyId: string): Strategy[] {
    return this.read()
      .strategies.filter((s) => s.strategy_id === strategyId)
      .sort((a, b) => a.version - b.version);
  }

  /** The newest version of one family. */
  latest(strategyId: string): Strategy | null {
    const versions = this.versions(strategyId);
    return versions[versions.length - 1] ?? null;
  }

  get(strategyId: string, version: number): Strategy | null {
    return this.read().strategies.find((s) => s.strategy_id === strategyId && s.version === version) ?? null;
  }

  /** The newest version of each family, for the builder's sidebar. */
  heads(): Strategy[] {
    const byId = new Map<string, Strategy>();
    for (const s of this.read().strategies) {
      const seen = byId.get(s.strategy_id);
      if (!seen || s.version > seen.version) byId.set(s.strategy_id, s);
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Appends a version. Refuses to overwrite an existing (id, version) — the
   * version history is an audit trail, so a collision is a bug, not a save.
   */
  append(strategy: Strategy): void {
    const state = this.read();
    if (state.strategies.some((s) => s.strategy_id === strategy.strategy_id && s.version === strategy.version)) {
      throw new Error(`${strategy.strategy_id} v${strategy.version} already exists — versions are immutable`);
    }
    state.strategies.push(strategy);
    this.cache = state;
    writeJsonAtomic(this.file, state);
  }

  /**
   * The live-enable toggle is the ONE mutable field (§8): flipping it is not an
   * edit to the rule, so it must not mint a version and inflate the variant
   * counter. Every other change goes through `append`.
   */
  setLiveEnabled(strategyId: string, version: number, enabled: boolean): void {
    const state = this.read();
    const found = state.strategies.find((s) => s.strategy_id === strategyId && s.version === version);
    if (!found) throw new Error(`${strategyId} v${version} not found`);
    found.live_enabled = enabled;
    this.cache = state;
    writeJsonAtomic(this.file, state);
  }
}

function isStrategy(value: unknown): value is Strategy {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<Strategy>;
  return (
    typeof s.strategy_id === "string" &&
    typeof s.version === "number" &&
    typeof s.name === "string" &&
    typeof s.trigger === "object" &&
    Array.isArray(s.filters)
  );
}

// ---------------------------------------------------------------------------
// Backtest results
// ---------------------------------------------------------------------------

const REPORT_ID_RE = /^[A-Za-z0-9_.\-]{1,120}$/;

/**
 * Backtest results are stored in two pieces:
 *
 *   index.json          every report MINUS its signals — small, committed
 *   <report_id>.json    the full report including every signal — large, local
 *
 * The split exists because the variant counter reads this store on every run,
 * and a strategy firing five thousand times produces a four-megabyte report.
 * Parsing all of them to answer "how many runs has this family had" would get
 * slower with every run, and committing them would put tens of megabytes of
 * regenerable data in git. The index keeps the variant history — which is a
 * guard, and must survive a clone — while the bulk stays on the machine that
 * produced it.
 */
type ResultIndex = { schema_version: number; reports: BacktestReport[] };

export class ResultStore {
  constructor(private readonly dir: string = resolveQuantLabDataDir()) {}

  get resultsDir(): string {
    return path.join(this.dir, "results");
  }

  get indexFile(): string {
    return path.join(this.resultsDir, "index.json");
  }

  private fileFor(reportId: string): string {
    if (!REPORT_ID_RE.test(reportId)) throw new Error(`unsafe report id: ${reportId}`);
    return path.join(this.resultsDir, `${reportId}.json`);
  }

  private readIndex(): ResultIndex {
    const parsed = readJson<ResultIndex>(this.indexFile);
    const reports = Array.isArray(parsed?.reports) ? parsed!.reports.filter((r) => r?.report_id) : [];
    return { schema_version: 1, reports };
  }

  save(report: BacktestReport): void {
    writeJsonAtomic(this.fileFor(report.report_id), report);
    const index = this.readIndex();
    const summary = { ...report, signals: [] };
    const at = index.reports.findIndex((r) => r.report_id === report.report_id);
    if (at >= 0) index.reports[at] = summary;
    else index.reports.push(summary);
    index.reports.sort((a, b) => b.created_at.localeCompare(a.created_at));
    writeJsonAtomic(this.indexFile, index);
  }

  /** The full report, signals included. */
  load(reportId: string): BacktestReport | null {
    return readJson<BacktestReport>(this.fileFor(reportId));
  }

  /** Every report WITHOUT its signals — what the panel and the guards read. */
  list(): BacktestReport[] {
    return this.readIndex().reports;
  }

  /** Reports for one family, newest first — the variant history. */
  forStrategy(strategyId: string): BacktestReport[] {
    return this.list().filter((r) => r.strategy_id === strategyId);
  }

  /**
   * How many backtests this family has run, INCLUDING the one about to be
   * written. §7: selection across many variants inflates apparent performance,
   * so the count is shown on every report.
   */
  nextVariantNumber(strategyId: string): number {
    return this.forStrategy(strategyId).length + 1;
  }

  /**
   * Whether an out-of-sample result for this family has ever been viewed. A
   * version created after that is flagged (§7) — this does not block anything;
   * making the practice visible is the point.
   */
  hasOosResult(strategyId: string): boolean {
    return this.forStrategy(strategyId).some((r) => r.out_of_sample.horizons.some((h) => h.n > 0));
  }

  /**
   * Drops full reports past the retention window but KEEPS their index entries:
   * the variant count is the record of how much searching happened, and
   * forgetting old runs would quietly reset the guard.
   */
  prune(retentionDays: number, nowMs: number): number {
    const cutoff = new Date(nowMs - retentionDays * 86_400_000).toISOString();
    let removed = 0;
    for (const report of this.list()) {
      if (report.created_at >= cutoff) continue;
      try {
        fs.unlinkSync(this.fileFor(report.report_id));
        removed++;
      } catch {
        /* already gone */
      }
    }
    return removed;
  }
}

// ---------------------------------------------------------------------------
// Live ledger (append-only)
// ---------------------------------------------------------------------------

export class LedgerStore {
  constructor(private readonly dir: string = resolveQuantLabDataDir()) {}

  get file(): string {
    return path.join(this.dir, "ledger.jsonl");
  }

  read(): LiveSignal[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    // Last write wins per id, so a forward-return fill supersedes the original
    // line without the file ever being rewritten.
    const byId = new Map<string, LiveSignal>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as LiveSignal;
        if (parsed?.id) byId.set(parsed.id, parsed);
      } catch {
        /* torn line — skip it, the rest of the ledger is still readable */
      }
    }
    return [...byId.values()].sort((a, b) => a.session.localeCompare(b.session) || a.id.localeCompare(b.id));
  }

  /** Appends signals. Ids are deterministic, so re-running a session is idempotent. */
  append(signals: LiveSignal[]): void {
    if (signals.length === 0) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, signals.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
  }

  /** Rewrites the file from the current state — used after a forward-return sweep. */
  compact(signals: LiveSignal[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, signals.map((s) => JSON.stringify(s)).join("\n") + (signals.length ? "\n" : ""), "utf8");
    fs.renameSync(tmp, this.file);
  }
}
