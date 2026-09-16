/**
 * Propagation persistence (§9, §11): the run store keyed by run id (one run
 * per request), the attempt ledger for failed stage-2 requests, the metrics
 * snapshot and the config file. Runs persist 90d; superseded runs are kept
 * and marked. Same shape as the Analyst's store — nothing invented.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveDesktopDataDir } from "../../tracker/store.js";
import { DEFAULT_PROPAGATION_CONFIG, mergePropagationConfig, type PropagationConfig } from "./config.js";
import type { PropagationMetrics, PropagationRun } from "./types.js";

export function resolvePropagationDataDir(): string {
  const fromEnv = process.env.FALCON_PROPAGATION_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(resolveDesktopDataDir(), "propagation");
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

export function emptyPropagationMetrics(): PropagationMetrics {
  return {
    runs_ok: 0,
    runs_stage1_only: 0,
    fast_path_runs: 0,
    cycle_runs: 0,
    fast_path_missed: 0,
    fast_path_latencies_ms: [],
    cycle_latencies_ms: [],
    runs_failed: 0,
    targets_total: 0,
    open_total: 0,
    partial_total: 0,
    priced_total: 0,
    contradicted_total: 0,
    untracked_total: 0,
    no_edge_runs: 0,
    vetoes: 0,
    unclear_resolved: 0,
    unclear_total: 0,
    added_target_rejections: 0,
    validation_failures: 0,
    transport_failures: 0,
    retries: 0,
    breaker_trips: 0,
    superseded: 0,
    cache_hits: 0,
    latencies_ms: [],
    input_tokens: 0,
    output_tokens: 0,
    by_cell: {},
  };
}

export type AttemptRecord = {
  request_id: string;
  incident_id: string;
  attempts: number;
  last_error: string | null;
  last_attempt_at: string;
  permanent_failed: boolean;
};

type RunsFile = { schema_version: 1; runs: Record<string, PropagationRun> };
type AttemptsFile = { schema_version: 1; attempts: Record<string, AttemptRecord> };
type MetricsFile = { schema_version: 1; metrics: PropagationMetrics };

export interface PropagationBackend {
  readRuns(): Record<string, PropagationRun>;
  writeRuns(r: Record<string, PropagationRun>): void;
  readAttempts(): Record<string, AttemptRecord>;
  writeAttempts(a: Record<string, AttemptRecord>): void;
  readMetrics(): PropagationMetrics | null;
  writeMetrics(m: PropagationMetrics): void;
}

export class MemoryBackend implements PropagationBackend {
  private runs: Record<string, PropagationRun> = {};
  private attempts: Record<string, AttemptRecord> = {};
  private metrics: PropagationMetrics | null = null;
  readRuns() {
    return structuredClone(this.runs);
  }
  writeRuns(r: Record<string, PropagationRun>) {
    this.runs = structuredClone(r);
  }
  readAttempts() {
    return structuredClone(this.attempts);
  }
  writeAttempts(a: Record<string, AttemptRecord>) {
    this.attempts = structuredClone(a);
  }
  readMetrics() {
    return this.metrics ? structuredClone(this.metrics) : null;
  }
  writeMetrics(m: PropagationMetrics) {
    this.metrics = structuredClone(m);
  }
}

/** Minimal shape check so a corrupt row cannot crash the store at load. */
export function coerceStoredRun(raw: unknown): PropagationRun | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<PropagationRun>;
  if (typeof r.run_id !== "string" || typeof r.incident_id !== "string" || typeof r.request_id !== "string") return null;
  if (typeof r.root_ticker !== "string" || !r.event || !Array.isArray(r.targets) || !r.summary) return null;
  if (typeof r.produced_at !== "string") return null;
  return {
    ...(r as PropagationRun),
    superseded_by: typeof r.superseded_by === "string" ? r.superseded_by : null,
    update_of: typeof r.update_of === "string" ? r.update_of : null,
    stage2: r.stage2 ?? null,
    failure_reason: typeof r.failure_reason === "string" ? r.failure_reason : null,
    synthetic: r.synthetic === true,
  };
}

export class FileBackend implements PropagationBackend {
  constructor(readonly dir: string = resolvePropagationDataDir()) {}
  get runsFile() {
    return path.join(this.dir, "runs.json");
  }
  get attemptsFile() {
    return path.join(this.dir, "attempts.json");
  }
  get metricsFile() {
    return path.join(this.dir, "metrics.json");
  }
  readRuns() {
    const parsed = readJson<RunsFile>(this.runsFile);
    const out: Record<string, PropagationRun> = {};
    if (parsed?.runs && typeof parsed.runs === "object") {
      for (const [key, raw] of Object.entries(parsed.runs)) {
        const run = coerceStoredRun(raw);
        if (run) out[key] = run;
      }
    }
    return out;
  }
  writeRuns(runs: Record<string, PropagationRun>) {
    writeJsonAtomic(this.runsFile, { schema_version: 1, runs } satisfies RunsFile);
  }
  readAttempts() {
    return readJson<AttemptsFile>(this.attemptsFile)?.attempts ?? {};
  }
  writeAttempts(attempts: Record<string, AttemptRecord>) {
    writeJsonAtomic(this.attemptsFile, { schema_version: 1, attempts } satisfies AttemptsFile);
  }
  readMetrics() {
    return readJson<MetricsFile>(this.metricsFile)?.metrics ?? null;
  }
  writeMetrics(metrics: PropagationMetrics) {
    writeJsonAtomic(this.metricsFile, { schema_version: 1, metrics } satisfies MetricsFile);
  }
}

export type RunListOptions = {
  limit?: number;
  status?: PropagationRun["status"];
  ticker?: string;
  /** Exclude superseded runs. */
  currentOnly?: boolean;
  /** Only runs with at least one open target. */
  openOnly?: boolean;
  /**
   * Fixture / synthetic runs: excluded by default (the live list shows only
   * the real stream), `only` for the fixtures section, `all` for both.
   */
  synthetic?: "exclude" | "only" | "all";
};

/** The run store (§9). Owned by Propagation. */
export class PropagationRunStore {
  private runs: Record<string, PropagationRun>;
  private attempts: Record<string, AttemptRecord>;
  private metrics: PropagationMetrics;

  constructor(private readonly backend: PropagationBackend = new MemoryBackend()) {
    this.runs = backend.readRuns();
    this.attempts = backend.readAttempts();
    this.metrics = { ...emptyPropagationMetrics(), ...(backend.readMetrics() ?? {}) };
  }

  /** Re-read from the backend (a replay script can be a second writer). */
  reload(): void {
    this.runs = this.backend.readRuns();
    this.attempts = this.backend.readAttempts();
    this.metrics = { ...emptyPropagationMetrics(), ...(this.backend.readMetrics() ?? {}) };
  }

  get(runId: string): PropagationRun | null {
    return this.runs[runId] ?? null;
  }

  byRequest(requestId: string): PropagationRun | null {
    for (const r of Object.values(this.runs)) if (r.request_id === requestId) return r;
    return null;
  }

  /** Newest run for an incident; a current one beats a superseded one at the same instant. */
  latestFor(incidentId: string): PropagationRun | null {
    let best: PropagationRun | null = null;
    for (const r of Object.values(this.runs)) {
      if (r.incident_id !== incidentId) continue;
      if (!best) {
        best = r;
        continue;
      }
      if (r.produced_at !== best.produced_at) {
        if (r.produced_at > best.produced_at) best = r;
        continue;
      }
      const rCurrent = r.superseded_by === null;
      const bCurrent = best.superseded_by === null;
      if (rCurrent !== bCurrent) {
        if (rCurrent) best = r;
        continue;
      }
      if (r.run_id > best.run_id) best = r;
    }
    return best;
  }

  forIncident(incidentId: string): PropagationRun[] {
    return Object.values(this.runs)
      .filter((r) => r.incident_id === incidentId)
      .sort((a, b) => a.produced_at.localeCompare(b.produced_at) || a.run_id.localeCompare(b.run_id));
  }

  put(run: PropagationRun): void {
    this.runs[run.run_id] = run;
    this.backend.writeRuns(this.runs);
  }

  /**
   * Fold in runs produced elsewhere (another install, via the server mirror).
   * A run already here is left alone unless the incoming copy knows something
   * this one doesn't — that it has since been superseded. Supersession only
   * ever moves one way, so the merge can't flip a run back to current.
   * Returns the ids that were actually new or changed.
   */
  merge(incoming: PropagationRun[]): string[] {
    const changed: string[] = [];
    for (const run of incoming) {
      if (!run || typeof run.run_id !== "string" || !run.run_id) continue;
      const existing = this.runs[run.run_id];
      if (!existing) {
        this.runs[run.run_id] = run;
        changed.push(run.run_id);
      } else if (existing.superseded_by == null && run.superseded_by != null) {
        existing.superseded_by = run.superseded_by;
        changed.push(run.run_id);
      }
    }
    if (changed.length) this.backend.writeRuns(this.runs);
    return changed;
  }

  /** §2 supersession: mark every other current run of the incident as replaced by `byRunId`. */
  markSuperseded(incidentId: string, byRunId: string): string[] {
    const marked: string[] = [];
    for (const r of Object.values(this.runs)) {
      if (r.incident_id !== incidentId || r.run_id === byRunId) continue;
      if (r.superseded_by !== null) continue;
      r.superseded_by = byRunId;
      marked.push(r.run_id);
    }
    if (marked.length) this.backend.writeRuns(this.runs);
    return marked;
  }

  list(options?: RunListOptions): PropagationRun[] {
    const all = Object.values(this.runs)
      .filter((r) => !options?.status || r.status === options.status)
      .filter((r) => !options?.ticker || r.root_ticker.toUpperCase() === options.ticker.toUpperCase())
      .filter((r) => !options?.currentOnly || r.superseded_by === null)
      .filter((r) => !options?.openOnly || r.summary.open > 0)
      .filter((r) => {
        const mode = options?.synthetic ?? "exclude";
        if (mode === "all") return true;
        return mode === "only" ? r.synthetic : !r.synthetic;
      })
      .sort((a, b) => (a.produced_at < b.produced_at ? 1 : a.produced_at > b.produced_at ? -1 : 0));
    return options?.limit ? all.slice(0, options.limit) : all;
  }

  prune(now: string, retentionDays: number): number {
    let removed = 0;
    for (const [key, r] of Object.entries(this.runs)) {
      if (isExpired(r, now, retentionDays)) {
        delete this.runs[key];
        removed += 1;
      }
    }
    if (removed) this.backend.writeRuns(this.runs);
    return removed;
  }

  size(): number {
    return Object.keys(this.runs).length;
  }

  // --- attempts --------------------------------------------------------------

  attemptsFor(requestId: string): AttemptRecord | null {
    return this.attempts[requestId] ?? null;
  }

  recordAttempt(requestId: string, incidentId: string, error: string | null, at: string, maxAttempts: number): AttemptRecord {
    const prior = this.attempts[requestId];
    const attempts = (prior?.attempts ?? 0) + 1;
    const record: AttemptRecord = {
      request_id: requestId,
      incident_id: incidentId,
      attempts,
      last_error: error,
      last_attempt_at: at,
      permanent_failed: error !== null && attempts >= maxAttempts,
    };
    if (error === null) delete this.attempts[requestId];
    else this.attempts[requestId] = record;
    this.backend.writeAttempts(this.attempts);
    return record;
  }

  permanentFailures(): AttemptRecord[] {
    return Object.values(this.attempts).filter((a) => a.permanent_failed);
  }

  // --- metrics -----------------------------------------------------------------

  getMetrics(): PropagationMetrics {
    return structuredClone(this.metrics);
  }

  updateMetrics(fn: (m: PropagationMetrics) => void): void {
    fn(this.metrics);
    this.backend.writeMetrics(this.metrics);
  }

  resetMetrics(): void {
    this.metrics = emptyPropagationMetrics();
    this.backend.writeMetrics(this.metrics);
  }
}

export function isExpired(run: PropagationRun, now: string, retentionDays: number): boolean {
  const age = Date.parse(now) - Date.parse(run.produced_at);
  return Number.isFinite(age) && age > retentionDays * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

export class PropagationConfigStore {
  constructor(private readonly dir: string = resolvePropagationDataDir()) {}

  get dataDir(): string {
    return this.dir;
  }

  get configFile(): string {
    return path.join(this.dir, "config.json");
  }

  /** Reads config.json, writing the defaults out on first run. */
  load(): PropagationConfig {
    const stored = readJson<Partial<PropagationConfig>>(this.configFile);
    if (!stored) {
      writeJsonAtomic(this.configFile, DEFAULT_PROPAGATION_CONFIG);
      return mergePropagationConfig(null);
    }
    // One-time graduation (v2): surfacing shipped as a Phase B gate, default
    // off, and every install's stored config froze that default. A pre-v2
    // file's surfacing value is the old default, not a choice — drop it so
    // the new default applies; anything saved after this carries version 2
    // and is honoured as the user's own setting.
    if ((stored.configVersion ?? 1) < 2) {
      delete stored.propagationSurfacingEnabled;
      const migrated = mergePropagationConfig(stored);
      writeJsonAtomic(this.configFile, migrated);
      return migrated;
    }
    return mergePropagationConfig(stored);
  }

  save(config: PropagationConfig): void {
    writeJsonAtomic(this.configFile, config);
  }
}

export function loadPropagationConfig(dir?: string): PropagationConfig {
  return new PropagationConfigStore(dir).load();
}
